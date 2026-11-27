import type { APIRoute } from 'astro';
import * as core from '@aura/core';
import { getAppManager } from '@aura/core';
import { auditOwner, ownerAction } from '../../../lib/approvals/admin.ts';

/**
 * Soft-restart the AppManager singleton without bouncing the container.
 *
 * After a code change in `@aura/core`, the running shell still holds the OLD
 * AppManager instance on globalThis. Vite reloads the route modules but does
 * NOT re-initialise globalThis singletons. This endpoint:
 *
 *   1. Refuses if anything is mid-spawn (race-corruption hazard).
 *   2. force-kill's every tracked instance — the new singleton will not
 *      track them, and we don't want squatters from the previous generation.
 *   3. restarts the kernel (`restartKernel()` of core's bootstrap, Phase 6 K):
 *      the AppManager is disposed and the kernel part of `bootSystem()` runs
 *      again with the freshly imported core code, before this answers.
 *
 * Result: changes to @aura/core take effect without a container restart.
 *
 * Caveat: any in-flight HTTP requests proxying to a tracked instance will
 * see the upstream disappear mid-flight and the client will reconnect.
 *
 * The owner's (lib/approvals/admin.ts): it force-kills every app. The CLI in
 * the System Terminal asks for one click.
 */
export const POST: APIRoute = async (ctx) => {
  const actor = await ownerAction(ctx, {
    action: 'admin.change', level: 'session', payload: { op: 'os.soft-restart' },
    title: 'Restart the app manager', details: ['Every running app is stopped; apps start again when they are next used.'],
  });
  if (actor instanceof Response) return actor;
  await auditOwner(actor, 'os.soft-restart');
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

  try { await core.restartKernel(); }
  catch (err) {
    errors.push(`restart: ${(err as Error).message}`);
    return json({ ok: false, killed, errors }, 500);
  }

  return json({ ok: true, killed, errors, note: 'the kernel restarted' }, 200);
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}
