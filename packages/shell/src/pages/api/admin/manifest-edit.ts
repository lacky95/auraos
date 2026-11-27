import type { APIRoute } from 'astro';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_PERMISSIONS, toolsGrant } from '@aura/core';
import { auditOwner, manifestEditLevel, ownerAction } from '../../../lib/approvals/admin.ts';

/**
 * Server-side manifest mutation. Required because container-sandbox apps
 * (Terminal, etc.) get a SLICED bind of `/workspace/apps` — only their own
 * `apps/<self>/` subdir is visible. The CLI's local `addToolToManifest` /
 * `removeToolFromManifest` helpers therefore can't reach a sibling app's
 * manifest and throw "Manifest not found for com.aura.example".
 *
 * Routing the edit through the shell (which has the full `/workspace/apps`
 * bind via the project-root mount) makes `aura cap grant/revoke` work from
 * anywhere — terminal proots, sibling containers, host shell. AppRegistry's
 * chokidar watcher picks up the JSON change automatically and re-parses,
 * but we ALSO trigger the per-app /aura/my-tools refresh so the running
 * container sees the new binding within a tick (no respawn).
 *
 * The manifest path is resolved via `AppRegistry.getAppDir`, which knows each
 * app's real install directory across ALL scopes (system `/workspace/apps`,
 * global + user `/data/scopes/…/apps`). A hardcoded `/workspace/apps` only
 * covers system-scope apps and 404s on user/global installs.
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
 * A system app's permissions are part of the release and are not edited in
 * place (`aura grant/revoke perms` on one → 409 `system-scope`); changing
 * them comes with the system overlay (Phase 6). Its tools stay editable
 * (`aura cap grant`), as before.
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
    return json({ error: 'invalid-app-id', message: `appId must be reverse-domain (got ${JSON.stringify(appId)}).` }, 400);
  }
  const VALID: Action[] = ['add-tool', 'remove-tool', 'set-tools', 'add-permission', 'remove-permission', 'add-service-tool', 'remove-service-tool'];
  if (!action || !VALID.includes(action)) {
    return json({ error: 'invalid-action', message: `action must be one of ${VALID.join(', ')} (got ${JSON.stringify(action)}).` }, 400);
  }
  if (PERMISSION_ACTIONS.has(action) && (typeof body.permission !== 'string' || body.permission.length === 0)) {
    return json({ error: 'invalid-permission', message: `${action} requires a non-empty \`permission\`.` }, 400);
  }
  // Validate the payload shape per action.
  let setTools: string[] | null = null;
  if (SERVICE_ACTIONS.has(action) && (typeof body.service !== 'string' || body.service.length === 0)) {
    return json({ error: 'invalid-service', message: `${action} requires the services[] template name as \`service\`.` }, 400);
  }
  if (PERMISSION_ACTIONS.has(action)) {
    // no tools payload to validate
  } else if (action === 'set-tools') {
    if (!Array.isArray(body.tools) || body.tools.some((t) => typeof t !== 'string' || t.length === 0)) {
      return json({ error: 'invalid-tools', message: 'set-tools requires a non-empty-string array `tools`.' }, 400);
    }
    // De-dupe while preserving order (markers '*'/'#' are valid entries).
    setTools = [...new Set(body.tools)];
  } else if (typeof tool !== 'string' || tool.length === 0) {
    return json({ error: 'invalid-tool' }, 400);
  }

  // Resolve the manifest across every scope via the registry, not a hardcoded
  // system dir — otherwise user/global-scoped apps 404.
  const { getAppManager } = await import('@aura/core');
  const mgr = getAppManager();
  if (PERMISSION_ACTIONS.has(action) && mgr.registry.getScopeId(appId) === 'system') {
    return json({
      error: 'system-scope',
      message: `${appId} is a system app: its permissions ship with AuraOS and are not edited in place. `
        + 'Changing them comes with the system overlay (Phase 6). Privileged permissions it already requests are granted with `aura grant notif-perms`.',
    }, 409);
  }
  const path = join(mgr.registry.getAppDir(appId), 'app.manifest.json');
  if (!existsSync(path)) {
    return json({ error: 'manifest-not-found', appId, path }, 404);
  }

  let manifest: Record<string, unknown>;
  try { manifest = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>; }
  catch (err) { return json({ error: 'manifest-parse-failed', message: (err as Error).message }, 500); }

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
    const current = Array.isArray(manifest['permissions']) ? (manifest['permissions'] as string[]) : [];
    let next = current;
    let changed = false;
    if (action === 'add-permission') {
      if (!current.includes(perm)) { next = [...current, perm]; changed = true; }
    } else if (current.includes(perm)) {
      next = current.filter((p) => p !== perm); changed = true;
    }

    // Unknown names are allowed through (PermissionSchema is a free-form
    // string and apps may define their own) but flagged, since a typo would
    // otherwise silently grant nothing.
    const unknown = action === 'add-permission' && !BUILTIN_PERMISSIONS.includes(perm as never);

    if (changed) {
      manifest['permissions'] = next;
      try { writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n'); }
      catch (err) { return json({ error: 'write-failed', message: (err as Error).message }, 500); }
      await auditOwner(admin, `manifest.${action}`, { target: `app:${appId}`, detail: { permission: perm } });
    }

    // Reload even on a no-op. The in-memory registry can drift from disk (a
    // manifest edited outside the OS, or written before this shell booted),
    // and in that state the permission LOOKS granted in the file while every
    // request still 403s. Re-reading unconditionally makes this endpoint the
    // way to resync, not just the way to mutate.
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
      return json({ ok: true, appId, action, permission: perm, changed, permissions: next, unknown, reloaded: true });
    } catch (err) {
      // The file is written but the running registry still has the old value,
      // so the grant won't take effect until a restart. Say so rather than
      // reporting a success the caller can't actually use.
      return json({ ok: true, appId, action, permission: perm, changed, permissions: next, unknown, reloaded: false, reloadError: (err as Error).message });
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
    const had = Array.isArray(svc['tools']);
    const current = had ? (svc['tools'] as string[]) : [];
    let next = current;
    if (action === 'add-service-tool') {
      // A template without `tools` gains its own list (and its sidecars their
      // own dir on their next spawn — the spec changes, so they are recreated).
      if (!had || !current.includes(tool!)) next = [...current, tool!];
    } else if (current.includes(tool!)) {
      // Never drop the key: `tools: []` keeps the own dir (runtime grants).
      next = current.filter((t) => t !== tool!);
    }
    const changed = next !== current;
    const appTools = Array.isArray(manifest['tools']) ? (manifest['tools'] as string[]) : [];
    // A tool the app lacks is kept but not provisioned — tell the caller.
    const appHolds = tool === '*' || tool === '#' || toolsGrant(appTools, tool!);
    if (changed) {
      svc['tools'] = next;
      try { writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n'); }
      catch (err) { return json({ error: 'write-failed', message: (err as Error).message }, 500); }
      await auditOwner(admin, `manifest.${action}`, { target: `app:${appId}`, detail: { service: body.service, tool } });
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

  const tools = Array.isArray(manifest['tools']) ? (manifest['tools'] as string[]) : [];
  let changed = false;
  let nextTools = tools;
  if (action === 'set-tools') {
    nextTools = setTools!;
    // Order-insensitive equality check so a no-op reorder doesn't rewrite.
    const a = [...tools].sort(), b = [...nextTools].sort();
    changed = a.length !== b.length || a.some((t, i) => t !== b[i]);
  } else if (action === 'add-tool') {
    if (!tools.includes(tool!)) { nextTools = [...tools, tool!]; changed = true; }
  } else {
    if (tools.includes(tool!))  { nextTools = tools.filter((t) => t !== tool!); changed = true; }
  }

  if (changed) {
    manifest['tools'] = nextTools;
    try { writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n'); }
    catch (err) { return json({ error: 'write-failed', message: (err as Error).message }, 500); }
    await auditOwner(admin, `manifest.${action}`, { target: `app:${appId}`, detail: action === 'set-tools' ? { tools: nextTools } : { tool } });

    // Hot-refresh running instances of this app so their /aura/my-tools
    // allowlist picks up the change without a backend respawn. AppManager
    // already drives this via refreshInstanceTools — same path
    // /api/admin/cap-refresh uses after `cap install`.
    try {
      // Force the registry to re-read the manifest from disk before refreshing
      // tools dirs — chokidar will eventually fire `change` but the lag
      // between our write and that event means refreshInstanceTools would
      // otherwise use a stale in-memory tools[].
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

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
