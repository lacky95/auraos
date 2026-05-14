import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppManifest } from '../types/manifest.js';
import type { AppLifecycleState } from '../types/lifecycle.js';
import type { AppInstance } from '../types/instance.js';
import type { AppActivity } from '../types/activity.js';
import { OsEventBus } from '../ipc/OsEventBus.js';
import { AppRegistry } from './AppRegistry.js';
import { PortAllocator } from './PortAllocator.js';
import { LifecycleStateMachine } from './LifecycleStateMachine.js';
import { ProotRunner, killProcessGroup } from './ProotRunner.js';
import { PermissionManager } from '../permissions/PermissionManager.js';
import { ContentProviderRegistry } from '../content/ContentProviderRegistry.js';

const RECONCILE_INTERVAL_MS = 5_000;
const ERROR_GRACE_MS        = 30_000;

export class AppManager {
  private registry: AppRegistry;
  private ports: PortAllocator;
  private fsm: LifecycleStateMachine;
  private runner: ProotRunner;
  private instances = new Map<string, AppInstance>();
  private nextInstanceNum = new Map<string, number>();
  private activities = new Map<string, AppActivity>();
  private nextActivityNum = new Map<string, number>();
  readonly permissions: PermissionManager;
  readonly providers:   ContentProviderRegistry;
  private dataDir: string;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private reconcileRunning = false;

  constructor(opts: {
    appsDir: string;
    dataDir: string;
    baseRootfs: string;
    toolchainDir: string;
    portStart?: number;
    portEnd?: number;
    shellPort?: number;
  }) {
    this.dataDir = opts.dataDir;
    this.registry = new AppRegistry(opts.appsDir);
    this.ports = new PortAllocator(opts.portStart ?? 4001, opts.portEnd ?? 4999);
    this.fsm = new LifecycleStateMachine();
    this.runner = new ProotRunner({
      baseRootfs: opts.baseRootfs,
      toolchainDir: opts.toolchainDir,
      appsDir: opts.appsDir,
      dataDir: opts.dataDir,
      osApiBase: `http://localhost:${opts.shellPort ?? 3000}`,
    });
    this.permissions = new PermissionManager(this.registry);
    this.providers   = new ContentProviderRegistry();
  }

  async init(): Promise<void> {
    mkdirSync(join(this.dataDir, 'apps'), { recursive: true });
    await this.registry.init();
    console.log(`[AppManager] Ready. Apps found: ${this.registry.getAll().length}`);
    this.startReconciler();
  }

  /**
   * Stop background work. Used by the soft-restart endpoint before deleting
   * the globalThis singleton, so the next `getAppManager()` call constructs a
   * fresh instance against the latest @aura/core code.
   */
  dispose(): void {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
  }

  /**
   * Start a new instance of an app.
   * For instanceMode='single': returns existing instanceId if one is already running.
   * For instanceMode='multi': always creates a new instance (subject to maxInstances cap).
   * @returns instanceId of the (new or existing) running instance.
   */
  async start(appId: string): Promise<string> {
    const manifest = this.registry.getById(appId);
    if (!manifest) throw new Error(`App not found: ${appId}`);

    if (manifest.instanceMode === 'single') {
      const existing = this.getInstancesByApp(appId).find(
        (i) => i.state === 'resumed' || i.state === 'resuming' || i.state === 'started',
      );
      if (existing) return existing.instanceId;

      // If a single-instance app is paused/stopped, resume it
      const paused = this.getInstancesByApp(appId).find(
        (i) => i.state === 'paused' || i.state === 'stopped',
      );
      if (paused) {
        await this.resume(paused.instanceId);
        return paused.instanceId;
      }
    } else {
      const running = this.getInstancesByApp(appId).filter(
        (i) => i.state !== 'destroyed' && i.state !== 'error',
      );
      if (manifest.maxInstances > 0 && running.length >= manifest.maxInstances) {
        throw new Error(`App ${appId} reached maxInstances=${manifest.maxInstances}`);
      }
    }

    const instanceId = this.allocateInstanceId(appId, manifest.instanceMode);
    mkdirSync(join(this.dataDir, 'apps', appId, instanceId), { recursive: true });

    this.transition(instanceId, appId, 'creating', null);
    const port = await this.ports.allocate(instanceId);

    try {
      const pid = await this.runner.spawn(instanceId, appId, port, manifest);
      this.upsertInstance(instanceId, appId, { pid, port, startedAt: new Date() });
      this.transition(instanceId, appId, 'created', port);

      await this.runner.callLifecycle(instanceId, 'onCreate');
      this.transition(instanceId, appId, 'starting', port);

      await this.runner.callLifecycle(instanceId, 'onStart');
      this.transition(instanceId, appId, 'started', port);

      await this.runner.callLifecycle(instanceId, 'onResume');
      this.transition(instanceId, appId, 'resuming', port);
      this.transition(instanceId, appId, 'resumed', port);

      // Register declared content providers, if any
      const live = this.instances.get(instanceId);
      if (live) this.providers.registerInstance(live, manifest);

      this.runner.onExit(instanceId, (code) => this.handleUnexpectedExit(instanceId, appId, code));
      return instanceId;
    } catch (err) {
      this.ports.release(port);
      this.transition(instanceId, appId, 'error', null, String(err));
      throw err;
    }
  }

  async stop(instanceId: string): Promise<void> {
    if (!this.runner.isRunning(instanceId)) return;
    const inst = this.instances.get(instanceId);
    if (!inst) return;
    const appId = inst.appId;
    const port = this.runner.getPort(instanceId);

    // Deregister content providers (so /api/data/<authority> stops resolving)
    this.providers.unregisterInstance(inst, this.registry.getById(appId));

    // Close all activities first (purely OS-side cleanup — app's onDestroy will run anyway)
    this.purgeActivitiesOfInstance(instanceId);

    this.transition(instanceId, appId, 'pausing', port);
    await this.runner.callLifecycle(instanceId, 'onPause').catch(() => undefined);
    this.transition(instanceId, appId, 'paused', port);

    this.transition(instanceId, appId, 'stopping', port);
    await this.runner.callLifecycle(instanceId, 'onStop').catch(() => undefined);
    this.transition(instanceId, appId, 'stopped', port);

    this.transition(instanceId, appId, 'destroying', null);
    await this.runner.callLifecycle(instanceId, 'onDestroy').catch(() => undefined);
    await this.runner.kill(instanceId);
    if (port) this.ports.release(port);
    this.transition(instanceId, appId, 'destroyed', null);

    // Clear instance after destroy
    this.instances.delete(instanceId);
    this.fsm.delete(instanceId);
    this.nextActivityNum.delete(instanceId);
  }

  /** Stop ALL instances of an app. */
  async stopAll(appId: string): Promise<void> {
    const instances = this.getInstancesByApp(appId);
    await Promise.all(instances.map((i) => this.stop(i.instanceId)));
  }

  /**
   * Force-kill an instance with SIGKILL — bypasses lifecycle hooks.
   * Use only when graceful stop fails or for emergency intervention from the process manager.
   */
  forceKill(instanceId: string): void {
    const inst = this.instances.get(instanceId);
    if (!inst) return;
    const appId = inst.appId;
    const port = this.runner.getPort(instanceId);
    this.providers.unregisterInstance(inst, this.registry.getById(appId));
    this.purgeActivitiesOfInstance(instanceId);
    const killed = this.runner.forceKill(instanceId);
    if (port) this.ports.release(port);
    if (killed) {
      this.fsm.set(instanceId, 'destroyed');
      OsEventBus.emit('app:stateChanged', { instanceId, appId, state: 'destroyed', port: null });
    }
    this.instances.delete(instanceId);
    this.fsm.delete(instanceId);
    this.nextActivityNum.delete(instanceId);
  }

  async pause(instanceId: string): Promise<void> {
    if (this.fsm.get(instanceId) !== 'resumed') return;
    const inst = this.instances.get(instanceId);
    if (!inst) return;
    const port = this.runner.getPort(instanceId);
    this.transition(instanceId, inst.appId, 'pausing', port);
    await this.runner.callLifecycle(instanceId, 'onPause').catch(() => undefined);
    this.transition(instanceId, inst.appId, 'paused', port);
  }

  async resume(instanceId: string): Promise<void> {
    const state = this.fsm.get(instanceId);
    if (state !== 'paused' && state !== 'stopped') return;
    const inst = this.instances.get(instanceId);
    if (!inst) return;
    const port = this.runner.getPort(instanceId);
    this.transition(instanceId, inst.appId, 'resuming', port);
    await this.runner.callLifecycle(instanceId, 'onResume').catch(() => undefined);
    this.transition(instanceId, inst.appId, 'resumed', port);
  }

  getInstance(instanceId: string): AppInstance | undefined {
    return this.instances.get(instanceId);
  }

  getInstancesByApp(appId: string): AppInstance[] {
    return Array.from(this.instances.values()).filter((i) => i.appId === appId);
  }

  getAllInstances(): AppInstance[] {
    return Array.from(this.instances.values());
  }

  // ----- Activity API -----

  /**
   * Open a new activity on an existing instance (Android-style: one app process,
   * many UI screens). The OS allocates the activityId and may pass optional launch
   * `data` to the app's `onActivityCreate` hook; the app can return an initial
   * `path` (where the iframe should land) and `title`.
   *
   * Apps without the hook get activities transparently (default path `/`).
   */
  async openActivity(instanceId: string, data?: Record<string, unknown>): Promise<AppActivity> {
    const inst = this.instances.get(instanceId);
    if (!inst) throw new Error(`Instance not found: ${instanceId}`);
    const manifest = this.registry.getById(inst.appId);
    if (!manifest) throw new Error(`Manifest gone for ${inst.appId}`);
    if (manifest.activityMode !== 'multi') {
      throw new Error(`App ${inst.appId} does not support activities (activityMode='${manifest.activityMode}')`);
    }
    if (
      manifest.maxActivitiesPerInstance > 0 &&
      this.getActivitiesByInstance(instanceId).length >= manifest.maxActivitiesPerInstance
    ) {
      throw new Error(`Instance ${instanceId} reached maxActivitiesPerInstance=${manifest.maxActivitiesPerInstance}`);
    }

    const num = (this.nextActivityNum.get(instanceId) ?? 0) + 1;
    this.nextActivityNum.set(instanceId, num);
    const activityId = `${instanceId}#a${num}`;
    const now = new Date();

    // Optional notification to the app. 404 / errors are silently ignored.
    const result = await this.runner.callOptionalLifecycle(instanceId, 'onActivityCreate', { activityId, data });
    let path = '/';
    let title: string | undefined;
    let metadata: Record<string, unknown> | undefined;
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      const obj = result as { path?: unknown; title?: unknown; metadata?: unknown };
      if (typeof obj.path === 'string' && obj.path.length > 0) path = obj.path;
      if (typeof obj.title === 'string') title = obj.title;
      if (obj.metadata && typeof obj.metadata === 'object') metadata = obj.metadata as Record<string, unknown>;
    }

    const activity: AppActivity = {
      activityId,
      parentInstanceId: instanceId,
      appId: inst.appId,
      path,
      createdAt: now,
      lastTransitionAt: now,
      ...(title    !== undefined ? { title }    : {}),
      ...(metadata !== undefined ? { metadata } : {}),
    };
    this.activities.set(activityId, activity);
    OsEventBus.emit('activity:opened', {
      activityId,
      parentInstanceId: instanceId,
      appId: inst.appId,
      path,
      ...(title !== undefined ? { title } : {}),
    });
    return activity;
  }

  /**
   * Close a single activity. If it was the last activity of its parent
   * AND the manifest does not declare `backgroundService`, the parent instance
   * is also stopped (Auto-Stop).
   */
  async closeActivity(activityId: string): Promise<void> {
    const activity = this.activities.get(activityId);
    if (!activity) return;
    const { parentInstanceId, appId } = activity;

    await this.runner.callOptionalLifecycle(parentInstanceId, `onActivityDestroy/${encodeURIComponent(activityId)}`);

    this.activities.delete(activityId);
    OsEventBus.emit('activity:closed', { activityId, parentInstanceId, appId });

    // Auto-Stop: last activity closed and instance is not a background service
    const manifest = this.registry.getById(appId);
    if (
      manifest &&
      !manifest.backgroundService &&
      this.getActivitiesByInstance(parentInstanceId).length === 0 &&
      this.runner.isRunning(parentInstanceId)
    ) {
      await this.stop(parentInstanceId);
    }
  }

  getActivity(activityId: string): AppActivity | undefined {
    return this.activities.get(activityId);
  }

  getActivitiesByInstance(instanceId: string): AppActivity[] {
    return Array.from(this.activities.values()).filter((a) => a.parentInstanceId === instanceId);
  }

  getActivitiesByApp(appId: string): AppActivity[] {
    return Array.from(this.activities.values()).filter((a) => a.appId === appId);
  }

  getAllActivities(): AppActivity[] {
    return Array.from(this.activities.values());
  }

  /** Remove all activities of an instance without calling the app — for stop/forceKill. */
  private purgeActivitiesOfInstance(instanceId: string): void {
    for (const activity of this.getActivitiesByInstance(instanceId)) {
      this.activities.delete(activity.activityId);
      OsEventBus.emit('activity:closed', {
        activityId: activity.activityId,
        parentInstanceId: instanceId,
        appId: activity.appId,
      });
    }
  }

  getManifests(): AppManifest[] {
    return this.registry.getAll();
  }

  getManifest(appId: string): AppManifest | undefined {
    return this.registry.getById(appId);
  }

  /**
   * @deprecated Use getInstance(instanceId) or getInstancesByApp(appId).
   * Backward-compat lookup: tries instanceId match first, then first instance of appId.
   */
  getRecord(idOrInstanceId: string): AppInstance | undefined {
    return this.instances.get(idOrInstanceId) ?? this.getInstancesByApp(idOrInstanceId)[0];
  }

  /** @deprecated Use getInstance(instanceId)?.state. */
  getState(idOrInstanceId: string): AppLifecycleState {
    const inst = this.getRecord(idOrInstanceId);
    return inst?.state ?? 'installed';
  }

  private allocateInstanceId(appId: string, mode: 'single' | 'multi'): string {
    if (mode === 'single') return appId;
    const num = (this.nextInstanceNum.get(appId) ?? 0) + 1;
    this.nextInstanceNum.set(appId, num);
    return `${appId}-${num}`;
  }

  private transition(instanceId: string, appId: string, state: AppLifecycleState, port: number | null, error?: string): void {
    this.fsm.transition(instanceId, state);
    this.upsertInstance(instanceId, appId, {
      state,
      port: port ?? this.instances.get(instanceId)?.port ?? null,
    });
    if (error) {
      const inst = this.instances.get(instanceId);
      if (inst) inst.error = error;
    }
    OsEventBus.emit('app:stateChanged', {
      instanceId,
      appId,
      state,
      port: this.instances.get(instanceId)?.port ?? null,
    });
  }

  private upsertInstance(instanceId: string, appId: string, patch: Partial<AppInstance>): void {
    const existing = this.instances.get(instanceId) ?? this.defaultInstance(instanceId, appId);
    this.instances.set(instanceId, { ...existing, ...patch, lastTransitionAt: new Date() });
  }

  private defaultInstance(instanceId: string, appId: string): AppInstance {
    return {
      instanceId,
      appId,
      state: this.fsm.get(instanceId),
      pid: null,
      port: null,
      startedAt: null,
      lastTransitionAt: new Date(),
      restartCount: 0,
    };
  }

  // ============================== Reconciler ==============================
  // A 5s heartbeat that converges AppManager state to the OS reality. Without
  // this loop, leaks/crashes/squatters can drift state silently and the proxy
  // ends up routing requests to whoever happens to own the port. Three checks
  // per tick — keep them cheap so we can run them often.

  private startReconciler(): void {
    if (this.reconcileTimer) return;
    this.reconcileTimer = setInterval(() => {
      if (this.reconcileRunning) return;
      this.reconcileRunning = true;
      this.reconcileOnce()
        .catch((err) => console.error('[AppManager] reconcile failed:', err))
        .finally(() => { this.reconcileRunning = false; });
    }, RECONCILE_INTERVAL_MS);
    if (typeof this.reconcileTimer.unref === 'function') this.reconcileTimer.unref();
  }

  private async reconcileOnce(): Promise<void> {
    // 1) Tracked-instance liveness: any pid we believe is alive but isn't
    //    must be flagged error, port released, view dropped.
    //
    //    SKIP instances with pid==null: that's the steady state during
    //    'creating'/'starting' (before spawn() returns and patches the pid in).
    //    Treating "no pid yet" as "process is dead" would kill every instance
    //    in mid-spawn — exactly the regression we hit on first deploy.
    for (const inst of Array.from(this.instances.values())) {
      const pid = inst.pid;
      if (pid != null) {
        let alive = false;
        try { process.kill(pid, 0); alive = true; }
        catch { alive = false; }
        if (!alive && inst.state !== 'error' && inst.state !== 'destroyed' && inst.state !== 'destroying') {
          console.warn(`[AppManager] reconcile: ${inst.instanceId} pid=${pid} is gone — marking error`);
          const releasedPort = inst.port;
          inst.state = 'error';
          inst.port  = null;
          inst.error = 'reconciled: backing process disappeared';
          this.fsm.set(inst.instanceId, 'error');
          if (releasedPort) this.ports.release(releasedPort);
          this.providers.unregisterInstance(inst, this.registry.getById(inst.appId));
          this.purgeActivitiesOfInstance(inst.instanceId);
          // Also drop the runner-side entry so the ProotRunner doesn't keep a
          // stale ChildProcess reference. If the OS process is somehow still
          // alive (e.g. we mis-diagnosed liveness), this also SIGKILLs the
          // whole group — preferable to leaving a squatter behind.
          try { this.runner.forceKill(inst.instanceId); } catch { /* runner may already have evicted it */ }
          OsEventBus.emit('app:stateChanged', { instanceId: inst.instanceId, appId: inst.appId, state: 'error', port: null });
          OsEventBus.emit('app:crashed',      { instanceId: inst.instanceId, appId: inst.appId, error: 'reconciled: backing process disappeared' });
        }
      }
      // Drop long-dead instance entries so they don't pollute proxy lookups.
      const age = Date.now() - inst.lastTransitionAt.getTime();
      if ((inst.state === 'error' || inst.state === 'destroyed') && age > ERROR_GRACE_MS) {
        this.instances.delete(inst.instanceId);
        this.fsm.delete(inst.instanceId);
        this.nextActivityNum.delete(inst.instanceId);
      }
    }

    // 2) Orphan reap: any /proc process whose cmdline points at apps/com.aura.*
    //    but whose ancestor chain doesn't reach a tracked proot pid is a
    //    squatter — SIGKILL it. Runs unconditionally (including when trackedPids
    //    is empty) so a fresh AppManager wipes any zombies from a previous
    //    generation. Only cmdlines matching apps/com.aura.* qualify, so a user
    //    debugging inside `aura inst shell` won't be killed.
    //
    //    IMPORTANT: include ProotRunner's in-flight PIDs too. During spawn(),
    //    waitHealthy can poll for up to 30s before the instance entry's `pid`
    //    field gets set — but the runner already has the live ChildProcess.
    //    Without the runner's view, the reaper would kill mid-spawn instances.
    const trackedPids = new Set<number>();
    for (const t of this.instances.values()) if (t.pid != null) trackedPids.add(t.pid);
    for (const pid of this.runner.getActivePids()) trackedPids.add(pid);
    const squatters = listAppOrphans(trackedPids);
    for (const orphan of squatters) {
      console.warn(`[AppManager] reconcile: SIGKILL orphan pid=${orphan.pid} app=${orphan.appId} cmd=${orphan.cmdline.slice(0, 120)}`);
      killProcessGroup(orphan.pid, 'SIGKILL');
    }

    // 3) Identity drift on tracked ports: a live pid + correct lookup is not
    //    enough — verify the bound socket actually answers as our app.
    for (const inst of Array.from(this.instances.values())) {
      if (inst.port == null || inst.state !== 'resumed') continue;
      try {
        const res = await fetch(`http://localhost:${inst.port}/api/lifecycle/health`, {
          signal: AbortSignal.timeout(1000),
        });
        if (!res.ok) continue; // transient — don't punish on a single bad response
        const declaredHeaderApp  = res.headers.get('x-aura-app-id');
        const declaredHeaderInst = res.headers.get('x-aura-instance-id');
        let bodyApp: string | null = null;
        let bodyInst: string | null = null;
        try {
          const body = await res.json() as { appId?: unknown; instanceId?: unknown };
          if (typeof body.appId      === 'string') bodyApp  = body.appId;
          if (typeof body.instanceId === 'string') bodyInst = body.instanceId;
        } catch { /* legacy responder without identity body */ }
        const seenApp  = declaredHeaderApp  ?? bodyApp;
        const seenInst = declaredHeaderInst ?? bodyInst;
        if (seenApp && seenApp !== inst.appId) {
          console.error(`[AppManager] reconcile: port ${inst.port} now answers for ${seenApp}, expected ${inst.appId}. Force-killing ${inst.instanceId}.`);
          this.forceKill(inst.instanceId);
          continue;
        }
        if (seenInst && seenInst !== inst.instanceId) {
          console.error(`[AppManager] reconcile: port ${inst.port} now answers for instance ${seenInst}, expected ${inst.instanceId}. Force-killing.`);
          this.forceKill(inst.instanceId);
        }
      } catch { /* health probe failed entirely — covered by liveness check next tick */ }
    }
  }

  private handleUnexpectedExit(instanceId: string, appId: string, code: number | null): void {
    const port = this.runner.getPort(instanceId);
    if (port) this.ports.release(port);
    const inst = this.instances.get(instanceId);
    if (inst) this.providers.unregisterInstance(inst, this.registry.getById(appId));
    this.purgeActivitiesOfInstance(instanceId);
    this.fsm.set(instanceId, 'error');
    if (inst) {
      inst.state = 'error';
      inst.port = null;
      inst.error = `Process exited with code ${code}`;
    }
    OsEventBus.emit('app:stateChanged', { instanceId, appId, state: 'error', port: null });
    OsEventBus.emit('app:crashed',      { instanceId, appId, error: `Process exited with code ${code}` });
    console.error(`[AppManager] ${instanceId} crashed (exit code ${code})`);
  }
}

interface AppOrphan { pid: number; appId: string; cmdline: string; }

/**
 * Walk /proc and return every process whose cmdline matches an Aura app dir
 * but whose ancestor chain does NOT reach any of the trackedPids. Those are
 * squatters — processes the AppManager doesn't know about that are running
 * under an app identity (likely holding ports we think are free).
 *
 * Same logic as /api/admin/reap-orphans, kept here so the reconciler doesn't
 * depend on the shell package.
 */
function listAppOrphans(trackedPids: Set<number>): AppOrphan[] {
  let pids: string[];
  try { pids = readdirSync('/proc').filter((n) => /^\d+$/.test(n)); }
  catch { return []; }

  const getPPid = (pid: number): number | null => {
    try {
      const status = readFileSync(`/proc/${pid}/status`, 'utf-8');
      const m = status.match(/^PPid:\s+(\d+)/m);
      return m ? Number(m[1]) : null;
    } catch { return null; }
  };
  const reachesTracked = (pid: number): boolean => {
    let cur: number | null = pid;
    const seen = new Set<number>();
    while (cur != null && !seen.has(cur)) {
      if (trackedPids.has(cur)) return true;
      seen.add(cur);
      cur = getPPid(cur);
    }
    return false;
  };

  const orphans: AppOrphan[] = [];
  for (const pidStr of pids) {
    let cmdline = '';
    try { cmdline = readFileSync(`/proc/${pidStr}/cmdline`, 'utf-8').replace(/\0/g, ' ').trim(); }
    catch { continue; }
    const m = cmdline.match(/apps\/(com\.aura\.[a-z.]+(?:-\d+)?)/);
    if (!m) continue;
    const pid = Number(pidStr);
    if (reachesTracked(pid)) continue;
    const appId = (m[1] ?? '').replace(/-\d+$/, '');
    orphans.push({ pid, appId, cmdline });
  }
  return orphans;
}

/**
 * Singleton stored on globalThis so it survives Vite 7's Environments API,
 * where different module graphs (SSR vs plugin context) would otherwise see
 * separate module-scoped instances.
 */
const GLOBAL_KEY = '__aura_app_manager__';
type GlobalWithAura = typeof globalThis & { [GLOBAL_KEY]?: AppManager };

export function getAppManager(): AppManager {
  const instance = (globalThis as GlobalWithAura)[GLOBAL_KEY];
  if (!instance) throw new Error('AppManager not initialized. Call initAppManager() first.');
  return instance;
}

export function initAppManager(opts: ConstructorParameters<typeof AppManager>[0]): AppManager {
  const existing = (globalThis as GlobalWithAura)[GLOBAL_KEY];
  if (existing) return existing;
  const instance = new AppManager(opts);
  (globalThis as GlobalWithAura)[GLOBAL_KEY] = instance;
  return instance;
}
