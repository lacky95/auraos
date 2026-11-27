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
import { startFlightService } from './lib/flight/service.js';
import { captureAccess, createAccessReporter } from './lib/access/guard.ts';
import { GATEWAY_IDENTITY_HEADER } from '@aura/core/host-rules';
import { shellFramePolicy } from './lib/desktop/shellFramePolicy.ts';
import { runAfterResponse } from './lib/afterResponse.ts';
import { installRelaySigner, type RelaySigner } from './lib/access/relay.ts';

// D89 B4: the relay claim signer for the WS proxy and App Hosts (server/access-bridge.mjs `relayClaimOf`).
installRelaySigner(() => { try { return getAppManager() as unknown as RelaySigner; } catch { return null; } });

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

    // D47: this Aura's permanent systemId and key pair, created on first
    // boot. Never blocks boot: a broken system.json is reported and the
    // identity stays absent until the operator fixes it.
    try {
      const { systemId } = core.ensureSystemIdentity(dataDir);
      console.log(`[middleware] system identity ${systemId}`);
    } catch (err) {
      console.warn(`[middleware] system identity unavailable: ${(err as Error).message}`);
    }

    // D50: the shared admin credential is retired. Its leftover sessions go;
    // admin.key stays on disk, unused, until a later release removes it.
    // Never blocks boot.
    try {
      void core.retireSharedAdminCredential(core.getAuthServices(), dataDir);
    } catch (err) {
      console.warn(`[middleware] retiring the admin credential failed: ${(err as Error).message}`);
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
      // Stream C: the Context migration's source scan (System Management), handed to the kernel here (D97: no app-manager -> contract import).
      contractScan: core.scanContractSources,
      // 5b K: the identity, user, grant and audit services, handed in (D97: no app-manager -> auth/services import).
      auth: core.getAuthServices,
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

    // Terminal session grants whose session ended while the shell was down
    // (server/terminal-embed.mjs). Detached: it asks each running Terminal.
    setTimeout(() => {
      import('../server/terminal-embed.mjs')
        .then((m) => m.sweepLiveSessionGrants())
        .catch((err) => console.warn(`[middleware] terminal grant sweep failed: ${(err as Error).message}`));
    }, 0);

    // Seed the local OCI registry with @aura/* AFTER init(), because init() is
    // what starts com.aura.registry (autoStart + critical) — before this point
    // nothing is listening on 4090. Detached and non-fatal: user/global-scope
    // apps need these packages to resolve `auraDependencies` at first launch,
    // but an OS that can't reach its registry should still boot. Onboarding
    // runs it (lib/sdkBootstrap.ts) so a first boot can show its progress.
    if (onboarding) onboarding.afterInit();
    else void ensureSdkPublished();

    // Pre-registered Nexus sources: sources.d/*.json seed files and
    // AURA_NEXUS_SOURCES (lib/nexusSeeds.ts). Detached + after this init, since
    // it goes through the shell's own KV API; loaded lazily so a broken seed
    // module can never block boot.
    // Desktop session (lib/desktopSession.ts): reopen the windows of before
    // the restart on the re-adopted / restarted instances and remap the
    // workspaces; auto-save of the desktop starts only after that. Detached,
    // like the seeds below: it goes through the AppManager this init built.
    setTimeout(() => {
      import('./lib/desktopSession.js')
        .then((m) => m.restoreDesktopSession())
        .catch((err) => console.warn(`[middleware] desktop session restore failed: ${(err as Error).message}`));
    }, 0);

    // After Settings → About → Update / Rebuild: build the apps that changed
    // and switch them to their builds (lib/appBuilds.ts), in the background.
    import('./lib/appBuilds.js')
      .then((m) => m.scheduleAppBuildPass())
      .catch((err) => console.warn(`[middleware] app build pass not scheduled: ${(err as Error).message}`));

    setTimeout(() => {
      import('./lib/nexusSeedsApply.js')
        .then((m) => m.applySourceSeeds())
        .catch((err) => console.warn(`[middleware] nexus source seeds failed: ${(err as Error).message}`));
    }, 0);
  })();
  try { await initPromise; }
  finally { initPromise = null; }  // future soft-restart can trigger another cycle
}

let flightServiceStarted = false;

// The access report (lib/access/observer.ts): loaded on first use, and nothing it does can reach a response.
const reportAccess = createAccessReporter(() => import('./lib/access/observer.ts'));

const accessUnavailable = () => new Response(JSON.stringify({ error: 'access-unavailable' }), {
  status: 503, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});

export const onRequest = defineMiddleware(async (ctx, next) => {
  const access = captureAccess(ctx);
  await ensureAppManager();
  // Free-flight activities (lib/flight/service.ts): once per shell build —
  // a hot-swapped build takes over the previous one's listeners + notifications.
  if (!flightServiceStarted) {
    flightServiceStarted = true;
    try { startFlightService(); }
    catch (err) { console.warn(`[middleware] flight service start failed: ${(err as Error).message}`); }
  }
  // App Host gateway calls: the manifest decides here, in every access mode.
  if (ctx.request.headers.has(GATEWAY_IDENTITY_HEADER)) {
    let refused: Response | null;
    try {
      refused = await (await import('./lib/access/gatewayCaller.ts')).enforceGateway(ctx);
    } catch {
      refused = new Response(JSON.stringify({ error: 'gateway-denied' }), { status: 403, headers: { 'content-type': 'application/json' } });
    }
    if (refused) {
      // The report counts the variant the body settles (the gate below never sees this request).
      if (access) {
        try {
          const v = await (await import('./lib/access/enforce.ts')).reportBodyVariant(ctx);
          if (v !== undefined) access.bodyVariant = v;
        } catch { /* the report only */ }
      }
      reportAccess(access, refused.status);
      return refused;
    }
  }
  // Every /api route (lib/access/enforce.ts): the whole manifest in `enforce`,
  // a rule's `guard` in every mode. Fails closed.
  let gate: Awaited<ReturnType<typeof import('./lib/access/enforce.ts')['liveAccessGate']>>;
  try {
    gate = await (await import('./lib/access/enforce.ts')).liveAccessGate(ctx);
  } catch {
    reportAccess(access, 503);
    return accessUnavailable();
  }
  if (gate.identity) {
    // One verdict: the route reads it, and the report counts it.
    ctx.locals.access = gate.identity;
    if (access) access.identity.verified = gate.identity;
  }
  if (access && gate.bodyVariant !== undefined) access.bodyVariant = gate.bodyVariant;
  if (gate.refused) {
    reportAccess(access, gate.refused.status);
    return gate.refused;
  }
  reportAccess.identify(access, ctx.request);
  let res: Response;
  let status = 500;
  try {
    res = await next();
    status = res.status;
  } catch (err) {
    reportAccess(access, 500);
    throw err;
  } finally {
    // PHASE3-C: the post-response hook point (lib/afterResponse.ts), e.g. the
    // gateway's owner-action audit, with the route's final status.
    runAfterResponse(ctx.request, status);
  }
  reportAccess(access, res.status);
  // A shell tab registering itself: onboarding cards wait for the first one,
  // because only notifications that arrive while a tab listens pop up.
  if (ctx.request.method === 'POST' && ctx.url.pathname === '/api/os/clients' && res.ok) noteClientConnected();
  // The shell's own documents can't be framed (lib/desktop/shellFramePolicy.ts).
  const framePolicy = shellFramePolicy(ctx.url.pathname, res.headers.get('content-type'), res.headers.get('content-security-policy'));
  if (framePolicy) {
    try { res.headers.set('Content-Security-Policy', framePolicy); }
    catch { /* immutable headers: not a page this shell rendered */ }
  }
  return res;
});
