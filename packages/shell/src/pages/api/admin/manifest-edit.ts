import type { APIRoute } from 'astro';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_PERMISSIONS, toolsGrant } from '@aura/core';

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
const SERVICE_ACTIONS = new Set<Action>(['add-service-tool', 'remove-service-tool']);

export const POST: APIRoute = async ({ request }) => {
  let body: Body;
  try { body = await request.json() as Body; }
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
  const path = join(mgr.registry.getAppDir(appId), 'app.manifest.json');
  if (!existsSync(path)) {
    return json({ error: 'manifest-not-found', appId, path }, 404);
  }

  let manifest: Record<string, unknown>;
  try { manifest = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>; }
  catch (err) { return json({ error: 'manifest-parse-failed', message: (err as Error).message }, 500); }

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
