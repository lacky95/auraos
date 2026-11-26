/**
 * The `proot` runtime (ARI §4.1, Q1, Q18b): ptrace-wrapped processes
 * (ProotRunner). `placement: master` (the default) runs them in the master
 * container; `pool` (one shared runner container, Q19) comes with stream R2
 * and is refused until then.
 *
 * PRoot never runs an app unwrapped (D75): without `AURA_USE_PROOT=true` or
 * the base rootfs it is unavailable, and a start fails closed instead of
 * running the app directly in the kernel's container. `useProot` is not read
 * (Q17).
 */
import { existsSync } from 'node:fs';
import type { SandboxRunner } from '../../app-manager/SandboxRunner.js';
import type { RuntimeModule } from '../registry.js';
import { RuntimeSettingsError } from '../settingsSchema.js';
import type { RuntimeSettings } from '../types.js';

const POOL_NOT_YET = 'the pool placement is not available in this release (it comes with the PRoot pool, Phase 5 R2)';

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
        + 'so closed apps cannot run on it (ARI-4); no sidecars, cross-app mounts or port expose; instances end with '
        + 'the shell and are respawned.',
      builtIn: true,
      settingsSchema: {
        type: 'object',
        properties: {
          placement: {
            type: 'string', title: 'Placement', enum: ['master', 'pool'], default: 'master',
            enumTitles: { master: 'Master (in the AuraOS container)', pool: 'Pool (a shared runner container)' },
            description: 'Where PRoot processes run. master: inside the AuraOS container. pool: one shared runner '
              + 'container with no /workspace, secrets, socket or user home (not available yet).',
          },
        },
      },
    },
    runner,
    capabilities: (settings: RuntimeSettings) => runner.capabilities(settings),
    unavailable: (settings: RuntimeSettings) => {
      if (settings['placement'] === 'pool') return POOL_NOT_YET;
      if (env['AURA_USE_PROOT'] !== 'true') return 'AURA_USE_PROOT is not true on this AuraOS, and PRoot never runs an app unwrapped';
      if (!existsSync(opts.baseRootfs)) return `the base rootfs (${opts.baseRootfs}) is missing`;
      return null;
    },
    checkSettings: (settings: RuntimeSettings) => {
      if (settings['placement'] === 'pool') throw new RuntimeSettingsError(POOL_NOT_YET);
    },
  };
}
