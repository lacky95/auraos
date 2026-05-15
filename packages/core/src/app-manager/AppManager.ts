import { mkdirSync, readdirSync, readFileSync, lstatSync, writeFileSync, chmodSync, unlinkSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { AppManifest } from '../types/manifest.js';
import type { AppLifecycleState } from '../types/lifecycle.js';
import type { AppInstance } from '../types/instance.js';
import type { AppActivity } from '../types/activity.js';
import { OsEventBus } from '../ipc/OsEventBus.js';
import { AppRegistry } from './AppRegistry.js';
import { PortAllocator } from './PortAllocator.js';
import { LifecycleStateMachine } from './LifecycleStateMachine.js';
import { ProotRunner, killProcessGroup } from './ProotRunner.js';
import { IntentResolver, type Intent, type IntentMatch } from './IntentResolver.js';
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
  readonly intents:     IntentResolver;
  private dataDir: string;
  private toolchainDir: string;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private reconcileRunning = false;
  // Pool refills currently in flight per appId. The "pool" itself is just the
  // subset of `instances` with `inPool === true`; we don't keep a separate
  // queue (avoids stale instanceId references when a pool member dies). The
  // refill counter prevents over-spawning when many slots open simultaneously.
  private refillInFlight = new Map<string, number>();

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
    this.toolchainDir = opts.toolchainDir;
    this.registry = new AppRegistry(opts.appsDir);
    this.ports = new PortAllocator(opts.portStart ?? 4001, opts.portEnd ?? 4999);
    this.fsm = new LifecycleStateMachine();
    this.runner = new ProotRunner({
      baseRootfs: opts.baseRootfs,
      toolchainDir: opts.toolchainDir,
      appsDir: opts.appsDir,
      dataDir: opts.dataDir,
      // PRoot sandboxes don't always carry an /etc/hosts entry for `localhost`
      // (the base rootfs we bind in doesn't ship one), so DNS resolution for
      // the hostname `localhost` fails with ENOTFOUND when an app tries to
      // POST back to /api/os/events/*. Using 127.0.0.1 sidesteps the lookup
      // entirely and works in BOTH prooted and non-prooted spawns.
      osApiBase: `http://127.0.0.1:${opts.shellPort ?? 3000}`,
    });
    this.permissions = new PermissionManager(this.registry);
    this.providers   = new ContentProviderRegistry();
    this.intents     = new IntentResolver();
  }

  /**
   * Replace any toolchain entry that's currently a symlink with the real
   * shim-script content. PRoot's ptrace-based bind cannot translate
   * `readlink()` on bound symlinks — Node's `realpathSync` then throws
   * EINVAL on entry-point resolution (see ProotRunner bind setup).
   *
   * The Dockerfile's dev CMD already installs the shim via `install -D`,
   * but that only runs on container create. If the running image was built
   * before that change, the toolchain entries are still symlinks. Healing
   * here makes the fix work the moment the shell process starts, without
   * needing a `docker compose up --build`.
   *
   * Tools handled today: `aura` (the CLI). Add more entries here if other
   * tools ever ship as `#!/usr/bin/env node` scripts. Plain executables
   * (bash, node, git, curl, claude) don't need a shim.
   */
  private healToolchainShims(): void {
    const shimSource = '/workspace/os/aura-cli-shim.sh';
    if (!existsSync(shimSource)) return; // dev-only path; skip silently in prod
    let shimContent: string;
    try { shimContent = readFileSync(shimSource, 'utf-8'); }
    catch { return; }

    const targets = [
      join(this.toolchainDir, 'bin', 'aura'),
      '/usr/local/bin/aura',
    ];
    for (const target of targets) {
      try {
        let needsWrite = true;
        if (existsSync(target)) {
          const st = lstatSync(target);
          if (st.isFile()) {
            // Already a regular file — only rewrite if content drifted.
            try { needsWrite = readFileSync(target, 'utf-8') !== shimContent; }
            catch { needsWrite = true; }
          } else {
            // Symlink (or something else) — replace.
            unlinkSync(target);
          }
        }
        if (needsWrite) {
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, shimContent);
          chmodSync(target, 0o755);
          console.log(`[AppManager] healed toolchain shim → ${target}`);
        }
      } catch (err) {
        console.warn(`[AppManager] could not heal ${target}: ${(err as Error).message}`);
      }
    }

    // Mirror /workspace/os/bashrc.aura.sh into the base-rootfs that every
    // PRoot uses as its `/`. The Dockerfile dev CMD already does this on
    // container create, but a workspace-side edit to the bashrc otherwise
    // requires `docker compose up --build` to land — this self-heal makes
    // every shell startup pick up the latest version.
    const bashrcSource = '/workspace/os/bashrc.aura.sh';
    const baseRootfsRoot = process.env['AURA_BASE_ROOTFS'] ?? '/os/base-rootfs';
    if (existsSync(bashrcSource) && existsSync(baseRootfsRoot)) {
      try {
        const content = readFileSync(bashrcSource, 'utf-8');
        for (const dst of [join(baseRootfsRoot, 'root', '.bashrc'), join(baseRootfsRoot, 'etc', 'profile.d', 'aura-prompt.sh')]) {
          mkdirSync(dirname(dst), { recursive: true });
          let drift = true;
          try { drift = readFileSync(dst, 'utf-8') !== content; } catch { /* not present */ }
          if (drift) {
            writeFileSync(dst, content);
            chmodSync(dst, 0o644);
            console.log(`[AppManager] healed bashrc → ${dst}`);
          }
        }
      } catch (err) {
        console.warn(`[AppManager] bashrc heal failed: ${(err as Error).message}`);
      }
    }

    // Pre-create /aura/{all-tools,my-tools} as empty directories in the
    // base-rootfs so PRoot's --bind has guaranteed mount points. PRoot can
    // create missing dst paths in some versions but not others; pre-creating
    // them removes the ambiguity and avoids the "binds silently dropped →
    // /aura/my-tools doesn't exist in the proot → bashrc PATH guard skips →
    // htop not found" failure mode.
    if (existsSync(baseRootfsRoot)) {
      for (const mountPoint of [join(baseRootfsRoot, 'aura', 'all-tools'), join(baseRootfsRoot, 'aura', 'my-tools')]) {
        try { mkdirSync(mountPoint, { recursive: true }); }
        catch (err) { console.warn(`[AppManager] could not pre-create ${mountPoint}: ${(err as Error).message}`); }
      }
    }
  }

  /**
   * Re-materialise the per-instance tool allowlist for every live instance
   * of `appId`. Call after a `cap grant` / `cap revoke` so a running app
   * picks up the change WITHOUT a backend respawn — the proot's bind is at
   * the directory level, so symlink mutations are immediately visible.
   *
   * Returns the list of affected instances (useful for endpoint responses
   * that want to confirm what was refreshed).
   */
  refreshInstanceTools(appId: string): string[] {
    const manifest = this.registry.getById(appId);
    if (!manifest) return [];
    const refreshed: string[] = [];
    for (const inst of this.getInstancesByApp(appId)) {
      try {
        this.runner.provisionToolsDir(inst.instanceId, manifest);
        refreshed.push(inst.instanceId);
      } catch (err) {
        console.warn(`[AppManager] refresh tools failed for ${inst.instanceId}: ${(err as Error).message}`);
      }
    }
    return refreshed;
  }

  /**
   * After a successful `cap install`, refresh every running instance whose
   * manifest declares `'*'` so the new binary shows up in /aura/my-tools.
   * Explicit-list apps are unaffected — they only see what's symlinked.
   */
  refreshWildcardApps(): string[] {
    const refreshed: string[] = [];
    for (const m of this.registry.getAll()) {
      if (!m.tools.includes('*')) continue;
      refreshed.push(...this.refreshInstanceTools(m.id));
    }
    return refreshed;
  }

  async init(): Promise<void> {
    mkdirSync(join(this.dataDir, 'apps'), { recursive: true });
    this.healToolchainShims();
    await this.registry.init();
    this.intents.reload(this.registry.getAll());
    console.log(`[AppManager] Ready. Apps found: ${this.registry.getAll().length}`);
    this.startReconciler();
    // Kick off warm-pool fills for opted-in apps (non-blocking — init returns
    // immediately, pool members spawn in the background). The reconciler tops
    // up later if any of these fail or die.
    for (const m of this.registry.getAll()) {
      if (m.warmPool > 0 && m.instanceMode === 'multi') {
        for (let i = 0; i < m.warmPool; i++) this.scheduleRefill(m.id);
      }
    }
    // Auto-start every Service component. Independent of the warm-pool path —
    // services aren't pre-staged copies of a user-facing app, they ARE the
    // running backend. The reconciler crash-recovers them on the same loop it
    // already uses for orphan reaping, so we don't need a dedicated supervisor.
    for (const m of this.registry.getAll()) {
      if (m.componentType !== 'service') continue;
      console.log(`[AppManager] starting service ${m.id}`);
      this.startService(m.id).catch((err) => {
        console.error(`[AppManager] service ${m.id} failed to start: ${(err as Error).message}`);
      });
    }
    // Auto-start non-service apps that declared autoStart=true (e.g. Settings,
    // whose content providers /api/data/{theme,workspaces,layouts} are read
    // by the shell SSR and every iframe-side OsClient). Without this they 404
    // on every cold load until the user happens to open the app manually.
    for (const m of this.registry.getAll()) {
      if (m.componentType === 'service') continue; // already handled above
      if (!m.autoStart) continue;
      console.log(`[AppManager] auto-starting ${m.id}`);
      this.start(m.id).catch((err) => {
        console.error(`[AppManager] autoStart ${m.id} failed: ${(err as Error).message}`);
      });
    }
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
   * For apps with warmPool > 0 and instanceMode='multi': claims a pre-spawned
   * idle instance from the warm pool if available; otherwise spawns fresh.
   * @returns instanceId of the (new or existing) running instance.
   */
  async start(appId: string): Promise<string> {
    const manifest = this.registry.getById(appId);
    if (!manifest) throw new Error(`App not found: ${appId}`);

    if (manifest.instanceMode === 'single') {
      // Filter out inPool members from existing-instance reuse — pool members
      // are "owned by the AppManager" until claimed; the user can't pick one
      // up via single-instance reuse without going through claimFromPool.
      // (Single-instance apps shouldn't have warmPool > 0 in practice, but
      // defending the invariant keeps the code obviously correct.)
      const existing = this.getInstancesByApp(appId).find(
        (i) => !i.inPool && (i.state === 'resumed' || i.state === 'resuming' || i.state === 'started'),
      );
      if (existing) return existing.instanceId;

      // If a single-instance app is paused/stopped, resume it
      const paused = this.getInstancesByApp(appId).find(
        (i) => !i.inPool && (i.state === 'paused' || i.state === 'stopped'),
      );
      if (paused) {
        await this.resume(paused.instanceId);
        return paused.instanceId;
      }
    } else {
      // maxInstances cap counts only USER-OWNED instances. Pool members would
      // otherwise consume the cap and starve user launches.
      const running = this.getInstancesByApp(appId).filter(
        (i) => !i.inPool && i.state !== 'destroyed' && i.state !== 'error',
      );
      if (manifest.maxInstances > 0 && running.length >= manifest.maxInstances) {
        throw new Error(`App ${appId} reached maxInstances=${manifest.maxInstances}`);
      }
    }

    // Warm-pool fast path: claim an already-resumed instance instead of paying
    // the ~3s spawn cost. Only meaningful for multi-instance apps — for single
    // mode, a pool member would BE the singleton, and refills would race the
    // user's claim. Guarded explicitly.
    if (manifest.warmPool > 0 && manifest.instanceMode === 'multi') {
      const claimed = this.claimFromPool(appId);
      if (claimed) {
        this.scheduleRefill(appId);
        return claimed.instanceId;
      }
    }

    const instanceId = await this.spawnInstance(appId, { inPool: false });
    if (manifest.warmPool > 0 && manifest.instanceMode === 'multi') {
      // User stole a slot the pool could have filled; top up.
      this.scheduleRefill(appId);
    }
    return instanceId;
  }

  // -------- Intent dispatch (Android startActivity(intent) equivalent) --------

  /**
   * Resolve and start an intent. When exactly one handler scores highest, it
   * is auto-started + an activity is opened on it (if the handler supports
   * activities). When multiple top-tied handlers exist, returns a
   * `disambiguation` result so the shell can present a chooser. When no
   * handler matches, returns `noHandler`.
   *
   * `extras` from the intent are forwarded as the activity's `data` payload —
   * the receiving app reads them in `onActivityCreate`.
   */
  async startIntent(intent: Intent): Promise<
    | { kind: 'started'; appId: string; instanceId: string; activityId?: string }
    | { kind: 'disambiguation'; candidates: IntentMatch[] }
    | { kind: 'noHandler' }
  > {
    const ranked = this.intents.resolve(intent);
    if (ranked.length === 0) return { kind: 'noHandler' };

    // Multiple equally-scored top candidates → ask the user.
    const topScore = ranked[0]!.score;
    const top = ranked.filter((m) => m.score === topScore);
    if (top.length > 1) {
      return { kind: 'disambiguation', candidates: top };
    }

    const chosen = top[0]!;
    const manifest = this.registry.getById(chosen.appId);
    if (!manifest) return { kind: 'noHandler' };

    const instanceId = await this.start(chosen.appId);

    // If the chosen handler supports activities, open one with the intent's
    // extras. Services have activityMode='none' (Zod refinement); for those
    // we just hand back the running instance.
    if (manifest.activityMode === 'multi') {
      const activity = await this.openActivity(instanceId, intent.extras);
      return { kind: 'started', appId: chosen.appId, instanceId, activityId: activity.activityId };
    }
    return { kind: 'started', appId: chosen.appId, instanceId };
  }

  // -------- Service component (Android Service equivalent) --------

  /**
   * Start a `componentType: 'service'` app's headless backend. Idempotent:
   * if a service instance is already running we return its id. Services
   * always use instanceMode='single' in practice — the registry rejects
   * activity-style multi-instance for services via the Zod refinement —
   * so the singleton check is sufficient.
   *
   * Crash recovery is handled by the existing reconciler tick (marks the
   * stale instance 'error', then init/auto-restart logic kicks in via the
   * usual orphan-reap + state transition path).
   */
  async startService(appId: string): Promise<string> {
    const manifest = this.registry.getById(appId);
    if (!manifest) throw new Error(`App not found: ${appId}`);
    if (manifest.componentType !== 'service') {
      throw new Error(`startService called for non-service app ${appId} (componentType='${manifest.componentType}')`);
    }
    const existing = this.getInstancesByApp(appId).find(
      (i) => i.state !== 'destroyed' && i.state !== 'error',
    );
    if (existing) return existing.instanceId;
    return this.spawnInstance(appId, { inPool: false });
  }

  /**
   * Stop a service instance. Thin wrapper over `stop()` that asserts the
   * underlying app is actually a service — accidentally calling this on an
   * activity-style app would skip its window-cleanup path and confuse the UI.
   */
  async stopService(instanceId: string): Promise<void> {
    const inst = this.instances.get(instanceId);
    if (!inst) return;
    const manifest = this.registry.getById(inst.appId);
    if (manifest && manifest.componentType !== 'service') {
      throw new Error(`stopService called for non-service instance ${instanceId} (app=${inst.appId})`);
    }
    await this.stop(instanceId);
  }

  /**
   * Spawn a fresh app instance and run the full lifecycle chain
   * (creating → created → starting → started → resuming → resumed).
   * Used both by user-initiated `start()` and by pool refills. The only
   * behavioural difference is whether content-provider routes get registered
   * (pool members don't claim them — see comment below).
   */
  private async spawnInstance(appId: string, opts: { inPool: boolean }): Promise<string> {
    const manifest = this.registry.getById(appId);
    if (!manifest) throw new Error(`App not found: ${appId}`);

    const instanceId = this.allocateInstanceId(appId, manifest.instanceMode);
    mkdirSync(join(this.dataDir, 'apps', appId, instanceId), { recursive: true });

    this.transition(instanceId, appId, 'creating', null);
    const port = await this.ports.allocate(instanceId);

    try {
      const pid = await this.runner.spawn(instanceId, appId, port, manifest);
      this.upsertInstance(instanceId, appId, { pid, port, startedAt: new Date(), inPool: opts.inPool });
      this.transition(instanceId, appId, 'created', port);

      await this.runner.callLifecycle(instanceId, 'onCreate');
      this.transition(instanceId, appId, 'starting', port);

      await this.runner.callLifecycle(instanceId, 'onStart');
      this.transition(instanceId, appId, 'started', port);

      await this.runner.callLifecycle(instanceId, 'onResume');
      this.transition(instanceId, appId, 'resuming', port);
      this.transition(instanceId, appId, 'resumed', port);

      // Register content providers ONLY for user-owned instances. If pool
      // members claimed /api/data/<authority>/* routes, multiple pool entries
      // would compete and the route would point at an instance the user
      // doesn't own. Pool claim registers providers after the hand-off.
      if (!opts.inPool) {
        const live = this.instances.get(instanceId);
        if (live) this.providers.registerInstance(live, manifest);
      } else {
        // Pool warm-up: pre-compile the iframe entry point (`/`) and the
        // common heavy static assets so the user's FIRST iframe load after
        // claim doesn't trigger Vite's on-demand compile + bundle path.
        // waitHealthy only touched /api/lifecycle/health, leaving the
        // index.astro module cold. Fire-and-forget; never blocks the spawn.
        const warmups = ['/'];
        if (appId === 'com.aura.terminal') {
          warmups.push('/vendor/xterm/xterm.min.js', '/vendor/xterm/xterm.min.css');
        }
        for (const path of warmups) {
          fetch(`http://localhost:${port}${path}`, { signal: AbortSignal.timeout(5000) })
            .then((r) => r.body?.cancel()).catch(() => undefined);
        }
      }

      this.runner.onExit(instanceId, (code) => this.handleUnexpectedExit(instanceId, appId, code));
      return instanceId;
    } catch (err) {
      this.ports.release(port);
      this.transition(instanceId, appId, 'error', null, String(err));
      throw err;
    }
  }

  /**
   * Pop a ready pool member and convert it to user-owned. Returns null when
   * the pool is empty or every candidate failed its readiness check (e.g.
   * the backing pid died between spawn and claim).
   */
  private claimFromPool(appId: string): AppInstance | null {
    for (const inst of this.instances.values()) {
      if (inst.appId !== appId || !inst.inPool) continue;
      if (inst.state !== 'resumed' || inst.pid == null) continue;
      let alive = false;
      try { process.kill(inst.pid, 0); alive = true; } catch { /* dead */ }
      if (!alive) {
        // Reconciler will tidy this up on its next tick; just skip for now.
        continue;
      }
      // Hand-off — keep the existing instanceId (its env was baked at spawn
      // time with this id, so renaming would break identity invariants).
      inst.inPool = false;
      const manifest = this.registry.getById(appId);
      if (manifest) this.providers.registerInstance(inst, manifest);
      // Informational state-changed event so the Process Manager picks up the
      // newly visible instance (it filters by !inPool, so this is effectively
      // an "appeared" event for that view).
      OsEventBus.emit('app:stateChanged', { instanceId: inst.instanceId, appId, state: inst.state, port: inst.port });
      console.log(`[AppManager] pool: claimed ${inst.instanceId} for user`);
      return inst;
    }
    return null;
  }

  /**
   * Background refill: spawn one more pool member if the pool isn't already
   * at target. Cap on `(currentPoolSize + inFlightRefills)` prevents
   * over-spawning when many slots open simultaneously (init, rapid claims).
   * Fire-and-forget — never blocks the caller.
   */
  private scheduleRefill(appId: string): void {
    const manifest = this.registry.getById(appId);
    if (!manifest || manifest.warmPool <= 0 || manifest.instanceMode !== 'multi') return;
    const target   = manifest.warmPool;
    const inPool   = this.countPool(appId);
    const inFlight = this.refillInFlight.get(appId) ?? 0;
    if (inPool + inFlight >= target) return;

    this.refillInFlight.set(appId, inFlight + 1);
    void this.spawnInstance(appId, { inPool: true })
      .then((instanceId) => {
        console.log(`[AppManager] pool: ${appId} refilled with ${instanceId} (now ${this.countPool(appId)}/${target})`);
      })
      .catch((err) => {
        console.warn(`[AppManager] pool: refill spawn for ${appId} failed: ${(err as Error).message}`);
      })
      .finally(() => {
        const n = (this.refillInFlight.get(appId) ?? 1) - 1;
        if (n <= 0) this.refillInFlight.delete(appId);
        else this.refillInFlight.set(appId, n);
      });
  }

  /** Number of currently-idle pool members for an app. Used by Process Manager. */
  countPool(appId: string): number {
    let n = 0;
    for (const i of this.instances.values()) {
      if (i.appId === appId && i.inPool) n++;
    }
    return n;
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
    this.runner.clearToolsDir(instanceId);
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
    this.runner.clearToolsDir(instanceId);
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
  async openActivity(
    instanceId: string,
    data?: Record<string, unknown>,
    opts?: { stackParent?: string },
  ): Promise<AppActivity> {
    const inst = this.instances.get(instanceId);
    if (!inst) throw new Error(`Instance not found: ${instanceId}`);
    const manifest = this.registry.getById(inst.appId);
    if (!manifest) throw new Error(`Manifest gone for ${inst.appId}`);
    // Services are headless by contract — refusing openActivity here is the
    // same invariant the Zod refinement enforces at manifest load (service ⇒
    // activityMode='none'). The error message is callable-friendly: callers
    // up the stack translate `service instances` to HTTP 409.
    if (manifest.componentType === 'service') {
      throw new Error(`service instances do not host activities (app=${inst.appId})`);
    }
    if (manifest.activityMode !== 'multi') {
      throw new Error(`App ${inst.appId} does not support activities (activityMode='${manifest.activityMode}')`);
    }
    // Defensive auto-claim: opening an activity on a pool member is an
    // implicit hand-off. Without this flip the Process Manager would hide
    // the parent (inPool filter) and the activity would appear orphaned.
    // Also schedules a refill so the pool stays at target size.
    if (inst.inPool) {
      inst.inPool = false;
      this.providers.registerInstance(inst, manifest);
      OsEventBus.emit('app:stateChanged', { instanceId: inst.instanceId, appId: inst.appId, state: inst.state, port: inst.port });
      console.log(`[AppManager] pool: auto-claimed ${inst.instanceId} (activity open on pool member)`);
      this.scheduleRefill(inst.appId);
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
    let minimizable = false;
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      const obj = result as { path?: unknown; title?: unknown; metadata?: unknown; minimizable?: unknown };
      if (typeof obj.path === 'string' && obj.path.length > 0) path = obj.path;
      if (typeof obj.title === 'string') title = obj.title;
      if (obj.metadata && typeof obj.metadata === 'object') metadata = obj.metadata as Record<string, unknown>;
      if (obj.minimizable === true) minimizable = true;
    }
    // Even if the app declares minimizable=true, the OS only honors it for
    // apps that keep running with no visible windows. Otherwise minimizing
    // would orphan an activity onto a backend that's about to auto-stop.
    if (minimizable && !manifest.backgroundService) {
      minimizable = false;
    }

    // Stack parent is validated: must belong to the same instance — cross-
    // instance back-stacks are deferred until we add Android-style task
    // affinity. Silently drop a bogus parent rather than throwing — the
    // caller (proxy or intent dispatcher) probably has a stale id.
    let stackParent: string | undefined;
    if (opts?.stackParent) {
      const parent = this.activities.get(opts.stackParent);
      if (parent && parent.parentInstanceId === instanceId) {
        stackParent = opts.stackParent;
      }
    }

    const activity: AppActivity = {
      activityId,
      parentInstanceId: instanceId,
      appId: inst.appId,
      path,
      createdAt: now,
      lastTransitionAt: now,
      taskId: instanceId,
      ...(title       !== undefined ? { title }       : {}),
      ...(metadata    !== undefined ? { metadata }    : {}),
      ...(minimizable ?               { minimizable: true } : {}),
      ...(stackParent ?               { stackParentId: stackParent } : {}),
    };
    this.activities.set(activityId, activity);
    OsEventBus.emit('activity:opened', {
      activityId,
      parentInstanceId: instanceId,
      appId: inst.appId,
      path,
      ...(title !== undefined ? { title } : {}),
      ...(minimizable ?         { minimizable: true } : {}),
      ...(stackParent ?         { stackParentId: stackParent } : {}),
    });
    return activity;
  }

  /**
   * Android-style back navigation. Closes the activity, then — if it was
   * launched on top of another (`stackParentId` set) — emits a focus event
   * so the shell can refocus the parent. With no parent, behaves exactly
   * like `closeActivity` (no auto-focus).
   *
   * Idempotent: unknown activityId is a no-op.
   */
  async goBack(activityId: string): Promise<void> {
    const activity = this.activities.get(activityId);
    if (!activity) return;
    const parentToFocus = activity.stackParentId ?? null;
    await this.closeActivity(activityId);
    if (parentToFocus && this.activities.has(parentToFocus)) {
      const parent = this.activities.get(parentToFocus)!;
      OsEventBus.emit('activity:focus', {
        activityId: parent.activityId,
        parentInstanceId: parent.parentInstanceId,
        appId: parent.appId,
      });
    }
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

    // 4) Pool top-up — re-fill any opted-in app's warm pool back to its
    //    target after crashes, claims that haven't been refilled yet, or
    //    failed init-time refills. scheduleRefill is idempotent against the
    //    cap so calling it slack-times is safe.
    for (const m of this.registry.getAll()) {
      if (m.warmPool <= 0 || m.instanceMode !== 'multi') continue;
      const inPool   = this.countPool(m.id);
      const inFlight = this.refillInFlight.get(m.id) ?? 0;
      const slack = m.warmPool - (inPool + inFlight);
      for (let i = 0; i < slack; i++) this.scheduleRefill(m.id);
    }

    // 5) Orphan-activity prune — activities whose parent instance is gone
    //    (typical aftermath of a partially-recovered crash or an external
    //    force-kill). Without this they linger in `this.activities`, get
    //    surfaced by /api/apps and the Process Manager, and the iframes the
    //    shell built from them point at a non-existent instance → 503/500
    //    cascades. Cheap O(n) sweep, runs every 5s.
    for (const act of Array.from(this.activities.values())) {
      if (this.instances.has(act.parentInstanceId)) continue;
      console.warn(`[AppManager] reconcile: orphan activity ${act.activityId} (parent ${act.parentInstanceId} is gone) — dropping`);
      this.activities.delete(act.activityId);
      OsEventBus.emit('activity:closed', {
        activityId: act.activityId,
        parentInstanceId: act.parentInstanceId,
        appId: act.appId,
      });
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
