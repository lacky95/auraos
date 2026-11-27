/**
 * The server layer's start of the kernel (Phase 6 K, D73/D76/D78): calls the
 * one `bootSystem()` (core `system/bootstrap.ts`) with this layer's hooks.
 * Started eagerly, never by a request:
 *   - production: `server.mjs` imports the build's `aura-boot.mjs` (this file,
 *     emitted as its own entry by `astro.config.mjs`) before it loads the
 *     request handler;
 *   - dev: the `aura-boot` Vite plugin imports it through the SSR runner at
 *     server start, so it shares the module graph with the middleware.
 *
 * Server-layer hooks run in both compositions; Web Shell hooks only in
 * `desktop` (`AURA_COMPOSITION`). Register new boot work here, never in the
 * middleware.
 */
import * as core from '@aura/core';
import type { BootEntry, BootHook, SystemHandle } from '@aura/core';
import { accessMode } from '../../server/access-mode.mjs';
import { isDeveloperMode, migrateSystemModeFile, systemMode, type SystemModeMigration } from './systemMode.ts';
import { startOnboarding, type OnboardingHandle } from './onboarding/index.js';
import { ensureSdkPublished } from './sdkBootstrap.js';
import { installRelaySigner, type RelaySigner } from './access/relay.ts';

// D89 B4: the relay claim signer for the WS proxy and App Hosts (server/access-bridge.mjs
// `relayClaimOf`), from module load: this module loads at boot, before any request.
installRelaySigner(() => { try { return core.getAppManager() as unknown as RelaySigner; } catch { return null; } });

let onboarding: OnboardingHandle | null = null;
/** Phase 6 G (D60): written before anything reads the mode (bootSystem `early`); audited once the KV is up. */
let modeMigration: SystemModeMigration | null = null;

export const SHELL_BOOT_HOOKS: readonly BootHook[] = [
  {
    name: 'system-mode-migration-audit', layer: 'server', phase: 'beforeApps',
    run: async () => {
      if (!modeMigration) return;
      await core.getAuthServices().audit.record({
        by: { kind: 'system' }, action: 'system-mode.migrated', target: 'system:mode', outcome: 'ok', detail: { ...modeMigration },
      });
    },
  },
  // Before the apps: the `aura-base` image every container app runs from (built in the
  // background when missing; container spawns wait for it) and the onboarding card.
  {
    name: 'onboarding', layer: 'server', phase: 'beforeApps',
    run: async (ctx) => {
      onboarding = await startOnboarding({
        dataDir: ctx.dataDir,
        toolchainDir: process.env['AURA_TOOLCHAIN_DIR'] ?? '/os/toolchain',
        freshInstall: ctx.freshInstall,
      });
    },
  },
  // Phase 6 O: the effective capability registry (release + the owner's entries) at
  // /data/aura/overlay/capabilities.yaml, before any app container mounts it (lib/capabilities.ts).
  {
    name: 'capability-overlay', layer: 'server', phase: 'beforeApps',
    run: async () => { await (await import('./capabilities.js')).writeCapabilityOverlay(); },
  },
  // The access observer (lib/access/observer.ts) registers the `aura.access` bridge, so App
  // Host and WS surfaces of a Headless system are decided before any API call (risk R2).
  { name: 'access-observer', layer: 'server', run: async () => { await import('./access/observer.ts'); } },
  // capabilities.json against the toolchain init just restored from the volume mirror
  // (lib/capabilities.ts reconcileCapabilities); the owner's registry is read through KV.
  { name: 'capability-reconcile', layer: 'server', run: async () => { await (await import('./capabilities.js')).reconcileCapabilities(); } },
  // D102: hold notices whose approval ended while the shell was down. Best effort.
  {
    name: 'approval-hold-notices', layer: 'server',
    run: async () => { const m = await import('./approvals/service.js'); await m.reconcileHoldNotices(m.liveApprovalDeps()); },
  },
  // Terminal session grants whose session ended while the shell was down (server/terminal-embed.mjs).
  {
    name: 'terminal-grant-sweep', layer: 'server',
    run: async () => { await (await import('../../server/terminal-embed.mjs')).sweepLiveSessionGrants(); },
  },
  // Seed the local OCI registry with @aura/* after init() started com.aura.registry; the
  // onboarding shows its progress on a first boot. Detached and non-fatal.
  {
    name: 'sdk-publish', layer: 'server',
    run: () => { if (onboarding) onboarding.afterInit(); else void ensureSdkPublished(); },
  },
  // After Settings → About → Update / Rebuild: build the apps that changed (lib/appBuilds.ts).
  { name: 'app-build-pass', layer: 'server', run: async () => { (await import('./appBuilds.js')).scheduleAppBuildPass(); } },
  // Phase 6 U: a finished release job is audited and announced once; an abandoned hold is announced.
  {
    name: 'release-report', layer: 'server',
    run: async () => { const m = await import('./release/releaseAdmin.ts'); await m.reportReleaseJobs(m.liveReleaseDeps()); },
  },
  // Pre-registered Nexus sources (lib/nexusSeeds.ts): through the shell's own KV API.
  { name: 'nexus-seeds', layer: 'server', run: async () => { await (await import('./nexusSeedsApply.js')).applySourceSeeds(); } },
  // Web Shell: reopen the windows of before the restart on the re-adopted / restarted instances,
  // then auto-save the desktop; a stop saves it (lib/desktopSession.ts).
  {
    name: 'desktop-session', layer: 'webshell',
    run: async () => { await (await import('./desktopSession.js')).restoreDesktopSession(); },
    shutdown: async () => { await (await import('./desktopSession.js')).shutdownForSignal(); },
  },
];

/** Start the kernel once per process (idempotent: a second call returns the same handle). */
export function bootShell(entry: BootEntry): SystemHandle {
  return core.bootSystem({
    entry,
    hooks: [...SHELL_BOOT_HOOKS],
    // A checkout install with no mode file keeps developer (D60), before anything reads the mode.
    early: () => { modeMigration = migrateSystemModeFile(); },
    developerMode: isDeveloperMode,
    systemMode: () => systemMode(),
    accessMode: () => accessMode(),
    handleSignals: true,
  });
}
