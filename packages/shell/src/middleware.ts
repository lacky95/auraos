import { defineMiddleware } from 'astro:middleware';
import { getAppManager, initAppManager, ContextStore, VolumeStore } from '@aura/core';
// Namespace import: a live reload of this file must not 500 every request
// when the running shell still caches a core build without the export.
import * as core from '@aura/core';
import { kvServer, defaultKv } from '@aura/kv-store';
import { bootstrapKv } from './lib/kvBootstrap.js';
import { ensureSdkPublished } from './lib/sdkBootstrap.js';
import { startOnboarding, noteClientConnected, type OnboardingHandle } from './lib/onboarding/index.js';
import { loadCustomInterfaces } from './lib/customInterfaces.js';

// Source of truth is the singleton on globalThis — NOT a module-scoped flag.
// The soft-restart endpoint deletes that singleton; if we tracked init state
// here separately, we'd skip re-bootstrap on the next request and every page
// would 500 with "AppManager not initialized" until the container bounced.
let initPromise: Promise<void> | null = null;

async function ensureAppManager() {
  try { getAppManager(); return; }
  catch { /* singleton missing — bootstrap below */ }

  // Single-threaded event loop: the `??=` plus the `try`/`catch` above run
  // synchronously, so concurrent requests share one in-flight init promise.
  initPromise ??= (async () => {
    // Embedded Valkey MUST come up before AppManager.init() because AppManager
    // starts services + auto-starts apps, both of which may want to read OS
    // state (theme, workspaces) from the KV. `kvServer.start()` is idempotent
    // so a stale singleton across soft-restarts is a no-op.
    const dataDir = process.env['AURA_DATA_DIR'] ?? '/data';
    await kvServer.start({ dataDir: `${dataDir}/kv` });
    // A fresh install has no OS state yet — onboarding welcomes only those.
    let freshInstall = false;
    try {
      const kv = defaultKv();
      try { freshInstall = !(await kv.exists('os', 'theme')); }
      finally { await kv.close().catch(() => undefined); }
    } catch { /* treat as an existing install */ }
    // Migrate /data/settings.json (legacy Settings storage) into Valkey on
    // first boot; subsequent boots see `os/theme` already in Valkey and
    // skip this entirely. Idempotent.
    await bootstrapKv({ dataDir });

    // Minimal admin auth: make sure the shared operator credential exists
    // (<dataDir>/aura/secrets/admin.key, 0600, master container only). The
    // secret itself is NEVER logged — only where to read it.
    try {
      const auth = core.getAuthServices?.();
      const r = auth?.admin.ensure();
      if (r?.created) {
        console.log(`[auth] created the AuraOS admin credential at ${r.keyFile} — read it in the master container: \`aura jump -m\`, then \`aura admin credential\``);
      }
    } catch (err) {
      console.warn(`[middleware] admin credential setup failed: ${(err as Error).message}`);
    }

    // Notifications (store in the same Valkey): start the expiry sweeper.
    // Idempotent; a failure must never block boot.
    try {
      core.getNotificationService?.().start();
    } catch (err) {
      console.warn(`[middleware] notification service start failed: ${(err as Error).message}`);
    }

    // Onboarding (lib/onboarding): the "Setting up AuraOS" card and the
    // welcome checklist. Starts BEFORE init(): it checks the `aura-base`
    // image every container app runs from and builds it in the background
    // when missing (container spawns wait for it). Needs the notification
    // service above. Never blocks boot beyond one KV read.
    let onboarding: OnboardingHandle | null = null;
    try {
      onboarding = await startOnboarding({
        dataDir,
        toolchainDir: process.env['AURA_TOOLCHAIN_DIR'] ?? '/os/toolchain',
        freshInstall,
      });
    } catch (err) {
      console.warn(`[middleware] onboarding start failed: ${(err as Error).message}`);
    }

    // Materialise Aura Context (env/secret) files from Valkey BEFORE apps start,
    // so the /run/context volume-subpath mount source exists and holds current
    // values on the very first spawn. Idempotent; prunes files for deleted keys.
    try {
      await new ContextStore(dataDir).materializeAll();
    } catch (err) {
      console.warn(`[middleware] context materialize failed: ${(err as Error).message}`);
    }
    // Ensure Context Volume subpath dirs exist BEFORE apps start, so their
    // volume-subpath mounts / proot binds don't fail on a missing source.
    try {
      await new VolumeStore(dataDir).ensureAll();
    } catch (err) {
      console.warn(`[middleware] context volumes ensure failed: ${(err as Error).message}`);
    }

    const mgr = initAppManager({
      appsDir:      process.env['AURA_APPS_DIR']      ?? '/workspace/apps',
      dataDir:      process.env['AURA_DATA_DIR']      ?? '/data',
      baseRootfs:   process.env['AURA_BASE_ROOTFS']   ?? '/os/base-rootfs',
      toolchainDir: process.env['AURA_TOOLCHAIN_DIR'] ?? '/os/toolchain',
      portStart:    Number(process.env['AURA_APP_PORT_START'] ?? 4001),
      portEnd:      Number(process.env['AURA_APP_PORT_END']   ?? 4999),
      shellPort:    Number(process.env['AURA_SHELL_PORT']     ?? 3000),
    });
    // Hydrate per-app enable state BEFORE init() so its autoStart / warmPool
    // / service-spawn loops skip disabled apps from the very first tick.
    // Stored under os/app-enabled; missing keys default to enabled (so newly
    // scaffolded apps come online without any migration).
    try {
      const kv = defaultKv();
      try {
        const state = await kv.getValue<Record<string, boolean>>('os', 'app-enabled');
        if (state) mgr.setEnabledState(state);
      } finally {
        await kv.close().catch(() => undefined);
      }
    } catch (err) {
      console.warn(`[middleware] could not hydrate app-enabled state: ${(err as Error).message}`);
    }
    // User-registered external interfaces live in KV; the registry only
    // projects them (see lib/customInterfaces.ts).
    try {
      mgr.interfaces.setCustom(await loadCustomInterfaces());
    } catch (err) {
      console.warn(`[middleware] could not hydrate custom interfaces: ${(err as Error).message}`);
    }
    await mgr.init();

    // Seed the local OCI registry with @aura/* AFTER init(), because init() is
    // what starts com.aura.registry (autoStart + critical) — before this point
    // nothing is listening on 4090. Detached and non-fatal: user/global-scope
    // apps need these packages to resolve `auraDependencies` at first launch,
    // but an OS that can't reach its registry should still boot. Onboarding
    // runs it (lib/sdkBootstrap.ts) so a first boot can show its progress.
    if (onboarding) onboarding.afterInit();
    else void ensureSdkPublished();
  })();
  try { await initPromise; }
  finally { initPromise = null; }  // future soft-restart can trigger another cycle
}

export const onRequest = defineMiddleware(async (ctx, next) => {
  await ensureAppManager();
  const res = await next();
  // A shell tab registering itself: onboarding cards wait for the first one,
  // because only notifications that arrive while a tab listens pop up.
  if (ctx.request.method === 'POST' && ctx.url.pathname === '/api/os/clients' && res.ok) noteClientConnected();
  return res;
});
