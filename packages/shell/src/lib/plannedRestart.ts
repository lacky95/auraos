/**
 * Planned OS restart — save the desktop, then let the detached SelfUpdater
 * bounce (or update / rebuild) the master container. One flow for every
 * entry point: `aura restart os`, the About dialog, Settings → About.
 *
 *   1. `os:shuttingDown` → open shells flush layout / workspace writes
 *   2. apps' optional `onSaveState` hooks (bounded)
 *   3. desktop snapshot written and frozen (lib/desktopSession.ts) — the
 *      shutdown itself must not overwrite it
 *   4. one-shot flags for the next boot: skip the restore (restore: false),
 *      restart the Shell Daemon
 *   5. SelfUpdater.start({ mode }) — runs outside this container, so it
 *      outlives the shell it restarts
 * If step 5 cannot start, the freeze and the flags are undone.
 */
// Namespace import: the running shell may cache a core build without newer exports.
import * as core from '@aura/core';
import { defaultKv } from '@aura/kv-store';
import { flushAndFreeze, RESTART_DAEMON_KEY, SKIP_KEY, unfreeze } from './desktopSession.js';

export type RestartMode = 'restart' | 'update' | 'rebuild';
export interface PlannedRestartOpts {
  mode?: RestartMode;
  /** Bring the desktop (activities, workspaces, layouts) back after the restart (default true). */
  restore?: boolean;
  branch?: string;
  dryRun?: boolean;
}
export type PlannedRestartResult =
  | { ok: true; job: unknown; activities: number }
  | { ok: false; error: string };

const GRACE_MS = 1_500;
const dataDir = () => process.env['AURA_DATA_DIR'] ?? '/data';

async function setFlags(restore: boolean): Promise<void> {
  const kv = defaultKv();
  try {
    if (!restore) await kv.set('os', SKIP_KEY, true); else await kv.del('os', SKIP_KEY);
    await kv.set('os', RESTART_DAEMON_KEY, true);
  } finally { await kv.close().catch(() => undefined); }
}
async function clearFlags(): Promise<void> {
  const kv = defaultKv();
  try { await kv.del('os', SKIP_KEY); await kv.del('os', RESTART_DAEMON_KEY); }
  finally { await kv.close().catch(() => undefined); }
}

export async function plannedRestart(opts: PlannedRestartOpts = {}): Promise<PlannedRestartResult> {
  const updater = new core.SelfUpdater(dataDir());
  const probed = updater.probe();
  if (!probed.ok) return { ok: false, error: probed.reason ?? 'restart is not available on this machine' };
  if (updater.isRunning()) return { ok: false, error: 'an update or restart is already running' };
  if (opts.dryRun) return { ok: true, job: null, activities: 0 };
  // An update can still be refused by its git checks — find out BEFORE the
  // shells are told to get ready and the desktop is frozen.
  if ((opts.mode ?? 'restart') === 'update') {
    const pf = updater.preflight(opts.branch ?? 'main') as { blockers?: string[] };
    if (pf.blockers?.length) return { ok: false, error: pf.blockers.join('; ') };
  }

  const restore = opts.restore !== false;
  core.OsEventBus.emit('os:shuttingDown', { restore, graceMs: GRACE_MS });
  await new Promise((r) => setTimeout(r, GRACE_MS));

  try {
    const mgr = core.getAppManager() as ReturnType<typeof core.getAppManager> & {
      collectActivityStates?: (timeoutMs?: number) => Promise<unknown>;
    };
    await mgr.collectActivityStates?.(2_000);
  } catch (err) {
    console.warn(`[planned-restart] onSaveState round failed: ${(err as Error).message}`);
  }

  let activities = 0;
  try {
    const snap = await flushAndFreeze();
    activities = snap.activities.length + snap.instances.filter((i) => i.view).length;
    await setFlags(restore);
  } catch (err) {
    unfreeze();
    return { ok: false, error: `could not save the desktop: ${(err as Error).message}` };
  }

  const res = updater.start({ mode: opts.mode ?? 'restart', branch: opts.branch });
  if (!res.ok) {
    unfreeze();
    await clearFlags().catch(() => undefined);
    return { ok: false, error: res.reason ?? 'the restart could not start' };
  }
  console.log(`[planned-restart] ${opts.mode ?? 'restart'}: saved ${activities} activities, restore=${restore}`);
  return { ok: true, job: res.job, activities };
}
