/**
 * `bootSystem()`: the kernel's one bootstrap and composition root, order half
 * (Phase 6 K; D73, D76, D77, D78, D85 A2; D97). Construction lives in
 * `system/compose.ts`. The server layer starts it eagerly: `server.mjs`
 * before it serves, the dev server plugin at startup; never a request (D78).
 *
 * Order (the golden test `test/bootstrap-order.test.mjs` pins it):
 *   1. A2: the system identity first (no KV needed; `status.json` carries
 *      `systemId` from its first write), then the `early` step (mode file);
 *   2. the embedded Valkey, the KV seed, the retired admin credential, the
 *      notification sweeper;
 *   3. `beforeApps` hooks (base-image readiness, the onboarding card);
 *   4. Context materialize, volumes ensure;
 *   5. the app manager: enable state (owned by AppManager, hydrated in its
 *      init), custom interfaces (D98 R2: built-ins, then the record), then
 *      `init()` (adoption, boot reconciliation, respawn, services);
 *   6. ready: `kernelReadyAt`, then the `ready` hooks, server layer first, Web
 *      Shell hooks only in the `desktop` composition.
 *
 * The handle is pinned on globalThis (`aura.system`): the shell's Vite source
 * copy of core and the `dist` copy are two module instances, and both must
 * find the one boot (the AppManager pin it replaces as the init signal).
 */
import { kvServer, defaultKv, defaultRedis, closeSharedRedis } from '@aura/kv-store';
import { ensureSystemIdentity } from './systemIdentity.js';
import { bootstrapKv } from './kvBootstrap.js';
import { BOOTSTRAP_VERSION, writeBootStatus } from './status.js';
import { composeKernel, createSetupEngine, homeEnvironmentPort, privateHomeForSpawn } from './compose.js';
import type {
  BootHook, BootHookContext, BootOptions, BootStatus, Composition, ShutdownReason, SystemHandle,
} from './types.js';
import { OsEventBus } from '../ipc/OsEventBus.js';
import { getAppManager, initAppManager, type AppManager } from '../app-manager/AppManager.js';
import { getAuthServices, retireSharedAdminCredential } from '../auth/services.js';
import { getAppHostServices } from '../app-hosts/services.js';
import { getNotificationService } from '../notifications/NotificationService.js';
import { ContextStore } from '../context/ContextStore.js';
import { VolumeStore } from '../context/VolumeStore.js';
import { scanContractSources } from '../contract/sourceScan.js';
import { loadCustomInterfaces } from '../interfaces/custom.js';
import { ThemeManager } from '../theme/ThemeManager.js';
import { DEFAULT_WORKSPACE_STATE } from '../types/workspace.js';
import { migrateUserData } from '../users/userData.js';
import { DEFAULT_OWNER_ID } from '../auth/identityContracts.js';

const SYSTEM_KEY = Symbol.for('aura.system');
/** Docker stops after 10 s; the kernel shutdown stays under it. */
export const SHUTDOWN_BUDGET_MS = 8_000;
/** Of which the hooks (the desktop save) get at most this much. */
export const SHUTDOWN_HOOKS_MS = 3_000;

interface SystemState {
  handle: SystemHandle;
  opts: BootOptions & { dataDir: string; composition: Composition };
  status: BootStatus;
  hooks: BootHook[];
  ctx: BootHookContext;
  ready: boolean;
  stopping: Promise<void> | null;
  readyAt: Map<string, string>;
}
type G = typeof globalThis & { [SYSTEM_KEY]?: SystemState };

const now = () => new Date().toISOString();

/** The running system, or null before `bootSystem()` ran in this process. */
export function getSystem(): SystemHandle | null {
  return (globalThis as G)[SYSTEM_KEY]?.handle ?? null;
}

/** The composition this process serves: `AURA_COMPOSITION`, default `desktop` (D76; D64 entry `composition`). */
export function compositionFromEnv(env: NodeJS.ProcessEnv = process.env): Composition {
  return env['AURA_COMPOSITION'] === 'server' ? 'server' : 'desktop';
}

/**
 * Boot the kernel once per process. Idempotent: a second call (another module
 * copy, a hot-swapped build) gets the same handle; its hooks are added.
 */
export function bootSystem(options: BootOptions): SystemHandle {
  const g = globalThis as G;
  const existing = g[SYSTEM_KEY];
  if (existing) {
    for (const h of options.hooks ?? []) existing.handle.onReady(h);
    return existing.handle;
  }
  composeKernel();
  const dataDir = options.dataDir ?? process.env['AURA_DATA_DIR'] ?? '/data';
  const composition = options.composition ?? compositionFromEnv();
  const opts = { ...options, dataDir, composition };
  const status: BootStatus = {
    v: 1, bootstrapVersion: BOOTSTRAP_VERSION, pid: process.pid,
    systemId: null, identity: { ok: false },
    entry: opts.entry, composition, release: null,
    systemMode: safe(() => opts.systemMode?.() ?? null, null),
    startedAt: now(), kernelReadyAt: null,
    acceptingWrites: true, acceptingWritesAt: null,
    appManagers: 0, kv: { embedded: true, version: null },
    accessMode: safe(() => opts.accessMode?.() ?? null, null),
    services: {}, firstRequestAt: null, hooks: {}, infra: null,
  };
  let resolveReady!: () => void;
  let rejectReady!: (err: Error) => void;
  const ready = new Promise<void>((res, rej) => { resolveReady = res; rejectReady = rej; });
  ready.catch(() => undefined); // observed through status(); no unhandled rejection
  const state: SystemState = {
    handle: null as unknown as SystemHandle, opts, status, hooks: [...(opts.hooks ?? [])],
    ctx: { dataDir, freshInstall: false, composition }, ready: false, stopping: null, readyAt: new Map(),
  };
  state.handle = {
    ready,
    isReady: () => state.ready,
    status: () => ({ ...state.status, services: { ...state.status.services }, hooks: { ...state.status.hooks } }),
    onReady: (hook) => {
      state.hooks.push(hook);
      if (state.ready && (hook.phase ?? 'ready') === 'ready') void runHook(state, hook);
    },
    shutdown: (reason = 'stop') => shutdownSystem(reason),
    restartKernel: () => restartKernel(),
    noteFirstRequest: () => {
      if (state.status.firstRequestAt) return;
      state.status.firstRequestAt = now();
      save(state);
    },
  };
  g[SYSTEM_KEY] = state;
  if (opts.handleSignals) installSignalHandlers();
  void (async () => {
    try {
      if (opts.kernel) {
        await opts.kernel(state.ctx);
        state.status.kernelReadyAt = now();
        save(state);
      } else {
        await bootKernel(state, { first: true });
      }
      state.ready = true;
      resolveReady();
      if (!opts.kernel) watchServices(state);
      for (const layer of ['server', 'webshell'] as const) {
        for (const hook of state.hooks) {
          if ((hook.phase ?? 'ready') === 'ready' && hook.layer === layer) void runHook(state, hook);
        }
      }
    } catch (err) {
      state.status.error = (err as Error).message;
      save(state);
      console.error(`[boot] kernel boot failed: ${(err as Error).stack ?? err}`);
      rejectReady(err as Error);
    }
  })();
  return state.handle;
}

function safe<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch { return fallback; }
}

function save(state: SystemState): void {
  writeBootStatus(state.opts.dataDir, state.status);
}

/** A Web Shell hook runs only in the `desktop` composition (D76). */
function hookApplies(state: SystemState, hook: BootHook): boolean {
  return hook.layer === 'server' || state.opts.composition === 'desktop';
}

async function runHook(state: SystemState, hook: BootHook): Promise<void> {
  if (!hookApplies(state, hook)) return;
  try {
    await hook.run(state.ctx);
    state.status.hooks[hook.name] = { layer: hook.layer, ok: true, at: now() };
  } catch (err) {
    console.warn(`[boot] ${hook.layer} hook ${hook.name} failed: ${(err as Error).message}`);
    state.status.hooks[hook.name] = { layer: hook.layer, ok: false, at: now(), error: (err as Error).message };
  }
  save(state);
}

/** Steps 1–5; `first: false` is the soft restart (identity, KV and seeds are already up). */
async function bootKernel(state: SystemState, { first }: { first: boolean }): Promise<void> {
  const { dataDir } = state.opts;
  const st = state.status;
  if (first) {
    // 1. A2 (D85): the identity first. Never blocks boot: a broken system.json is reported.
    try {
      st.systemId = ensureSystemIdentity(dataDir).systemId;
      st.identity = { ok: true };
      console.log(`[boot] system identity ${st.systemId}`);
    } catch (err) {
      st.identity = { ok: false, error: (err as Error).message };
      console.warn(`[boot] system identity unavailable: ${(err as Error).message}`);
    }
    save(state);
    try { state.opts.early?.(dataDir); }
    catch (err) { console.warn(`[boot] early step failed: ${(err as Error).message}`); }
    st.systemMode = safe(() => state.opts.systemMode?.() ?? null, st.systemMode);

    // 2. Embedded Valkey before anything reads OS state.
    await kvServer.start({ dataDir: `${dataDir}/kv` });
    try {
      const kv = defaultKv();
      try { state.ctx.freshInstall = !(await kv.exists('os', 'theme')); }
      finally { await kv.close().catch(() => undefined); }
    } catch { /* treat as an existing install */ }
    st.kv.version = await valkeyVersion();
    await bootstrapKv({
      dataDir,
      deps: {
        theme: {
          themeIdDark: ThemeManager.DEFAULT_THEME_ID_DARK,
          themeIdLight: ThemeManager.DEFAULT_THEME_ID_LIGHT,
          colorMode: ThemeManager.DEFAULT_COLOR_MODE,
        },
        workspaces: DEFAULT_WORKSPACE_STATE,
        migrateUserData: (kv, dir) => migrateUserData(kv as never, { ownerId: DEFAULT_OWNER_ID, dataDir: dir }),
      },
    });
    // D50: the shared admin credential is retired; never blocks boot.
    try { void retireSharedAdminCredential(getAuthServices(), dataDir); }
    catch (err) { console.warn(`[boot] retiring the admin credential failed: ${(err as Error).message}`); }
    // Notifications: the expiry sweeper. A failure never blocks boot.
    try { getNotificationService().start(); }
    catch (err) { console.warn(`[boot] notification service start failed: ${(err as Error).message}`); }

    // 3. Before the apps: the base-image readiness (container spawns wait for it).
    for (const hook of state.hooks) {
      if (hook.phase === 'beforeApps') await runHook(state, hook);
    }

    // 4. Context files and volume dirs before any spawn mounts them.
    try { await new ContextStore(dataDir).materializeAll(); }
    catch (err) { console.warn(`[boot] context materialize failed: ${(err as Error).message}`); }
    try { await new VolumeStore(dataDir).ensureAll(); }
    catch (err) { console.warn(`[boot] context volumes ensure failed: ${(err as Error).message}`); }
  }

  // 5. The app manager.
  const mgr = initAppManager({
    appsDir:      process.env['AURA_APPS_DIR']      ?? '/workspace/apps',
    dataDir,
    baseRootfs:   process.env['AURA_BASE_ROOTFS']   ?? '/os/base-rootfs',
    toolchainDir: process.env['AURA_TOOLCHAIN_DIR'] ?? '/os/toolchain',
    portStart:    Number(process.env['AURA_APP_PORT_START'] ?? 4001),
    portEnd:      Number(process.env['AURA_APP_PORT_END']   ?? 4999),
    shellPort:    Number(process.env['AURA_SHELL_PORT']     ?? 3000),
    // Collaborators handed in (D97): never imported by Execution.
    contractScan: scanContractSources,
    auth: getAuthServices,
    appHosts: getAppHostServices,
    // D108: the setup engine (its start gate, the setup API's service).
    setup: (m) => createSetupEngine(m, { home: homeEnvironmentPort(m) }),
    // D107-a (D108 P9): the Private Home of a start, from the setup's effective configuration.
    privateHome: privateHomeForSpawn(() => getAppManager()),
    ...(state.opts.developerMode ? { developerMode: state.opts.developerMode } : {}),
    probeIdmappedMounts: true,
  });
  st.appManagers = 1;
  // D98 R2: the registry's built-ins come from the manifests; then the custom record.
  try { mgr.interfaces.setCustom(await loadCustomInterfaces()); }
  catch (err) { console.warn(`[boot] could not hydrate custom interfaces: ${(err as Error).message}`); }
  await mgr.init();
  st.kernelReadyAt = now();
  st.acceptingWritesAt ??= st.kernelReadyAt;
  delete st.error;
  refreshServices(state, mgr);
  console.log(`[boot] kernel ready (${state.opts.entry}, ${state.opts.composition})`);
}

async function valkeyVersion(): Promise<string | null> {
  try {
    const info = await defaultRedis().info('server');
    return info.match(/^valkey_version:(\S+)/m)?.[1] ?? info.match(/^redis_version:(\S+)/m)?.[1] ?? null;
  } catch { return null; }
}

/** Services as `status.json` reports them: every `service` app's instance state. */
function refreshServices(state: SystemState, mgr: AppManager): void {
  const services: BootStatus['services'] = {};
  for (const inst of mgr.getAllInstances()) {
    if (mgr.getManifest(inst.appId)?.componentType !== 'service') continue;
    if (inst.state === 'resumed' && !state.readyAt.has(inst.appId)) state.readyAt.set(inst.appId, now());
    if (inst.state !== 'resumed') state.readyAt.delete(inst.appId);
    const readyAt = state.readyAt.get(inst.appId);
    services[inst.appId] = { state: inst.state, ...(readyAt ? { readyAt } : {}) };
  }
  state.status.services = services;
  save(state);
}

function watchServices(state: SystemState): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  OsEventBus.on('app:stateChanged', () => {
    if ((globalThis as G)[SYSTEM_KEY] !== state || timer || state.stopping) return;
    timer = setTimeout(() => {
      timer = null;
      try { refreshServices(state, getAppManager()); } catch { /* restarting */ }
    }, 250);
    timer.unref?.();
  });
}

/**
 * Soft restart: dispose the app manager and run the kernel part again with
 * this module copy's code (the soft-restart route imports the fresh copy).
 * Running instances are the caller's (the route stops them first).
 */
export async function restartKernel(): Promise<void> {
  const state = (globalThis as G)[SYSTEM_KEY];
  if (!state) throw new Error('the kernel is not booted');
  state.ready = false;
  try { getAppManager().dispose(); } catch { /* none */ }
  delete (globalThis as Record<string, unknown>)['__aura_app_manager__'];
  state.status.kernelReadyAt = null;
  save(state);
  await bootKernel(state, { first: false });
  state.ready = true;
}

/**
 * One kernel shutdown sequence (D77): the hooks (the desktop save; Web Shell
 * first), the reconciler, the notification sweeper, the KV connection and
 * the embedded Valkey; `status.json` gets `stoppedAt`. Container workloads
 * keep running and are adopted at the next boot; the PRoot respawn record
 * is frozen first (5b RS). Bounded by SHUTDOWN_BUDGET_MS.
 */
export function shutdownSystem(reason: ShutdownReason = 'stop'): Promise<void> {
  const state = (globalThis as G)[SYSTEM_KEY];
  if (!state) return Promise.resolve();
  state.stopping ??= (async () => {
    state.status.stoppingAt = now();
    state.status.stopReason = reason;
    save(state);
    const steps = (async () => {
      const hooks = [...state.hooks.filter((h) => h.layer === 'webshell'), ...state.hooks.filter((h) => h.layer === 'server')]
        .filter((h) => h.shutdown && hookApplies(state, h));
      await bounded((async () => {
        for (const h of hooks) {
          try { await h.shutdown!(); }
          catch (err) { console.warn(`[boot] shutdown hook ${h.name} failed: ${(err as Error).message}`); }
        }
      })(), SHUTDOWN_HOOKS_MS);
      // The respawn record keeps what ran on non-surviving runtimes (no-op if a hook already froze it).
      OsEventBus.emit('os:shuttingDown', { restore: true, graceMs: 0 });
      try { getAppManager().dispose(); } catch { /* never booted */ }
      try { getNotificationService().stop(); } catch { /* not started */ }
      await closeSharedRedis().catch(() => undefined);
      await kvServer.stop().catch(() => undefined);
    })();
    await bounded(steps, SHUTDOWN_BUDGET_MS - 500);
    state.ready = false;
    state.status.stoppedAt = now();
    save(state);
    console.log(`[boot] kernel stopped (${reason})`);
  })();
  return state.stopping;
}

/** Wait for `p`, at most `ms` (the timer is cleared, so nothing lingers after the race). */
async function bounded(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([p.catch(() => undefined), new Promise((r) => { timer = setTimeout(r, ms); })]);
  clearTimeout(timer);
}

let signalsInstalled = false;
/** SIGTERM / SIGINT run the one shutdown sequence, then exit 0 (docker stop). */
function installSignalHandlers(): void {
  if (signalsInstalled) return;
  signalsInstalled = true;
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, () => {
      void shutdownSystem('stop').finally(() => process.exit(0));
    });
  }
}
