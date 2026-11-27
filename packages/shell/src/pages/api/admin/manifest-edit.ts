import type { APIRoute } from 'astro';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyManifestOverlay, closestName, closestPermission, editManifestOverlay, isKnownPermission, listToolchainBinaries, namedTools,
  readAliasMap, readManifestOverlay, releasePaths, toolchainMirrorBin, toolsGrant, writeManifestOverlay, type ManifestOverlay, type OverlayEdit,
} from '@aura/core';
import { liveCapabilityDeps, resolveRegistry } from '../../../lib/capabilities.ts';
import { auditOwner, manifestEditLevel, ownerAction } from '../../../lib/approvals/admin.ts';

/**
 * An app's grants (tools[], services[].tools, permissions[]): `aura cap
 * grant/revoke`, `aura grant/revoke perms`, Settings. Routed through the shell
 * so it works from anywhere (terminal sandboxes, sibling containers, the host).
 *
 * Phase 6 O (settings overlay): the edit is written as add/remove ops to the
 * app's overlay `/data/aura/overlay/apps/<appId>.json` (core
 * manifestOverlay.ts), never into `app.manifest.json`: installed trees and
 * the release stay untouched, in every scope. The registry applies the
 * overlay when it loads the manifest; this route reloads the app and
 * refreshes its running instances' /aura/my-tools (no respawn). Whether an
 * edit changes anything is decided on the EFFECTIVE manifest (installed +
 * overlay). The installed manifest is resolved via `AppRegistry.getAppDir`
 * (every scope).
 *
 * THE OWNER'S (D50): it changes what an app may do (permissions[], tools[],
 * services[].tools). The owner and the host operator edit directly; the CLI
 * in the System Terminal (and Settings) gets 202 needs-approval and sends
 * the same edit again with the owner's approval (lib/approvals/admin.ts).
 * Adding Docker or every tool, or a privileged permission, needs the
 * password (`fresh`); any other edit one click. Every change is audited with
 * the owner (or the operator) who decided. Declaring a privileged
 * permission here (notifications.locked / popup) only REQUESTS it — the grant
 * is separate (POST /api/admin/grants).
 *
 * A system app's permissions are edited the same way (in its overlay; the
 * release stays read-only), at the same levels as any app's (D9).
 */

const APP_ID_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;

type Action = 'add-tool' | 'remove-tool' | 'set-tools' | 'add-permission' | 'remove-permission'
  | 'add-service-tool' | 'remove-service-tool';

interface Body {
  appId?: string;
  action?: Action;
  /** For add-tool / remove-tool. */
  tool?: string;
  /** For set-tools: the full replacement tools[] (may include markers '*'/'#'). */
  tools?: string[];
  /** For add-permission / remove-permission. */
  permission?: string;
  /** For add-service-tool / remove-service-tool: the services[] template name. */
  service?: string;
}

const PERMISSION_ACTIONS = new Set<Action>(['add-permission', 'remove-permission']);
/** How the owner's dialog names an edit. */
function editTitle(e: { appId: string; action: Action; tool?: string; tools?: string[]; permission?: string; service?: string }): string {
  switch (e.action) {
    case 'add-tool': return `Give ${e.appId} the tool ${e.tool}`;
    case 'remove-tool': return `Take the tool ${e.tool} from ${e.appId}`;
    case 'set-tools': return `Set the tools of ${e.appId} to ${(e.tools ?? []).join(', ') || 'none'}`;
    case 'add-permission': return `Add the permission ${e.permission} to ${e.appId}`;
    case 'remove-permission': return `Remove the permission ${e.permission} from ${e.appId}`;
    case 'add-service-tool': return `Give the ${e.service} sidecars of ${e.appId} the tool ${e.tool}`;
    case 'remove-service-tool': return `Take the tool ${e.tool} from the ${e.service} sidecars of ${e.appId}`;
  }
}
const SERVICE_ACTIONS = new Set<Action>(['add-service-tool', 'remove-service-tool']);

export const POST: APIRoute = async (ctx) => {
  let body: Body;
  try { body = await ctx.request.json() as Body; }
  catch { return json({ error: 'invalid-json' }, 400); }

  const { appId, action, tool } = body;
  if (typeof appId !== 'string' || !APP_ID_RE.test(appId)) {
    return json({ error: 'invalid-app-id', category: appId ? 'invalid-input' : 'missing-input', message: `appId must be reverse-domain (got ${JSON.stringify(appId)}).`,
      missing: [{ input: 'appId', kind: 'field', expects: 'reverse-domain id, e.g. com.example.notes' }] }, 400);
  }
  const VALID: Action[] = ['add-tool', 'remove-tool', 'set-tools', 'add-permission', 'remove-permission', 'add-service-tool', 'remove-service-tool'];
  if (!action || !VALID.includes(action)) {
    return json({ error: 'invalid-action', category: action ? 'invalid-input' : 'missing-input', message: `action must be one of ${VALID.join(', ')} (got ${JSON.stringify(action)}).` }, 400);
  }
  if (PERMISSION_ACTIONS.has(action) && (typeof body.permission !== 'string' || body.permission.length === 0)) {
    return json({ error: 'invalid-permission', category: body.permission ? 'invalid-input' : 'missing-input', message: `${action} requires a non-empty \`permission\`.`,
      missing: [{ input: 'permission', kind: 'field', expects: 'a permission name, e.g. apps.mount' }] }, 400);
  }
  // Validate the payload shape per action.
  let setTools: string[] | null = null;
  if (SERVICE_ACTIONS.has(action) && (typeof body.service !== 'string' || body.service.length === 0)) {
    return json({ error: 'invalid-service', category: body.service ? 'invalid-input' : 'missing-input', message: `${action} requires the services[] template name as \`service\`.`,
      missing: [{ input: 'service', kind: 'field', expects: 'the name of a services[] template' }] }, 400);
  }
  if (PERMISSION_ACTIONS.has(action)) {
    // no tools payload to validate
  } else if (action === 'set-tools') {
    if (!Array.isArray(body.tools) || body.tools.some((t) => typeof t !== 'string' || t.length === 0)) {
      return json({ error: 'invalid-tools', category: 'invalid-input', message: 'set-tools requires a non-empty-string array `tools`.' }, 400);
    }
    // De-dupe while preserving order (markers '*'/'#' are valid entries).
    setTools = [...new Set(body.tools)];
  } else if (typeof tool !== 'string' || tool.length === 0) {
    return json({ error: 'invalid-tool', category: tool ? 'invalid-input' : 'missing-input', message: `${action} requires a non-empty \`tool\`.`,
      missing: [{ input: 'tool', kind: 'field', expects: 'a capability name, e.g. git' }] }, 400);
  }

  // Resolve the manifest across every scope via the registry, not a hardcoded
  // system dir — otherwise user/global-scoped apps 404.
  const { getAppManager } = await import('@aura/core');
  const mgr = getAppManager();
  const path = join(mgr.registry.getAppDir(appId), 'app.manifest.json');
  if (!existsSync(path)) {
    // The host path is internal (D105 Pass B, review row 33): the app is named, not where it lives.
    return json({ error: 'manifest-not-found', target: appId, appId, message: `${appId} has no app.manifest.json where it is installed.` }, 404);
  }

  // The installed manifest (the base the ops are relative to), the app's overlay, and the
  // effective manifest both make (what the registry serves).
  let base: Record<string, unknown>;
  try { base = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>; }
  catch (err) { return json({ error: 'manifest-parse-failed', message: `${appId}'s app.manifest.json is not valid JSON: ${(err as Error).message}` }, 500); }
  const overlayApps = releasePaths.layout(mgr.getDataDir()).overlayApps;
  let overlay: ManifestOverlay | null;
  try { overlay = readManifestOverlay(overlayApps, appId); }
  catch (err) { return json({ error: 'overlay-invalid', message: `${appId}'s settings overlay is invalid (${(err as Error).message.replace(/^.*: /, '')}): fix or remove it; the app is refused until then.` }, 500); }
  const manifest = applyManifestOverlay(base, overlay);

  // D105 Pass B (review row 21): a tool the capability registry does not know is refused before the owner is asked.
  // Only names this edit adds: a set-tools that keeps an old, since removed tool stays possible.
  const had = Array.isArray(manifest['tools']) ? manifest['tools'] as string[] : [];
  const adds = action === 'set-tools' ? (setTools ?? []).filter((t) => !had.includes(t))
    : action === 'add-tool' || action === 'add-service-tool' ? [tool ?? ''] : [];
  const unknownTool = await unknownCapability(adds, mgr.getDataDir());
  if (unknownTool) return json(unknownTool, 404);

  // The owner decides this exact edit (D50).
  const edit: { appId: string; action: Action; tool?: string; tools?: string[]; permission?: string; service?: string } = {
    appId, action,
    ...(PERMISSION_ACTIONS.has(action) ? { permission: body.permission! } : {}),
    ...(SERVICE_ACTIONS.has(action) ? { service: body.service! } : {}),
    ...(setTools ? { tools: setTools } : !PERMISSION_ACTIONS.has(action) ? { tool: tool! } : {}),
  };
  const admin = await ownerAction(ctx, {
    action: 'admin.manifest-edit', level: manifestEditLevel(edit), payload: edit,
    title: editTitle(edit),
    details: [
      `App: ${appId} (${mgr.registry.getScopeId(appId) ?? 'unknown'} scope)`,
      ...(edit.service ? [`Sidecar template: ${edit.service}`] : []),
      ...(edit.tools ?? (edit.tool ? [edit.tool] : [])).includes('docker') ? ['Warning: docker controls the container runtime, which is root on the host.'] : [],
      ...(edit.tools ?? (edit.tool ? [edit.tool] : [])).includes('*') ? ['Warning: * grants every tool AuraOS can provide.'] : [],
    ],
  });
  if (admin instanceof Response) return admin;

  // ─── permissions ────────────────────────────────────────────────────────
  // Separate from tools: permissions gate API calls, not binaries, so there's
  // no allowlist dir to re-provision. The registry reload is the whole point —
  // `PermissionManager` reads `manifest.permissions` out of the in-memory
  // registry, so without it a granted permission wouldn't take effect until
  // the shell restarted.
  if (PERMISSION_ACTIONS.has(action)) {
    const perm = body.permission!;
    const r = editManifestOverlay(overlay, base, { action: action as 'add-permission' | 'remove-permission', permission: perm });
    const changed = r.changed;
    const next = listOf(applyManifestOverlay(base, r.overlay)['permissions']);

    // Unknown names are allowed through (PermissionSchema is a free-form
    // string and apps may define their own) but flagged, since a typo would
    // otherwise silently grant nothing.
    const unknown = action === 'add-permission' && !isKnownPermission(perm);
    const suggest = unknown ? closestPermission(perm) : null;

    if (changed) {
      const failed = saveOverlay(overlayApps, appId, r.overlay);
      if (failed) return failed;
      await auditOwner(admin, `manifest.${action}`, { target: `app:${appId}`, detail: { permission: perm, overlay: true } });
    }

    // Reload even on a no-op. The in-memory registry can drift from disk (a
    // manifest or overlay edited outside the OS), and in that state the
    // permission LOOKS granted in the file while every request still 403s.
    // Re-reading unconditionally makes this endpoint the way to resync.
    try {
      // reloadManifest, not reloadFromDisk: the latter refreshes the manifest
      // but leaves every projection derived from it (intents, keymaps,
      // interfaces) stale until a restart.
      mgr.reloadManifest(appId);
      // sidecars.tools gates the own tool dirs of the app's OS sidecars:
      // refill (grant) or empty (revoke) the running ones now, not at their
      // next spawn.
      if (changed && perm === 'sidecars.tools') mgr.refreshInstanceTools(appId);
      // D80 (owner answer 4): losing apps.mount revokes the access: every cross-app mount its instances (and
      // their sidecars) hold, read-only and writable, with the declarations.
      if (changed && perm === 'apps.mount' && action !== 'add-permission') {
        for (const i of mgr.getInstancesByApp(appId)) mgr.mounts.revokeConsumer(i.instanceId);
      }
      return json({ ok: true, appId, action, permission: perm, changed, permissions: next, unknown, ...(suggest ? { suggest: [suggest] } : {}), reloaded: true });
    } catch (err) {
      // The file is written but the running registry still has the old value,
      // so the grant won't take effect until a restart. Say so rather than
      // reporting a success the caller can't actually use.
      return json({ ok: true, appId, action, permission: perm, changed, permissions: next, unknown, ...(suggest ? { suggest: [suggest] } : {}), reloaded: false, reloadError: (err as Error).message });
    }
  }

  // ─── tools of a services[] template (OS sidecars) ───────────────────────
  // `services[].tools`: what every sidecar of that template holds at
  // /aura/my-tools, intersected with the app's tools[] by the OS. Live:
  // refreshInstanceTools refills the own dir of every running sidecar.
  if (SERVICE_ACTIONS.has(action)) {
    const services = Array.isArray(manifest['services']) ? (manifest['services'] as Array<Record<string, unknown>>) : [];
    const svc = services.find((s) => s?.['name'] === body.service);
    if (!svc) {
      const names = services.map((s) => String(s?.['name']));
      return json({ error: 'service-not-found', message: `${appId} has no services[] template '${body.service}'${names.length ? ` — templates: ${names.join(', ')}` : ' (it declares none)'}.` }, 404);
    }
    if (action === 'add-service-tool' && svc['inheritTools'] === true) {
      return json({ error: 'inherit-tools', message: `template '${body.service}' sets inheritTools (the app's whole set) — drop it from the manifest before giving the template tools of its own.` }, 409);
    }
    // A template without `tools` gains its own list (and its sidecars their
    // own dir on their next spawn: the spec changes, so they are recreated);
    // a removal keeps the list (`tools: []` keeps the own dir, runtime grants).
    const had = Array.isArray(svc['tools']);
    const r = editManifestOverlay(overlay, base, { action: action as 'add-service-tool' | 'remove-service-tool', service: body.service!, tool: tool! });
    const changed = r.changed;
    const next = listOf((applyManifestOverlay(base, r.overlay)['services'] as Array<Record<string, unknown>>)
      .find((s) => s?.['name'] === body.service)?.['tools']);
    const appTools = listOf(manifest['tools']);
    // A tool the app lacks is kept but not provisioned — tell the caller.
    const appHolds = tool === '*' || tool === '#' || toolsGrant(appTools, tool!, {}, readAliasMap(toolchainMirrorBin(mgr.getDataDir())));
    if (changed) {
      const failed = saveOverlay(overlayApps, appId, r.overlay);
      if (failed) return failed;
      await auditOwner(admin, `manifest.${action}`, { target: `app:${appId}`, detail: { service: body.service, tool, overlay: true } });
    }
    // Editing the manifest stays an admin action, but its sidecars only get
    // own tools when the app holds sidecars.tools (spawn 403s otherwise).
    const needs = (): { needsPermission?: 'sidecars.tools' } =>
      (mgr.permissions.hasPermission(appId, 'sidecars.tools') ? {} : { needsPermission: 'sidecars.tools' });
    try {
      mgr.reloadManifest(appId);
      const refreshed = changed ? mgr.refreshInstanceTools(appId) : [];
      return json({ ok: true, appId, action, service: body.service, tool, changed, tools: next, created: !had, appHolds, refreshed, ...needs() });
    } catch (err) {
      return json({ ok: true, appId, action, service: body.service, tool, changed, tools: next, created: !had, appHolds, refreshed: [], refreshError: (err as Error).message, ...needs() });
    }
  }

  const tools = listOf(manifest['tools']);
  // Order-insensitive: a no-op reorder (set-tools) changes nothing.
  const toolEdit: OverlayEdit = action === 'set-tools' ? { action, tools: setTools! } : { action: action as 'add-tool' | 'remove-tool', tool: tool! };
  const r = editManifestOverlay(overlay, base, toolEdit);
  const changed = r.changed;
  const nextTools = changed ? listOf(applyManifestOverlay(base, r.overlay)['tools']) : tools;

  if (changed) {
    const failed = saveOverlay(overlayApps, appId, r.overlay);
    if (failed) return failed;
    await auditOwner(admin, `manifest.${action}`, { target: `app:${appId}`, detail: { ...(action === 'set-tools' ? { tools: nextTools } : { tool }), overlay: true } });

    // Hot-refresh running instances of this app so their /aura/my-tools
    // allowlist picks up the change without a backend respawn. AppManager
    // already drives this via refreshInstanceTools — same path
    // /api/admin/cap-refresh uses after `cap install`.
    try {
      // Re-read the manifest with its overlay before refreshing tools dirs:
      // nothing watches the overlay, so refreshInstanceTools would otherwise
      // use a stale in-memory tools[].
      // reloadManifest, not reloadFromDisk: the latter refreshes the manifest
      // but leaves every projection derived from it (intents, keymaps,
      // interfaces) stale until a restart.
      mgr.reloadManifest(appId);
      const refreshed = mgr.refreshInstanceTools(appId);
      return json({ ok: true, appId, action, tool, changed, tools: nextTools, refreshed });
    } catch (err) {
      // Edit succeeded; only the live refresh failed. Tell the caller so
      // they can warn the user instead of pretending it worked end-to-end.
      return json({ ok: true, appId, action, tool, changed, tools: nextTools, refreshed: [], refreshError: (err as Error).message });
    }
  }

  return json({ ok: true, appId, action, tool, changed: false, tools });
};

const listOf = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** Write the app's overlay (/data, never the installed tree); a Response when that failed (names the app, not the path). */
function saveOverlay(dir: string, appId: string, overlay: ManifestOverlay): Response | null {
  try { writeManifestOverlay(dir, appId, overlay); return null; }
  catch (err) {
    return json({ error: 'write-failed', message: `${appId}'s settings overlay could not be written (${(err as NodeJS.ErrnoException).code ?? 'error'}).` }, 500);
  }
}

/**
 * The first named tool the capability registry does not know, as the 404
 * answer (markers `*` and `#` are not tools; a capability's registry
 * aliases name its binary). Null when every name is known, or when the registry cannot be
 * read (the edit then goes on as before).
 */
async function unknownCapability(tools: string[], dataDir: string): Promise<Record<string, unknown> | null> {
  const aliases = readAliasMap(toolchainMirrorBin(dataDir));
  const named = namedTools(tools.filter(Boolean), aliases);
  if (named.length === 0) return null;
  let known: string[];
  try {
    // The registry, plus whatever the toolchain holds (a binary installed without a registry entry is grantable too).
    known = [...Object.keys(await resolveRegistry(liveCapabilityDeps())), ...listToolchainBinaries(toolchainMirrorBin(dataDir))];
  } catch { return null; }
  if (known.length === 0) return null;
  const missing = named.find((t) => !known.includes(t));
  if (!missing) return null;
  const near = closestName(missing, known);
  return {
    error: 'unknown-capability', category: 'invalid-input', capability: missing,
    message: `'${missing}' is not in the capability registry.`,
    hint: `aura cap registry show lists the capabilities${near ? `; did you mean ${near}?` : '.'}`,
    ...(near ? { suggest: [near] } : {}),
  };
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
