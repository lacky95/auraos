import { mkdirSync, readdirSync, readFileSync, lstatSync, writeFileSync, chmodSync, copyFileSync, unlinkSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { AppManifest } from '../types/manifest.js';
import { lifecyclePath } from '../types/manifest.js';
import type { AppLifecycleState } from '../types/lifecycle.js';
import type { AppInstance } from '../types/instance.js';
import type { AppActivity } from '../types/activity.js';
import { OsEventBus } from '../ipc/OsEventBus.js';
import { AppRegistry } from './AppRegistry.js';
import { PortAllocator } from './PortAllocator.js';
import { LifecycleStateMachine } from './LifecycleStateMachine.js';
import { ProotRunner, killProcessGroup } from './ProotRunner.js';
import { ContainerRunner } from './ContainerRunner.js';
import type { SandboxRunner } from './SandboxRunner.js';
import { IntentResolver, type Intent, type IntentMatch } from './IntentResolver.js';
import { PermissionManager } from '../permissions/PermissionManager.js';
import { ContentProviderRegistry } from '../content/ContentProviderRegistry.js';
import { keymapRegistry } from '../keymap/KeymapRegistry.js';
import { ScopeRegistry } from '../scopes/ScopeRegistry.js';
import type { ScopeDefinition } from '../scopes/types.js';

const RECONCILE_INTERVAL_MS = 5_000;
const ERROR_GRACE_MS        = 30_000;

export class AppManager {
  // Public so the manifest-edit endpoint can call reloadFromDisk(appId)
  // after writing — chokidar's lag would otherwise let refreshInstanceTools
  // see a stale in-memory tools[] right after a `cap grant`.
  public registry: AppRegistry;
  private ports: PortAllocator;
  private fsm: LifecycleStateMachine;
  /**
   * Default runner — used by the existing `this.runner` call-sites. We keep
   * the field so the rest of AppManager doesn't have to know about the two
   * backends. The `pickRunner(manifest)` method routes through `runners`
   * for code paths that need per-app selection (spawn/health/exit, lifecycle
   * dispatch). For utility calls without a manifest in scope (forceKill,
   * port lookup, getActivePids) we union across runners.
   */
  private runner: SandboxRunner;
  private runners: Record<'proot' | 'container', SandboxRunner>;
  private instances = new Map<string, AppInstance>();
  private nextInstanceNum = new Map<string, number>();
  private activities = new Map<string, AppActivity>();
  private nextActivityNum = new Map<string, number>();
  readonly permissions: PermissionManager;
  readonly providers:   ContentProviderRegistry;
  readonly intents:     IntentResolver;
  private dataDir: string;
  private toolchainDir: string;
  private scopeRegistry: ScopeRegistry;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private reconcileRunning = false;
  // Pool refills currently in flight per appId. The "pool" itself is just the
  // subset of `instances` with `inPool === true`; we don't keep a separate
  // queue (avoids stale instanceId references when a pool member dies). The
  // refill counter prevents over-spawning when many slots open simultaneously.
  private refillInFlight = new Map<string, number>();
  /**
   * Per-app enable/disable state. Stores ONLY the explicit `false` flags —
   * absence means "enabled" (the default). That way a newly scaffolded app
   * is implicitly enabled and we don't have to migrate this map on every
   * `chokidar add`. Hydrated from KV at boot via `setEnabledState()`;
   * mutated via `setEnabled()` (which also stops running instances on disable).
   */
  private disabled = new Set<string>();

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
    this.scopeRegistry = new ScopeRegistry({ systemAppsDir: opts.appsDir, dataDir: opts.dataDir });
    this.registry = new AppRegistry(this.scopeRegistry.getAll());
    this.ports = new PortAllocator(opts.portStart ?? 4001, opts.portEnd ?? 4999);
    this.fsm = new LifecycleStateMachine();
    // Both runners share the same opts. ContainerRunner rewrites osApiBase
    // to its docker-network hostname; ProotRunner keeps 127.0.0.1.
    const runnerOpts = {
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
    };
    this.runners = {
      proot:     new ProotRunner(runnerOpts),
      container: new ContainerRunner(runnerOpts),
    };
    // Default runner for utility calls; per-app spawn routes via runnerOf().
    this.runner = this.runners['proot'];
    this.permissions = new PermissionManager(this.registry);
    this.providers   = new ContentProviderRegistry();
    this.intents     = new IntentResolver();
  }

  /**
   * Resolve the runner that owns an instance. Reads the runner key off the
   * stored AppInstance (latched at spawn time). Falls back to the manifest's
   * `sandbox` field if the instance isn't recorded yet (during spawn), and
   * finally to ProotRunner if neither is available. Never returns null —
   * callers always get something they can call methods on.
   */
  private runnerOf(instanceIdOrAppId: string): SandboxRunner {
    const inst = this.instances.get(instanceIdOrAppId);
    if (inst?.sandbox) return this.runners[inst.sandbox];
    const m = this.registry.getById(inst?.appId ?? instanceIdOrAppId);
    if (m?.sandbox) return this.runners[m.sandbox];
    return this.runners['proot'];
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

    // Make sure the host docker CLI is present in /os/toolchain/bin/docker so
    // wildcard-cap apps (terminal: tools[] = ['*']) get it linked into their
    // /aura/my-tools allowlist on next cap refresh — required for `aura jump`
    // into container-mode apps from inside the terminal proot (the host's
    // docker socket is bind-mounted alongside this; see ProotRunner). Cheap
    // idempotent copy: skips if the toolchain entry already exists.
    const dockerToolchain = join(this.toolchainDir, 'bin', 'docker');
    if (!existsSync(dockerToolchain) && existsSync('/usr/local/bin/docker')) {
      try {
        mkdirSync(dirname(dockerToolchain), { recursive: true });
        copyFileSync('/usr/local/bin/docker', dockerToolchain);
        chmodSync(dockerToolchain, 0o755);
        console.log(`[AppManager] healed docker → ${dockerToolchain}`);
      } catch (err) {
        console.warn(`[AppManager] could not heal docker into toolchain: ${(err as Error).message}`);
      }
    }

    // Pre-create the shared user-home subpath inside the app-data named
    // volume. ContainerRunner mounts /home/aura from this path into every
    // sibling app container so tools like `claude` / `gh` / `ssh` persist
    // their state across respawns AND across `aura jump` hops. Without
    // pre-creating it, docker's volume-subpath mount fails on first spawn
    // ("subpath … does not exist in the volume").
    const sharedHome = join(this.dataDir, 'aura', 'home', 'user');
    try {
      mkdirSync(sharedHome, { recursive: true });
    } catch (err) {
      console.warn(`[AppManager] could not pre-create shared home ${sharedHome}: ${(err as Error).message}`);
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

    // Mirror the toolchain into the aura-app-data named volume so sibling
    // containers (sandbox: 'container' apps) can see it. Background: their
    // bind sources are resolved by the HOST docker daemon, which cannot see
    // paths that only exist inside the aura-shell image (like /os/toolchain).
    // ContainerRunner mounts /data/aura/toolchain/bin into /aura/all-tools via
    // a named-volume subpath, so this mirror is what makes the wildcard cap
    // allowlist actually visible inside container-mode apps. PRoot apps
    // continue to bind /os/toolchain/bin directly — they live in aura-shell's
    // own mount namespace.
    const srcBin    = join(this.toolchainDir, 'bin');
    const mirrorBin = join(this.dataDir, 'aura', 'toolchain', 'bin');
    if (existsSync(srcBin)) {
      try {
        mkdirSync(mirrorBin, { recursive: true });
        for (const name of readdirSync(srcBin)) {
          const src = join(srcBin, name);
          const dst = join(mirrorBin, name);
          let needsCopy = true;
          try {
            const sStat = lstatSync(src);
            const dStat = lstatSync(dst);
            // Skip when same size + dst mtime >= src mtime (good-enough idempotency
            // for an image-shipped toolchain). Re-copy on size or mtime drift.
            if (sStat.size === dStat.size && dStat.mtimeMs >= sStat.mtimeMs) needsCopy = false;
          } catch { /* dst missing */ }
          if (!needsCopy) continue;
          try {
            copyFileSync(src, dst);
            chmodSync(dst, 0o755);
          } catch (err) {
            console.warn(`[AppManager] toolchain mirror ${src} → ${dst} failed: ${(err as Error).message}`);
          }
        }
        console.log(`[AppManager] toolchain mirrored → ${mirrorBin} (${readdirSync(mirrorBin).length} entries)`);
      } catch (err) {
        console.warn(`[AppManager] toolchain mirror init failed: ${(err as Error).message}`);
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
        this.runnerOf(inst.instanceId).provisionToolsDir(inst.instanceId, manifest);
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

  // ─── Enable / disable apps ────────────────────────────────────────────────
  // Android-style component enable state. Default is "enabled"; storing only
  // the disabled set means a freshly-scaffolded app is live without any
  // migration. The shell hydrates this from KV (`os/app-enabled`) before
  // calling `init()` and persists every mutation through the corresponding
  // /api/admin/apps/enabled endpoint.

  isEnabled(appId: string): boolean {
    return !this.disabled.has(appId);
  }

  /** Returns an explicit `{ appId → boolean }` map for every known app. */
  getEnabledState(): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    for (const m of this.registry.getAll()) out[m.id] = !this.disabled.has(m.id);
    return out;
  }

  /** Bulk seed at boot. Accepts `{ appId → boolean }` from KV. */
  setEnabledState(state: Record<string, boolean>): void {
    this.disabled = new Set(Object.entries(state).filter(([, v]) => v === false).map(([k]) => k));
  }

  /**
   * Flip the enabled flag. Disabling stops every running instance + clears
   * the warm pool (matches Android's "force stop on disable" behaviour the
   * user asked for). Enabling re-arms autoStart / warmPool by re-running
   * the same init() side-effects, scoped to this app.
   */
  async setEnabled(appId: string, enabled: boolean): Promise<void> {
    if (!this.registry.has(appId)) throw new Error(`Unknown app: ${appId}`);
    // Critical OS-infrastructure apps (e.g. com.aura.registry) refuse the
    // disable path. They can still be stopped/restarted via the normal
    // lifecycle endpoints — the guard only blocks the persistent
    // "user said no, don't auto-start this anymore" toggle.
    if (!enabled) {
      const m = this.registry.getById(appId);
      if (m?.critical) {
        throw new Error(
          `App ${appId} is marked critical: true in its manifest and cannot be disabled. ` +
          `Use \`aura inst stop ${appId}\` for a one-shot stop instead.`,
        );
      }
    }
    const wasEnabled = !this.disabled.has(appId);
    if (enabled === wasEnabled) return;
    if (enabled) {
      this.disabled.delete(appId);
      // Re-arm: same code paths init() runs at boot, just for this app.
      const m = this.registry.getById(appId);
      if (m) {
        if (m.componentType === 'service') {
          this.startService(appId).catch((err) =>
            console.error(`[AppManager] enable: service ${appId} failed: ${(err as Error).message}`),
          );
        } else if (m.autoStart) {
          this.start(appId).catch((err) =>
            console.error(`[AppManager] enable: autoStart ${appId} failed: ${(err as Error).message}`),
          );
        }
        if (m.warmPool > 0 && m.instanceMode === 'multi') {
          for (let i = 0; i < m.warmPool; i++) this.scheduleRefill(appId);
        }
      }
    } else {
      this.disabled.add(appId);
      // Kill everything we know about for this app (instances + pool members
      // both live in `this.instances`).
      for (const inst of this.getInstancesByApp(appId)) {
        try { await this.stop(inst.instanceId); }
        catch (err) { console.warn(`[AppManager] disable: stop ${inst.instanceId} failed: ${(err as Error).message}`); }
      }
    }
    OsEventBus.emit('app:enabledChanged', { appId, enabled });
  }

  async init(): Promise<void> {
    mkdirSync(join(this.dataDir, 'apps'), { recursive: true });
    this.healToolchainShims();
    await this.registry.init();
    this.intents.reload(this.registry.getAll());
    keymapRegistry.reloadFromManifests(this.registry.getAll());
    console.log(`[AppManager] Ready. Apps found: ${this.registry.getAll().length}, keymap actions: ${keymapRegistry.list().length}`);
    // Adopt every sibling container that survived the last shell lifetime.
    // Without this, `docker compose restart aura-os` strands every running
    // container-mode app as an orphan — they're still up on aura-net (they're
    // siblings, not children, so SIGCHLD doesn't reap them), but AppManager
    // has no record. That means `getInstancesByApp` returns empty, so cap
    // grant/revoke can't hot-refresh them, lifecycle events don't fire, and
    // warm-pool refills race with the surviving members. We hydrate from
    // `docker ps` + `docker inspect` (env carries APP_ID/APP_INSTANCE_ID/
    // APP_PORT — set in buildDockerArgs) and resurrect each instance in
    // `state: 'resumed'` ready for normal lifecycle calls.
    try {
      const orphans = await this.runners.container.listOrphanRecords?.() ?? [];
      for (const o of orphans) {
        if (this.instances.has(o.instanceId)) continue;
        const inst: AppInstance = {
          instanceId:        o.instanceId,
          appId:             o.appId,
          state:             'resumed',
          port:              o.port,
          pid:               o.pid,
          startedAt:         new Date(),
          lastTransitionAt:  new Date(),
          restartCount:      0,
          inPool:            false,
          sandbox:           'container',
        };
        this.instances.set(o.instanceId, inst);
        // Bump nextInstanceNum so future spawns don't collide with this
        // adopted name. Instance IDs are "<appId>-<n>" or "<appId>" (single).
        const m = o.instanceId.match(/-(\d+)$/);
        if (m) {
          const n = parseInt(m[1]!, 10);
          const cur = this.nextInstanceNum.get(o.appId) ?? 0;
          if (n > cur) this.nextInstanceNum.set(o.appId, n);
        }
        const manifest = this.registry.getById(o.appId);
        if (manifest) {
          this.runners.container.registerAdopted?.({ ...o, manifest });
          this.providers.registerInstance(inst, manifest);
        } else {
          // Manifest gone (app uninstalled mid-restart). Skip adoption — without
          // a manifest the runner can't build correct lifecycle URLs and the
          // reconciler will tear the container down on the next pass anyway.
          console.warn(`[AppManager] skipping orphan adoption for ${o.instanceId}: manifest for ${o.appId} not found`);
        }
        console.log(`[AppManager] adopted orphan container ${o.instanceId} (appId=${o.appId}, port=${o.port})`);
      }
    } catch (err) {
      console.warn(`[AppManager] orphan adoption failed: ${(err as Error).message}`);
    }
    this.startReconciler();
    // Kick off warm-pool fills for opted-in apps (non-blocking — init returns
    // immediately, pool members spawn in the background). The reconciler tops
    // up later if any of these fail or die.
    for (const m of this.registry.getAll()) {
      if (!this.isEnabled(m.id)) continue;
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
      if (!this.isEnabled(m.id)) { console.log(`[AppManager] skipping disabled service ${m.id}`); continue; }
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
      if (!this.isEnabled(m.id)) { console.log(`[AppManager] skipping disabled autoStart ${m.id}`); continue; }
      console.log(`[AppManager] auto-starting ${m.id}`);
      this.start(m.id).catch((err) => {
        console.error(`[AppManager] autoStart ${m.id} failed: ${(err as Error).message}`);
      });
    }

    // First-boot seed for the local OCI registry: once com.aura.registry is
    // healthy, ensure the @aura/* packages are published into it. On a fresh
    // `aura-app-data` volume the catalog is empty and any user-scope app
    // scaffolded by `aura dev new` would fail at `aura sdk install` because
    // it'd find no @aura/* artifacts to pull. Runs in the background;
    // shell can serve while seeding takes its ~10-30s.
    if (this.registry.has('com.aura.registry')) {
      this.seedLocalRegistryIfEmpty().catch((err) => {
        console.warn(`[AppManager] local registry seed: ${(err as Error).message}`);
      });
    }
  }

  /** Wait for com.aura.registry to be healthy, then publish every @aura/*
   *  package if the catalog is empty. Idempotent — re-runs are cheap (the
   *  publish script's tagExists() check skips already-pushed versions).
   *  Always returns; failures are logged but don't break boot. */
  private async seedLocalRegistryIfEmpty(): Promise<void> {
    const { LOCAL_REGISTRY_DEFAULT_URL } = await import('../nexus/RegistryConfig.js');
    const url = LOCAL_REGISTRY_DEFAULT_URL;
    // 1. Wait for /v2/ ping (zot answers it once boot's done). Up to 60 s.
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${url}/v2/`, { signal: AbortSignal.timeout(2_000) });
        if (r.status === 200 || r.status === 404) break;  // 404 is normal for /v2/ on empty registry
      } catch { /* not up yet */ }
      await new Promise((res) => setTimeout(res, 2_000));
    }
    if (Date.now() >= deadline) {
      console.warn('[AppManager] local registry never became healthy; skipping seed');
      return;
    }
    // 2. Catalog populated already? Skip.
    try {
      const r = await fetch(`${url}/v2/_catalog`, { signal: AbortSignal.timeout(5_000) });
      const body = await r.json().catch(() => ({})) as { repositories?: string[] };
      if (Array.isArray(body.repositories) && body.repositories.some((n) => n.startsWith('aura/'))) {
        console.log(`[AppManager] local registry catalog already has aura/* (${body.repositories.length} repos) — skipping seed`);
        return;
      }
    } catch (err) {
      console.warn(`[AppManager] catalog probe failed: ${(err as Error).message} — attempting seed anyway`);
    }
    // 3. Run publish script as a detached subprocess. The shell keeps
    //    serving traffic; the script handles its own logging.
    console.log('[AppManager] seeding local OCI registry with @aura/* packages...');
    const { spawn } = await import('node:child_process');
    const child = spawn('pnpm', ['publish:local'], {
      cwd:    '/workspace',
      stdio:  ['ignore', 'inherit', 'inherit'],
      env:    { ...process.env, AURA_REGISTRY_URL: url },
      detached: false,  // keep tied so logs flow into shell logs
    });
    child.on('exit', (code) => {
      if (code === 0) console.log('[AppManager] local registry seed: complete');
      else            console.warn(`[AppManager] local registry seed: exit ${code}`);
    });
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
    // Disabled apps refuse launches. Same error class as a missing manifest
    // so callers (HTTP layer, intent dispatcher) translate it uniformly.
    if (!this.isEnabled(appId)) throw new Error(`App ${appId} is disabled. Enable it from Settings → Apps or run \`aura app enable ${appId}\`.`);

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
    if (!this.isEnabled(appId)) throw new Error(`Service ${appId} is disabled.`);
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

    const scope = this.scopeRegistry.getById(manifest.scopeId);
    const instanceId = this.allocateInstanceId(appId, manifest.instanceMode);
    const instanceDataDir = join(scope.dataDir, 'apps', appId, instanceId);
    mkdirSync(instanceDataDir, { recursive: true });

    this.transition(instanceId, appId, 'creating', null);
    // Honor manifest.serverPort when present (currently used by
    // com.aura.registry to pin :4090 so RegistryConfig URLs stay stable).
    const port = await this.ports.allocate(instanceId, manifest.serverPort);

    try {
      const runner = this.runners[manifest.sandbox] ?? this.runners['proot'];
      const pid = await runner.spawn(instanceId, appId, port, manifest, {
        appDir:          manifest.appDir,
        instanceDataDir,
      });
      this.upsertInstance(instanceId, appId, { pid, port, startedAt: new Date(), inPool: opts.inPool, sandbox: manifest.sandbox });
      this.transition(instanceId, appId, 'created', port);

      await this.runnerOf(instanceId).callLifecycle(instanceId, 'onCreate');
      this.transition(instanceId, appId, 'starting', port);

      await this.runnerOf(instanceId).callLifecycle(instanceId, 'onStart');
      this.transition(instanceId, appId, 'started', port);

      await this.runnerOf(instanceId).callLifecycle(instanceId, 'onResume');
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

      this.runnerOf(instanceId).onExit(instanceId, (code) => this.handleUnexpectedExit(instanceId, appId, code));
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
    if (!this.runnerOf(instanceId).isRunning(instanceId)) return;
    const inst = this.instances.get(instanceId);
    if (!inst) return;
    const appId = inst.appId;
    const port = this.runnerOf(instanceId).getPort(instanceId);

    // Deregister content providers (so /api/data/<authority> stops resolving)
    this.providers.unregisterInstance(inst, this.registry.getById(appId));

    // Close all activities first (purely OS-side cleanup — app's onDestroy will run anyway)
    this.purgeActivitiesOfInstance(instanceId);

    this.transition(instanceId, appId, 'pausing', port);
    await this.runnerOf(instanceId).callLifecycle(instanceId, 'onPause').catch(() => undefined);
    this.transition(instanceId, appId, 'paused', port);

    this.transition(instanceId, appId, 'stopping', port);
    await this.runnerOf(instanceId).callLifecycle(instanceId, 'onStop').catch(() => undefined);
    this.transition(instanceId, appId, 'stopped', port);

    this.transition(instanceId, appId, 'destroying', null);
    await this.runnerOf(instanceId).callLifecycle(instanceId, 'onDestroy').catch(() => undefined);
    await this.runnerOf(instanceId).kill(instanceId);
    if (port) this.ports.release(port);
    this.transition(instanceId, appId, 'destroyed', null);

    // Clear instance after destroy
    this.runnerOf(instanceId).clearToolsDir(instanceId);
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
    const port = this.runnerOf(instanceId).getPort(instanceId);
    this.providers.unregisterInstance(inst, this.registry.getById(appId));
    this.purgeActivitiesOfInstance(instanceId);
    const killed = this.runnerOf(instanceId).forceKill(instanceId);
    if (port) this.ports.release(port);
    if (killed) {
      this.fsm.set(instanceId, 'destroyed');
      OsEventBus.emit('app:stateChanged', { instanceId, appId, state: 'destroyed', port: null });
    }
    this.runnerOf(instanceId).clearToolsDir(instanceId);
    this.instances.delete(instanceId);
    this.fsm.delete(instanceId);
    this.nextActivityNum.delete(instanceId);
  }

  async pause(instanceId: string): Promise<void> {
    if (this.fsm.get(instanceId) !== 'resumed') return;
    const inst = this.instances.get(instanceId);
    if (!inst) return;
    const port = this.runnerOf(instanceId).getPort(instanceId);
    this.transition(instanceId, inst.appId, 'pausing', port);
    await this.runnerOf(instanceId).callLifecycle(instanceId, 'onPause').catch(() => undefined);
    this.transition(instanceId, inst.appId, 'paused', port);
  }

  async resume(instanceId: string): Promise<void> {
    const state = this.fsm.get(instanceId);
    if (state !== 'paused' && state !== 'stopped') return;
    const inst = this.instances.get(instanceId);
    if (!inst) return;
    const port = this.runnerOf(instanceId).getPort(instanceId);
    this.transition(instanceId, inst.appId, 'resuming', port);
    await this.runnerOf(instanceId).callLifecycle(instanceId, 'onResume').catch(() => undefined);
    this.transition(instanceId, inst.appId, 'resumed', port);
  }

  getInstance(instanceId: string): AppInstance | undefined {
    return this.instances.get(instanceId);
  }

  /** Filesystem root where every app lives. Forwarded from AppRegistry. */
  getAppsDir(): string {
    return this.registry.getAppsDir();
  }

  /** All three scope definitions. Used by NexusManager singleton. */
  getScopeDefinitions(): ScopeDefinition[] {
    return this.scopeRegistry.getAll();
  }

  /** The ScopeRegistry instance — used by shell API endpoints. */
  getScopeRegistry(): ScopeRegistry {
    return this.scopeRegistry;
  }

  /** Per-instance data dir root. Mirror of the constructor arg. */
  getDataDir(): string {
    return this.dataDir;
  }

  /**
   * Resolve the upstream URL the shell should hit for a given instance.
   * PRoot instances live in the shell's network namespace → host is
   * '127.0.0.1'. Container instances are on the shared docker network →
   * host is the container's name (e.g. 'aura-com.aura.terminal-3').
   *
   * Used by the WS proxy + HTTP proxy. Returns null if the instance has
   * already exited or never existed.
   */
  getUpstreamUrl(instanceId: string): { host: string; port: number } | null {
    const runner = this.runnerOf(instanceId);
    const host   = runner.getHost(instanceId);
    const port   = runner.getPort(instanceId);
    if (host == null || port == null) return null;
    return { host, port };
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
    const result = await this.runnerOf(instanceId).callOptionalLifecycle(instanceId, 'onActivityCreate', { activityId, data });
    let path = '/';
    let title: string | undefined;
    let metadata: Record<string, unknown> | undefined;
    let minimizable = false;
    // Breadcrumb mode mirrors the `minimizable` pattern — app declares it
    // per-activity via the lifecycle return. Default 'os' = OS chrome shows
    // the trail; apps that want to render their own (or no) header set 'off'.
    let breadcrumb: 'os' | 'off' = 'os';
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      const obj = result as { path?: unknown; title?: unknown; metadata?: unknown; minimizable?: unknown; breadcrumb?: unknown };
      if (typeof obj.path === 'string' && obj.path.length > 0) path = obj.path;
      if (typeof obj.title === 'string') title = obj.title;
      if (obj.metadata && typeof obj.metadata === 'object') metadata = obj.metadata as Record<string, unknown>;
      if (obj.minimizable === true) minimizable = true;
      if (obj.breadcrumb === 'off' || obj.breadcrumb === 'os') breadcrumb = obj.breadcrumb;
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
      breadcrumb,
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
   * Android-style back navigation. Resolution order:
   *
   *   1. **In-activity history non-empty** → pop the top URL off
   *      `activity.history` and emit `activity:navigated { fromHistory:
   *      true }`. The iframe stays mounted; only its `src` changes. This
   *      is the canonical "navigate" launch mode, populated by
   *      `navigateActivity()`.
   *   2. **`stackParentId` set** → close this activity, refocus the
   *      parent. Original Android-stack semantics for activities that
   *      were launched on top of another.
   *   3. **Otherwise** → plain `closeActivity` (no auto-focus). Apps
   *      that want different Back semantics intercept earlier via
   *      `osClient.nav.onBack` (SDK), or the shell's `aura.nav.back`
   *      chain falls through to Nav mode.
   *
   * Idempotent: unknown activityId is a no-op.
   */
  async goBack(activityId: string): Promise<void> {
    const activity = this.activities.get(activityId);
    if (!activity) return;

    // 1) In-activity history pop. Update path AND title together so the
    //    OS chrome shows the right crumb after the pop. The popped entry's
    //    title becomes the new `activity.title` so the breadcrumb trail is
    //    a coherent walk backwards through the stack.
    if (activity.history && activity.history.length > 0) {
      const previous = activity.history[activity.history.length - 1]!;
      activity.history.pop();
      activity.path = previous.path;
      activity.title = previous.title;
      activity.lastTransitionAt = new Date();
      OsEventBus.emit('activity:navigated', {
        activityId:       activity.activityId,
        parentInstanceId: activity.parentInstanceId,
        appId:            activity.appId,
        path:             activity.path,
        history:          [...activity.history],
        breadcrumb:       activity.breadcrumb ?? 'os',
        fromHistory:      true,
        ...(activity.title !== undefined ? { title: activity.title } : {}),
      });
      return;
    }

    // 2) Stacked activity → close + refocus parent (original behavior).
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
   * "Navigate" launch mode — change the activity's iframe path in place.
   *
   * Modes:
   *   • `pushHistory: true` (default) — push the OLD path onto
   *     `activity.history` so OS Back returns to it.
   *   • `pushHistory: false` — replace the URL without recording the
   *     old one (use for redirects, error pages, anything where the
   *     prior step shouldn't be reachable via Back).
   *
   * The shell listens for `activity:navigated` and updates the existing
   * slot's iframe `src` + title without remounting — switching panels in
   * a single-activity app like Settings becomes a same-iframe transition
   * rather than a new layout slot.
   *
   * Returns true on success, false when the activity id is unknown.
   */
  navigateActivity(
    activityId: string,
    path: string,
    opts?: { title?: string; pushHistory?: boolean },
  ): boolean {
    const activity = this.activities.get(activityId);
    if (!activity) return false;
    const pushHistory = opts?.pushHistory !== false;
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    if (pushHistory && normalizedPath !== activity.path) {
      // Snapshot the OLD path+title onto history so the breadcrumb trail can
      // re-label that prior step when rendered. Apps that omit title on
      // navigate just leave the prior entry's title undefined — the OS
      // chrome falls back to the path tail in that case.
      const entry: { path: string; title?: string } = { path: activity.path };
      if (activity.title !== undefined) entry.title = activity.title;
      activity.history = [...(activity.history ?? []), entry];
    }
    activity.path = normalizedPath;
    if (opts?.title !== undefined) activity.title = opts.title;
    activity.lastTransitionAt = new Date();
    OsEventBus.emit('activity:navigated', {
      activityId:       activity.activityId,
      parentInstanceId: activity.parentInstanceId,
      appId:            activity.appId,
      path:             activity.path,
      history:          [...(activity.history ?? [])],
      breadcrumb:       activity.breadcrumb ?? 'os',
      fromHistory:      false,
      ...(activity.title !== undefined ? { title: activity.title } : {}),
    });
    return true;
  }

  /**
   * Runtime toggle for the OS-rendered breadcrumb chrome. Apps call this
   * via `osClient.activity.setBreadcrumb('off')` when they decide to take
   * over rendering (or back on with `'os'`). The chrome reacts to the
   * `activity:breadcrumbChanged` event without a navigation occurring.
   *
   * Returns true on success, false when the activity id is unknown.
   */
  setActivityBreadcrumb(activityId: string, mode: 'os' | 'off'): boolean {
    const activity = this.activities.get(activityId);
    if (!activity) return false;
    if (activity.breadcrumb === mode) return true;
    activity.breadcrumb = mode;
    activity.lastTransitionAt = new Date();
    OsEventBus.emit('activity:breadcrumbChanged', {
      activityId:       activity.activityId,
      parentInstanceId: activity.parentInstanceId,
      appId:            activity.appId,
      breadcrumb:       mode,
    });
    return true;
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

    await this.runnerOf(parentInstanceId).callOptionalLifecycle(parentInstanceId, `onActivityDestroy/${encodeURIComponent(activityId)}`);

    this.activities.delete(activityId);
    OsEventBus.emit('activity:closed', { activityId, parentInstanceId, appId });

    // Auto-Stop: last activity closed and instance is not a background service
    const manifest = this.registry.getById(appId);
    if (
      manifest &&
      !manifest.backgroundService &&
      this.getActivitiesByInstance(parentInstanceId).length === 0 &&
      this.runnerOf(parentInstanceId).isRunning(parentInstanceId)
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
        // Liveness probe depends on sandbox: PRoot instances live in the
        // shell's PID namespace so `process.kill(pid, 0)` works; container
        // instances have HOST pids invisible from inside aura-shell — that
        // call would always ESRCH and false-positive "dead", triggering a
        // wrongful forceKill. Defer to the runner instead, which tracks
        // its own liveness via docker wait.
        if (inst.sandbox === 'container') {
          alive = this.runnerOf(inst.instanceId).isRunning(inst.instanceId);
        } else {
          try { process.kill(pid, 0); alive = true; }
          catch { alive = false; }
        }
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
          try { this.runnerOf(inst.instanceId).forceKill(inst.instanceId); } catch { /* runner may already have evicted it */ }
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
    // Union pids from both runners so the reconciler doesn't mistake an
    // in-flight container-spawn for a dead PRoot (or vice versa).
    for (const r of Object.values(this.runners)) {
      for (const pid of r.getActivePids()) trackedPids.add(pid);
    }
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
        const manifest = this.registry.getById(inst.appId);
        if (!manifest) continue; // app uninstalled mid-run; skip
        const res = await fetch(`http://localhost:${inst.port}${lifecyclePath(manifest, inst.instanceId, 'health')}`, {
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
    const port = this.runnerOf(instanceId).getPort(instanceId);
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
