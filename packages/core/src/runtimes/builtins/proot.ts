/**
 * The `proot` runtime (ARI §4.1, Q1, Q18b, ARI-1): ptrace-wrapped processes
 * (ProotRunner). `placement: master` (the default) runs them in the master
 * container, narrowed (Phase 5 R2): app identity, no `/workspace` beyond the
 * shared packages, no `/run/context`, no socket, the App Home, a per-instance
 * `/tmp`. `pool` (one shared runner container, Q19) is not built in this
 * release: asking for it fails clearly and never falls back to master
 * (Phase 5b owner answer 2).
 *
 * PRoot never runs an app unwrapped (D75): without the `proot-host` switch
 * (`AURA_USE_PROOT`, D92) or the base rootfs it is unavailable, and a start
 * fails closed. `useProot` is not read (Q17).
 */
import type { SandboxRunner } from '../../app-manager/SandboxRunner.js';
import { prootUnavailable } from '../../app-manager/ProotRunner.js';
import type { RuntimeModule } from '../registry.js';
import { RuntimeSettingsError } from '../settingsSchema.js';
import type { RuntimeSettings } from '../types.js';

/** The one refusal of `placement: pool` (settings and starts): no fallback to master. */
export const PROOT_POOL_UNAVAILABLE = 'the pool placement is not available in this release (the PRoot pool comes with '
  + 'Phase 5-post); nothing falls back to the master placement';

export interface ProotRuntimeOpts {
  baseRootfs: string;
  env?: Record<string, string | undefined>;
}

export function prootRuntime(runner: SandboxRunner, opts: ProotRuntimeOpts): RuntimeModule {
  const env = opts.env ?? process.env;
  return {
    descriptor: {
      id: 'proot',
      title: 'PRoot',
      description: 'Lightweight ptrace sandbox. Fast cold start, weak isolation: read-only binds are not enforced, '
        + 'so closed apps cannot run on it (ARI-4); apps run under their own app identity only; no sidecars, '
        + 'cross-app mounts or port expose; instances end with the shell and are respawned.',
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
    },
    runner,
    capabilities: (settings: RuntimeSettings) => runner.capabilities(settings),
    unavailable: (settings: RuntimeSettings) => {
      if (settings['placement'] === 'pool') return PROOT_POOL_UNAVAILABLE;
      return prootUnavailable(env, opts.baseRootfs);
    },
    checkSettings: (settings: RuntimeSettings) => {
      if (settings['placement'] === 'pool') throw new RuntimeSettingsError(PROOT_POOL_UNAVAILABLE);
    },
  };
}
