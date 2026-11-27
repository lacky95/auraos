/**
 * The `proot` runtime module (ARI §4.1, Q1, Q18b, ARI-1; 5b PR):
 * ptrace-wrapped processes (app-manager/ProotRunner). One runtime with a
 * placement. `master` (the default) runs them in the master container,
 * narrowed (Phase 5 R2): app identity, no `/workspace` beyond the shared
 * packages, no `/run/context`, no socket, the App Home, a per-instance
 * `/tmp`. `pool` (one shared runner container, Q19) is not built in this
 * release: asking for it fails clearly and never falls back to master
 * (Phase 5b owner answer 2); its conformance rows run once it exists.
 *
 * PRoot never runs an app unwrapped (D75): without the `proot-host` switch
 * (`AURA_USE_PROOT`, D92) or the base rootfs it is unavailable, and a start
 * fails closed. `useProot` is not read (Q17).
 *
 * Groups (D100): only `tools` (local provisioning). Adoption, sessions,
 * associated workloads, mounts, endpoints, build and usage are unsupported,
 * so a request for them is refused, never emulated. Owner and diagnose
 * actions: `info`, `inspectRootfs`, `bench` (read-only), `version`,
 * `baseInstall`, `upgrade` (the admin routes authorize and audit them).
 *
 * The runner is handed in by the composition point: no runtime import of
 * app-manager code (D97).
 */
import { existsSync } from 'node:fs';
import type { SandboxRunner } from '../../app-manager/SandboxRunner.js';
import { runnerEndpoint, type RuntimeHealthCheck, type RuntimeModule } from '../ari.js';
import { hostToolsGroup, toolsFeatureOverrides, type HostToolStore, type ToolsMode } from '../hostTools.js';
import { RuntimeSettingsError } from '../settingsSchema.js';
import type { RuntimeSettings } from '../types.js';
import { prootOwnerActions } from './actions.js';
import { prootDiagnostics, prootDiagnosticsGroup } from './diagnostics.js';
import { prootOrphans } from './orphans.js';
import { PROOT_BINARIES, prootUnavailable } from './host.js';

export { prootUnavailable } from './host.js';

/** The one refusal of `placement: pool` (settings and starts): no fallback to master. */
export const PROOT_POOL_UNAVAILABLE = 'the pool placement is not available in this release (the PRoot pool comes with '
  + 'Phase 5-post); nothing falls back to the master placement';

export interface ProotRuntimeOpts {
  baseRootfs: string;
  env?: Record<string, string | undefined>;
  /** The host's tools mode (tool-provision `currentToolsMode`); absent: not reported. */
  toolsMode?: () => ToolsMode;
  /** The toolchain store (`tools.status`); absent: no library checks. */
  toolStore?: () => HostToolStore;
  /** File probe for the binary check (tests). */
  exists?: (path: string) => boolean;
}

export function prootRuntime(runner: SandboxRunner, opts: ProotRuntimeOpts): RuntimeModule {
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? existsSync;
  const toolsMode = () => opts.toolsMode?.() ?? null;
  return {
    hostSwitches: () => ({ AURA_USE_PROOT: env['AURA_USE_PROOT'] ?? null }),
    descriptor: {
      id: 'proot',
      version: '1.1.0',
      ari: 1,
      title: 'PRoot',
      description: 'Lightweight ptrace sandbox. Fast cold start, weak isolation: read-only binds are not enforced, '
        + 'so closed apps cannot run on it (ARI-4); apps run under their own app identity only; no sidecars, '
        + 'cross-app mounts or port expose; instances end with the shell and the kernel starts them again.',
      builtIn: true,
      settingsSchema: {
        type: 'object',
        properties: {
          placement: {
            type: 'string', title: 'Placement', enum: ['master', 'pool'], default: 'master',
            enumTitles: { master: 'Master (in the AuraOS container)', pool: 'Pool (a shared runner container)' },
            description: 'Where PRoot processes run. master: inside the AuraOS container, as the app\'s identity with a '
              + 'narrowed view. pool: one shared runner container with no /workspace, secrets, socket or user home '
              + '(not available yet).',
          },
        },
      },
      settingsVersion: 1,
    },
    runner,
    // Placement-aware (P-3): the network differs (`shell-netns` on the master, `bridge` in the pool).
    capabilities: (settings: RuntimeSettings) => runner.capabilities(settings),
    featureOverrides: (settings: RuntimeSettings) => toolsFeatureOverrides(runner.capabilities(settings), toolsMode()),
    // Fails closed: the pool placement, the `proot-host` switch (D92) and the base rootfs. A missing binary degrades.
    health: (settings: RuntimeSettings) => {
      if (settings['placement'] === 'pool') {
        // One reason at a time, as before: the placement refusal wins over the host's.
        return { status: 'unavailable', checks: [{ id: 'placement', ok: false, detail: PROOT_POOL_UNAVAILABLE }] };
      }
      const host = prootUnavailable(env, opts.baseRootfs);
      const checks: RuntimeHealthCheck[] = [
        { id: 'placement', ok: true },
        { id: 'proot-host', ok: host === null, ...(host ? { detail: host } : {}) },
      ];
      if (host === null) {
        const bin = PROOT_BINARIES.find((p) => exists(p));
        checks.push({ id: 'proot-binary', ok: !!bin, detail: bin ?? `no proot binary (${PROOT_BINARIES.join(', ')})` });
      }
      const status = host !== null ? 'unavailable' : checks.every((c) => c.ok) ? 'ok' : 'degraded';
      return { status, checks };
    },
    endpoint: (instanceId) => runnerEndpoint(runner, instanceId),
    checkSettings: (settings: RuntimeSettings) => {
      if (settings['placement'] === 'pool') throw new RuntimeSettingsError(PROOT_POOL_UNAVAILABLE);
    },
    ...(runner.capabilities({}).hostFilesystem ? { tools: hostToolsGroup(runner, toolsMode, () => opts.toolStore?.() ?? null) } : {}),
    diagnostics: prootDiagnosticsGroup(opts.baseRootfs),
    orphans: prootOrphans,
    actions: Object.freeze({ ...prootDiagnostics(opts.baseRootfs), ...prootOwnerActions(opts.baseRootfs) }),
  };
}
