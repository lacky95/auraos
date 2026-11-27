import type { APIRoute } from 'astro';
import { APP_ID_PATTERN, getAppManager } from '@aura/core';

/**
 * Per-app enable/disable state.
 *
 *   GET  → `{ enabled: { [appId]: boolean } }` for every installed app.
 *   POST → `{ appId, enabled }` flips one app. On disable AppManager.stop()s
 *          every running instance + clears the warm pool (matches the
 *          Android "force stop on disable" semantics the user picked).
 *          The kernel persists the map (AppManager owns `os/app-enabled`)
 *          and hydrates it at the start of its init (Phase 6 K).
 */

export const GET: APIRoute = () => {
  const mgr = getAppManager();
  return json({ enabled: mgr.getEnabledState() });
};

/**
 * Who may call this is the route access manifest's decision (the owner, also
 * through system Settings, D45); this body checks only what it is asked:
 * a known app id, and never a `critical` app disabled (409).
 */
export const POST: APIRoute = async ({ request }) => {
  let body: unknown;
  try { body = await request.json(); }
  catch { return json({ error: 'invalid-json' }, 400); }

  const { appId, enabled } = (body && typeof body === 'object' ? body : {}) as { appId?: unknown; enabled?: unknown };
  if (typeof appId !== 'string' || !APP_ID_PATTERN.test(appId) || typeof enabled !== 'boolean') {
    return json({ error: 'bad-request', message: 'Expected { appId: string (reverse-domain), enabled: boolean }.' }, 400);
  }

  const mgr = getAppManager();
  const manifest = mgr.getManifest(appId);
  if (!manifest) return json({ error: 'not-found', message: `Unknown app: ${appId}` }, 404);
  if (!enabled && manifest.critical) {
    return json({ error: 'critical', message: `App ${appId} is marked critical and cannot be disabled. Use \`aura stop app ${appId}\` for a one-shot stop instead.` }, 409);
  }
  let persisted: boolean;
  try {
    ({ persisted } = await mgr.setEnabled(appId, enabled));
  } catch (err) {
    return json({ error: 'failed', message: (err as Error).message }, 500);
  }
  // The kernel persisted the map (AppManager owns `os/app-enabled`); a failed write
  // keeps the in-memory change the owner already saw.
  if (!persisted) return json({ ok: true, persisted: false, warning: 'KV persist failed; change will be lost on shell restart.' });
  return json({ ok: true, persisted: true, appId, enabled });
};

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
