import type { APIRoute } from 'astro';
import { getAppManager } from '@aura/core';
import { defaultKv } from '@aura/kv-store';

/**
 * Per-app enable/disable state.
 *
 *   GET  → `{ enabled: { [appId]: boolean } }` for every installed app.
 *   POST → `{ appId, enabled }` flips one app. On disable AppManager.stop()s
 *          every running instance + clears the warm pool (matches the
 *          Android "force stop on disable" semantics the user picked).
 *          The new map is persisted to KV under `os/app-enabled` so the
 *          choice survives shell restarts (hydrated in middleware.ts before
 *          AppManager.init() so autoStart/warmPool/service-spawn loops skip
 *          disabled apps from the very first tick).
 */

const KV_NS  = 'os';
const KV_KEY = 'app-enabled';

export const GET: APIRoute = () => {
  const mgr = getAppManager();
  return json({ enabled: mgr.getEnabledState() });
};

export const POST: APIRoute = async ({ request }) => {
  let body: { appId?: string; enabled?: boolean };
  try { body = await request.json() as { appId?: string; enabled?: boolean }; }
  catch { return json({ error: 'invalid-json' }, 400); }

  const { appId, enabled } = body;
  if (typeof appId !== 'string' || typeof enabled !== 'boolean') {
    return json({ error: 'bad-request', message: 'Expected { appId: string, enabled: boolean }.' }, 400);
  }

  const mgr = getAppManager();
  try {
    await mgr.setEnabled(appId, enabled);
  } catch (err) {
    return json({ error: 'failed', message: (err as Error).message }, 400);
  }

  // Persist the WHOLE enabled map (cheap — ~5 entries), not just the delta.
  // Simpler than maintaining a diff and idempotent if the KV ever gets out
  // of sync with AppManager's in-memory copy.
  try {
    const kv = defaultKv();
    try {
      await kv.set(KV_NS, KV_KEY, mgr.getEnabledState());
    } finally {
      await kv.close().catch(() => undefined);
    }
  } catch (err) {
    // Don't roll back the in-memory change — the user already saw the toggle
    // take effect. Log so an operator can investigate the KV side.
    console.warn(`[apps/enabled] persist failed: ${(err as Error).message}`);
    return json({ ok: true, persisted: false, warning: 'KV persist failed; change will be lost on shell restart.' });
  }

  return json({ ok: true, persisted: true, appId, enabled });
};

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
