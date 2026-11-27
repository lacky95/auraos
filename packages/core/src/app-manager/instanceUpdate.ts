/**
 * `updateInstance()` (Phase 6 stream M, D108 A3; the contract is
 * maintenance.ts): one app's running code replaced by its new code with no
 * traffic on the new code until its `onUpdate` ran.
 *
 *   drain (stop with reason `update`) → switchCode() → maintenance start
 *   `update` → `onUpdate {fromVersion, toVersion}` (skipped when the versions
 *   are equal) → serve
 *
 * On a failure after the drain: the caller's rollback (the Installer's
 * rollback tree for a Nexus update) puts the old code back and the old code
 * is started again for whoever ran it; the outcome says whether that worked.
 *
 * An app that must keep running (`keepRunningOnBuild`, the System Terminal's
 * live sessions, D35) is never drained: its code is switched, and the update
 * waits for its next start (`markPending`), where the maintenance start runs
 * `onUpdate` before it serves (the owner decides when: `aura restart app`).
 * An app that is not running is only switched; its next start runs `onUpdate`.
 *
 * Orchestration only, over ports (no AppManager import): AppManager wires it.
 */
import type { AuraErrorBody } from '../errors/contracts.js';
import type {
  MaintenanceStartOptions, MaintenanceStartResult, UpdateInstanceOptions, UpdateInstanceOutcome,
} from './maintenance.js';

/** Default `onUpdate` timeout (stream M). */
export const UPDATE_HOOK_TIMEOUT_MS = 120_000;

export interface InstanceUpdateDeps {
  /** The app's live, user-owned instances (no pool member, no preview), with their owners. */
  running(appId: string): Array<{ instanceId: string; owner?: string }>;
  /** Never drained by an update: live sessions (keepRunningOnBuild, a user's session host). */
  keepsRunning(appId: string): boolean;
  /** Stop every instance of the app (pool members too) with reason `update`. */
  drain(appId: string): Promise<void>;
  startMaintenance(appId: string, opts: MaintenanceStartOptions): Promise<MaintenanceStartResult>;
  /** A direct start (rollback, the other users' instances after the update). */
  start(appId: string, userId?: string): Promise<string>;
  /** Run `onUpdate` at the app's next start (it was not drained now). */
  markPending(appId: string, fromVersion: string, toVersion: string): void;
  log?(line: string): void;
}

const failed = (message: string, error = 'update-failed', category: AuraErrorBody['category'] = 'provisioning-failed', hint?: string): AuraErrorBody => ({
  error, message, category, ...(hint ? { hint } : {}),
});

export async function runInstanceUpdate(deps: InstanceUpdateDeps, appId: string, opts: UpdateInstanceOptions): Promise<UpdateInstanceOutcome> {
  const log = deps.log ?? (() => undefined);
  const running = deps.running(appId);
  const versionsDiffer = opts.fromVersion !== opts.toVersion;

  // Not running, or it must keep running: switch the code only; `onUpdate` at its next start.
  if (!running.length || deps.keepsRunning(appId)) {
    try { await opts.switchCode(); }
    catch (err) { return { ok: false, error: failed(`${appId}: the new code could not be put in place: ${(err as Error).message}`), rolledBack: true }; }
    if (versionsDiffer) deps.markPending(appId, opts.fromVersion, opts.toVersion);
    if (running.length) log(`${appId}: updated on disk; it keeps running (live sessions) and runs onUpdate at its next start (aura restart app ${appId})`);
    return { ok: true, instanceId: running[0]?.instanceId ?? null, hookCalled: false };
  }

  const owners = [...new Set(running.map((i) => i.owner))];
  const firstUser = opts.userId ?? owners[0];
  const restoreOld = async (why: string, error: AuraErrorBody): Promise<UpdateInstanceOutcome> => {
    let rolledBack = false;
    if (opts.rollback) {
      try { await opts.rollback(); rolledBack = true; }
      catch (err) { log(`${appId}: rollback failed after ${why}: ${(err as Error).message}`); }
    }
    if (rolledBack) {
      for (const owner of owners) {
        try { await deps.start(appId, owner); }
        catch (err) { log(`${appId}: the old code did not start again for ${owner ?? 'the owner'}: ${(err as Error).message}`); }
      }
    }
    return { ok: false, error, rolledBack };
  };

  // 1. Drain: the running code gets onPause/onStop/onDestroy with reason `update`.
  await deps.drain(appId);
  // 2. Switch the code. Nothing changed on a failure here (the installer is atomic): the old code starts again.
  try { await opts.switchCode(); }
  catch (err) {
    for (const owner of owners) await deps.start(appId, owner).catch(() => undefined);
    return { ok: false, error: failed(`${appId}: the new code could not be put in place: ${(err as Error).message}`), rolledBack: true };
  }
  // 3. The new code, with no traffic routed.
  const started = await deps.startMaintenance(appId, {
    reason: 'update', fromVersion: opts.fromVersion, toVersion: opts.toVersion, ...(firstUser ? { userId: firstUser } : {}),
  });
  if (!started.ok) return restoreOld('the maintenance start', started.error);
  const session = started.session;
  // 4. onUpdate, only when the version changed.
  let hookCalled = false;
  if (versionsDiffer) {
    try {
      await session.callHook('onUpdate', { fromVersion: opts.fromVersion, toVersion: opts.toVersion });
      hookCalled = true;
    } catch (err) {
      await session.finish('stop').catch(() => undefined);
      return restoreOld('onUpdate', failed(`${appId}: onUpdate (${opts.fromVersion} → ${opts.toVersion}) failed: ${(err as Error).message}`,
        'update-hook-failed', 'provisioning-failed', `the app's onUpdate refused the update; the previous version${opts.rollback ? ' is back' : ' is not restored'}: see aura logs app ${appId}`));
    }
  }
  // 5. Serve.
  try { await session.finish('serve'); }
  catch (err) {
    await session.finish('stop').catch(() => undefined);
    return restoreOld('the start', failed(`${appId}: the new code did not start: ${(err as Error).message}`));
  }
  // Every other user who ran it gets their own instance back on the new code (direct starts: onUpdate ran once).
  for (const owner of owners.filter((o) => o !== firstUser)) {
    try { await deps.start(appId, owner); }
    catch (err) { log(`${appId}: not started again for ${owner ?? 'the owner'}: ${(err as Error).message}`); }
  }
  return { ok: true, instanceId: session.instanceId, hookCalled };
}
