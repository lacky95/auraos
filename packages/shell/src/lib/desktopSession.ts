/**
 * Desktop session: keep the open activities across aura-shell restarts.
 *
 * Activities (activities) live only in AppManager's memory, so a shell restart
 * used to lose all of them — workspaces survived in KV with members pointing
 * at nothing. This module keeps a snapshot of every activity in KV
 * (`os/session`) and recreates them on the next boot:
 *
 *   • Auto-save — every activity open / close / navigate / state save and
 *     instance change rewrites the snapshot (debounced), so a crash or a bare
 *     `docker restart aura-shell` loses at most a second.
 *   • Freeze — a planned restart (POST /api/admin/restart) flushes and then
 *     freezes the snapshot: the shutdown itself (instances stopping, activities
 *     purged) must not overwrite what is to be restored.
 *   • Restore — after AppManager.init() (container apps are re-adopted, with
 *     the same instance ids) every saved activity is reopened: on the adopted
 *     instance with its old id when possible, else on a freshly started
 *     instance of its app. The app gets `restore: { previousActivityId,
 *     state }` in onActivityCreate. Workspace members, layout data and the
 *     shell's per-activity state are remapped to the new ids
 *     (lib/workspaceRemap.ts); members that no longer exist are pruned.
 *   • Auto-save starts only after the restore: the empty desktop of a fresh
 *     boot must never overwrite the snapshot it is about to restore.
 *
 *   • Signal shutdown — SIGTERM / SIGINT (docker stop, a container recreate,
 *     the host health guard) runs `shutdownForSignal` from server.mjs: tabs
 *     get `os:shuttingDown`, the snapshot is flushed and frozen like a
 *     planned restart. Never before the restore has finished.
 *   • Boot id — `sessionBootInfo()` (in /api/os/about) tells a reconnecting
 *     tab that the shell it talked to is gone and whether the restore of the
 *     new one is done, so it reloads onto the restored desktop exactly once.
 *
 * Settings: `os/restoreSession` (false = off; default on). A planned restart
 * "without restoring activities" sets the one-shot `os/sessionRestoreSkip`.
 */
import { randomUUID } from 'node:crypto';
// Namespace import: the running shell may cache a core build without newer exports.
import * as core from '@aura/core';
import type { AppActivity } from '@aura/core';
import { defaultKv } from '@aura/kv-store';
import { allMembers, remapWorkspaceIds, type RemapState } from './workspaceRemap.js';

export interface SessionActivity {
  activityId:       string;
  parentInstanceId: string;
  appId:            string;
  path:             string;
  title?:           string;
  history?:         Array<{ path: string; title?: string }>;
  breadcrumb?:      'os' | 'off';
  metadata?:        Record<string, unknown>;
  stackParentId?:   string;
  createdAt:        string;
  savedState?:      unknown;
}
export interface SessionInstance {
  instanceId: string;
  appId:      string;
  /** The instance itself is an activity (activityMode != 'multi') on a workspace. */
  view:       boolean;
}
export interface DesktopSnapshot {
  schema:     1;
  savedAt:    string;
  reason:     'auto' | 'planned' | 'signal';
  instances:  SessionInstance[];
  activities: SessionActivity[];
}

export const SESSION_KEY = 'session';
export const RESTORE_SETTING_KEY = 'restoreSession';
export const SKIP_KEY = 'sessionRestoreSkip';
/** Set by a planned restart: restart the Shell Daemon after the restore. */
export const RESTART_DAEMON_KEY = 'sessionRestartDaemon';
export const DAEMON_APP_ID = 'com.aura.aurashelld';
const SAVE_DEBOUNCE_MS = 1_000;

// One state per process, shared across module graphs (middleware / routes).
const G_KEY = Symbol.for('aura.desktopSession');
interface SessionGlobal {
  autosave: boolean;
  frozen:   boolean;
  timer:    ReturnType<typeof setTimeout> | null;
  writing:  Promise<void> | null;
  bound:    boolean;
  restore:  Promise<RestoreReport> | null;
  restored: boolean;
  bootId:   string;
}
const g = (): SessionGlobal => ((globalThis as { [G_KEY]?: SessionGlobal })[G_KEY] ??= {
  autosave: false, frozen: false, timer: null, writing: null, bound: false, restore: null,
  restored: false, bootId: randomUUID(),
});
// server.mjs reaches the signal shutdown through this (it loads the build, not this module).
const SHUTDOWN_HOOK = Symbol.for('aura.shellShutdown');
(globalThis as { [SHUTDOWN_HOOK]?: () => Promise<void> })[SHUTDOWN_HOOK] = () => shutdownForSignal();

async function withKv<T>(fn: (kv: ReturnType<typeof defaultKv>) => Promise<T>): Promise<T> {
  const kv = defaultKv();
  try { return await fn(kv); }
  finally { await kv.close().catch(() => undefined); }
}

// ─── Snapshot ──────────────────────────────────────────────────────────────

/** The current desktop, as it would be restored. */
export async function buildSnapshot(reason: DesktopSnapshot['reason']): Promise<DesktopSnapshot> {
  const mgr = core.getAppManager();
  const members = new Set<string>();
  try {
    const ws = await withKv((kv) => kv.getValue<RemapState>('os', 'workspaces'));
    if (ws?.workspaces) for (const m of allMembers(ws)) members.add(m);
  } catch { /* no workspaces: instance views unknown */ }

  const activities: SessionActivity[] = mgr.getAllActivities()
    .map((a: AppActivity) => ({
      activityId: a.activityId,
      parentInstanceId: a.parentInstanceId,
      appId: a.appId,
      path: a.path,
      ...(a.title !== undefined ? { title: a.title } : {}),
      ...(a.history?.length ? { history: a.history } : {}),
      ...(a.breadcrumb ? { breadcrumb: a.breadcrumb } : {}),
      ...(a.metadata ? { metadata: a.metadata } : {}),
      ...(a.stackParentId ? { stackParentId: a.stackParentId } : {}),
      createdAt: new Date(a.createdAt).toISOString(),
      ...(a.savedState !== undefined ? { savedState: a.savedState } : {}),
    }))
    .sort((x, y) => x.createdAt.localeCompare(y.createdAt));

  const withWindows = new Set(activities.map((a) => a.parentInstanceId));
  const instances: SessionInstance[] = [];
  for (const inst of mgr.getAllInstances()) {
    if (inst.inPool) continue;
    if (inst.state === 'destroyed' || inst.state === 'error') continue;
    const m = mgr.getManifest(inst.appId);
    if (!m || m.componentType === 'service') continue;
    const view = m.activityMode !== 'multi' && members.has(inst.instanceId);
    if (!view && !withWindows.has(inst.instanceId)) continue;
    instances.push({ instanceId: inst.instanceId, appId: inst.appId, view });
  }
  return { schema: 1, savedAt: new Date().toISOString(), reason, instances, activities };
}

async function writeSnapshot(reason: DesktopSnapshot['reason']): Promise<void> {
  const snap = await buildSnapshot(reason);
  await withKv((kv) => kv.set('os', SESSION_KEY, snap));
}

function scheduleSave(): void {
  const st = g();
  if (!st.autosave || st.frozen) return;
  if (st.timer) clearTimeout(st.timer);
  st.timer = setTimeout(() => {
    st.timer = null;
    if (!st.autosave || st.frozen) return;
    st.writing = writeSnapshot('auto')
      .catch((err) => console.warn(`[desktop-session] save failed: ${(err as Error).message}`))
      .finally(() => { st.writing = null; });
  }, SAVE_DEBOUNCE_MS);
}

function bindEvents(): void {
  const st = g();
  if (st.bound) return;
  st.bound = true;
  const bus = core.OsEventBus;
  const on = (ev: string) => (bus as unknown as { on(e: string, fn: () => void): void }).on(ev, scheduleSave);
  for (const ev of [
    'activity:opened', 'activity:closed', 'activity:navigated', 'activity:breadcrumbChanged',
    'activity:stateSaved', 'app:stateChanged', 'workspaces:changed',
  ]) on(ev);
}

/** Start saving the desktop on every change (after the boot restore). */
export function startAutosave(): void {
  const st = g();
  bindEvents();
  st.autosave = true;
  st.frozen = false;
  scheduleSave();
}

/**
 * Write the snapshot now and stop further writes — the planned-restart path.
 * Anything the shutdown does to activities afterwards is not recorded.
 */
export async function flushAndFreeze(reason: DesktopSnapshot['reason'] = 'planned'): Promise<DesktopSnapshot> {
  const st = g();
  st.frozen = true;
  if (st.timer) { clearTimeout(st.timer); st.timer = null; }
  if (st.writing) await st.writing.catch(() => undefined);
  const snap = await buildSnapshot(reason);
  await withKv((kv) => kv.set('os', SESSION_KEY, snap));
  return snap;
}

const SIGNAL_GRACE_MS = 300;

/**
 * SIGTERM / SIGINT: the same save as a planned restart, for a stop nobody
 * announced. Skipped when a planned restart already froze the snapshot, and
 * before the restore has finished — the half-restored desktop of a boot must
 * never overwrite the snapshot it is restoring.
 */
export async function shutdownForSignal(): Promise<void> {
  const st = g();
  if (st.frozen) return;
  if (!st.restored) { st.frozen = true; return; }
  core.OsEventBus.emit('os:shuttingDown', { restore: true, graceMs: SIGNAL_GRACE_MS });
  await new Promise((r) => setTimeout(r, SIGNAL_GRACE_MS));
  const snap = await flushAndFreeze('signal');
  console.log(`[desktop-session] shutdown: saved ${snap.activities.length} activities`);
}

/** Undo `flushAndFreeze` when a planned restart could not start. */
export function unfreeze(): void {
  g().frozen = false;
  scheduleSave();
}

// ─── Restore ───────────────────────────────────────────────────────────────

export interface RestoreReport {
  skipped?:  'disabled' | 'one-shot' | 'no-snapshot';
  restored:  number;
  failed:    Array<{ viewId: string; appId: string; error: string }>;
  idMap:     Record<string, string>;
  pruned:    number;
}

/** Restore once per boot (serialised; later calls get the same report). */
export function restoreDesktopSession(): Promise<RestoreReport> {
  const st = g();
  st.restore ??= doRestore().finally(() => { st.restored = true; startAutosave(); });
  return st.restore;
}

/** This process's boot id and whether its restore is done (GET /api/os/about). */
export function sessionBootInfo(): { bootId: string; restore: 'pending' | 'done' } {
  const st = g();
  return { bootId: st.bootId, restore: st.restored ? 'done' : 'pending' };
}

/**
 * Resolves when the boot restore is done, or after `timeoutMs`. The desktop
 * page waits on it, so a page served mid-boot already shows the windows.
 */
export async function waitForRestore(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!g().restored && Date.now() < deadline) {
    const st = g();
    if (st.restore) {
      await Promise.race([st.restore.catch(() => undefined), new Promise((r) => setTimeout(r, deadline - Date.now()))]);
      return;
    }
    await new Promise((r) => setTimeout(r, 100));  // init has not started the restore yet
  }
}

async function doRestore(): Promise<RestoreReport> {
  const report: RestoreReport = { restored: 0, failed: [], idMap: {}, pruned: 0 };
  const mgr = core.getAppManager();

  const [enabled, skip, snap, restartDaemon] = await withKv(async (kv) => [
    await kv.getValue<boolean>('os', RESTORE_SETTING_KEY),
    await kv.getValue<boolean>('os', SKIP_KEY),
    await kv.getValue<DesktopSnapshot>('os', SESSION_KEY),
    await kv.getValue<boolean>('os', RESTART_DAEMON_KEY),
  ] as const);
  if (skip) await withKv((kv) => kv.del('os', SKIP_KEY));
  if (restartDaemon) await withKv((kv) => kv.del('os', RESTART_DAEMON_KEY));

  if (enabled === false) report.skipped = 'disabled';
  else if (skip) report.skipped = 'one-shot';
  else if (!snap || snap.schema !== 1) report.skipped = 'no-snapshot';
  else await reopenActivities(mgr, snap, report);

  // Workspaces follow the activities: renamed ids, gone ones pruned — also when
  // nothing was restored (stale members from before the restart).
  try { report.pruned = await remapWorkspaces(mgr, report.idMap); }
  catch (err) { console.warn(`[desktop-session] workspace remap failed: ${(err as Error).message}`); }

  if (restartDaemon) await restartShellDaemon(mgr);

  const summary = report.skipped
    ? `skipped (${report.skipped})`
    : `${report.restored} activities restored${report.failed.length ? `, ${report.failed.length} failed` : ''}`;
  console.log(`[desktop-session] restore: ${summary}${report.pruned ? `, ${report.pruned} stale member(s) pruned` : ''}`);
  core.OsEventBus.emit('session:restored', { restored: report.restored, failed: report.failed, idMap: report.idMap, bootId: g().bootId });
  if (report.failed.length) await notifyFailures(report.failed);
  return report;
}

type Mgr = ReturnType<typeof core.getAppManager>;

function alive(mgr: Mgr, instanceId: string, appId: string): boolean {
  const i = mgr.getInstance(instanceId);
  return !!i && i.appId === appId && !i.inPool && i.state !== 'destroyed' && i.state !== 'error';
}

async function reopenActivities(mgr: Mgr, snap: DesktopSnapshot, report: RestoreReport): Promise<void> {
  const instMap = new Map<string, string | Error>();
  const instanceFor = async (oldId: string, appId: string): Promise<string> => {
    const known = instMap.get(oldId);
    if (known instanceof Error) throw known;
    if (known) return known;
    try {
      let id: string;
      if (alive(mgr, oldId, appId)) {
        id = oldId;                            // re-adopted container: same instance
      } else {
        if (!mgr.getManifest(appId)) throw new Error('app is no longer installed');
        if (!mgr.isEnabled(appId)) throw new Error('app is disabled');
        id = await mgr.start(appId);
      }
      instMap.set(oldId, id);
      return id;
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      instMap.set(oldId, e);
      throw e;
    }
  };

  // Activities that ARE instances (activityMode != 'multi').
  for (const si of snap.instances.filter((i) => i.view)) {
    try {
      const id = await instanceFor(si.instanceId, si.appId);
      report.idMap[si.instanceId] = id;
      report.restored++;
    } catch (err) {
      report.failed.push({ viewId: si.instanceId, appId: si.appId, error: (err as Error).message });
    }
  }

  // Activities, oldest first — a stack parent always predates its children.
  for (const a of snap.activities) {
    try {
      const inst = await instanceFor(a.parentInstanceId, a.appId);
      const sameInstance = inst === a.parentInstanceId;
      const stackParent = a.stackParentId ? report.idMap[a.stackParentId] : undefined;
      const opened = await mgr.openActivity(inst, undefined, {
        ...(stackParent ? { stackParent } : {}),
        restore: {
          previousActivityId: a.activityId,
          ...(sameInstance ? { activityId: a.activityId } : {}),
          path: a.path,
          ...(a.title !== undefined ? { title: a.title } : {}),
          ...(a.history ? { history: a.history } : {}),
          ...(a.breadcrumb ? { breadcrumb: a.breadcrumb } : {}),
          ...(a.metadata ? { metadata: a.metadata } : {}),
          ...(a.savedState !== undefined ? { savedState: a.savedState } : {}),
        },
      });
      report.idMap[a.activityId] = opened.activityId;
      report.restored++;
    } catch (err) {
      report.failed.push({ viewId: a.activityId, appId: a.appId, error: (err as Error).message });
    }
  }
}

/** Rename restored ids in the workspaces; drop members that are not live. */
async function remapWorkspaces(mgr: Mgr, idMap: Record<string, string>): Promise<number> {
  const state = await withKv((kv) => kv.getValue<RemapState>('os', 'workspaces'));
  if (!state?.workspaces) return 0;
  const live = new Set<string>(mgr.getAllActivities().map((a) => a.activityId));
  for (const inst of mgr.getAllInstances()) {
    const m = mgr.getManifest(inst.appId);
    if (m && m.activityMode !== 'multi' && !inst.inPool && inst.state !== 'destroyed' && inst.state !== 'error') {
      live.add(inst.instanceId);
    }
  }
  const renamed = remapWorkspaceIds(state, idMap).state;
  const dead = allMembers(renamed).filter((m) => !live.has(m));
  const { state: next, changed } = remapWorkspaceIds(renamed, {}, dead);
  if (!changed && JSON.stringify(renamed) === JSON.stringify(state)) return 0;
  const stored = await withKv((kv) => kv.set('os', 'workspaces', next));
  core.OsEventBus.emit('kv:changed', { namespace: 'os', key: 'workspaces', value: stored.value });
  core.OsEventBus.emit('workspaces:changed', {
    workspaces: next.workspaces.map((w) => ({
      id: String(w.id ?? ''),
      name: String((w as { name?: unknown }).name ?? ''),
      layoutId: String((w as { layoutId?: unknown }).layoutId ?? 'tiling'),
      memberCount: w.members.length,
    })),
    activeWorkspaceId: next.activeWorkspaceId,
  });
  return dead.length;
}

/** After a planned restart the Shell Daemon starts fresh, not re-adopted. */
async function restartShellDaemon(mgr: Mgr): Promise<void> {
  try {
    for (const inst of mgr.getInstancesByApp(DAEMON_APP_ID)) await mgr.stopService(inst.instanceId);
    if (mgr.getManifest(DAEMON_APP_ID) && mgr.isEnabled(DAEMON_APP_ID)) await mgr.startService(DAEMON_APP_ID);
    console.log('[desktop-session] restarted the Shell Daemon');
  } catch (err) {
    console.warn(`[desktop-session] Shell Daemon restart failed: ${(err as Error).message}`);
  }
}

async function notifyFailures(failed: RestoreReport['failed']): Promise<void> {
  try {
    const lines = failed.slice(0, 8).map((f) => `• ${f.appId}: ${f.error}`).join('\n');
    await core.getNotificationService().create({
      type: 'simple',
      title: `${failed.length === 1 ? '1 activity' : `${failed.length} activities`} could not be restored after the restart`,
      text: lines + (failed.length > 8 ? `\n… and ${failed.length - 8} more` : ''),
    } as Parameters<ReturnType<typeof core.getNotificationService>['create']>[0], core.SYSTEM_CALLER);
  } catch { /* notifications unavailable — the log line has it */ }
}
