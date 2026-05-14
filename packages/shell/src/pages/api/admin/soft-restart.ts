import type { APIRoute } from 'astro';
import { getAppManager } from '@aura/core';

/**
 * Soft-restart the AppManager singleton without bouncing the container.
 *
 * After a code change in `@aura/core`, the running shell still holds the OLD
 * AppManager instance on globalThis. Vite reloads the route modules but does
 * NOT re-initialise globalThis singletons. This endpoint:
 *
 *   1. Refuses if anything is mid-spawn (race-corruption hazard).
 *   2. dispose()'s the current AppManager (stops the reconcile interval).
 *   3. force-kill's every tracked instance — the new singleton will not
 *      track them, and we don't want squatters from the previous generation.
 *   4. deletes globalThis.__aura_app_manager__ so the next getAppManager()
 *      call re-runs initAppManager() against the freshly imported core code.
 *
 * Result: changes to @aura/core take effect on the very next request, no
 * `docker compose restart` needed.
 *
 * Caveat: any in-flight HTTP requests proxying to a tracked instance will
 * see the upstream disappear mid-flight and the client will reconnect.
 */
export const POST: APIRoute = async () => {
  let mgr;
  try { mgr = getAppManager(); }
  catch { return json({ ok: true, note: 'no AppManager singleton to restart' }, 200); }

  const tracked = mgr.getAllInstances();
  const blocking = tracked.filter((i) =>
    i.state === 'creating' || i.state === 'starting' || i.state === 'resuming'
  );
  if (blocking.length > 0) {
    return json({
      ok: false,
      error: 'instances mid-spawn — retry after they reach resumed/error',
      blocking: blocking.map((i) => ({ instanceId: i.instanceId, state: i.state })),
    }, 409);
  }

  const killed: string[] = [];
  const errors: string[] = [];
  for (const inst of tracked) {
    try { mgr.forceKill(inst.instanceId); killed.push(inst.instanceId); }
    catch (err) { errors.push(`${inst.instanceId}: ${(err as Error).message}`); }
  }

  try { mgr.dispose(); }
  catch (err) { errors.push(`dispose: ${(err as Error).message}`); }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (globalThis as any)['__aura_app_manager__'];

  return json({ ok: true, killed, errors, note: 'next request will reinitialise AppManager' }, 200);
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}
