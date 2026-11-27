/**
 * Whether this host can run the PRoot runtime at all (D75, D92): the
 * `proot-host` switch (`AURA_USE_PROOT`) and the base rootfs. PRoot never runs
 * an app unwrapped instead. Owned by the PRoot module (5b PR); the runner
 * asks it too, so the runner never does it either.
 */
import { existsSync } from 'node:fs';
import { PROOT_HOST, securityEnvValue } from '../../security/options.js';

export function prootUnavailable(env: Record<string, string | undefined>, baseRootfs: string): string | null {
  if (securityEnvValue(PROOT_HOST, env) !== true) {
    return 'AURA_USE_PROOT is not true on this AuraOS (security option proot-host), and PRoot never runs an app unwrapped';
  }
  if (!existsSync(baseRootfs)) return `the base rootfs (${baseRootfs}) is missing`;
  return null;
}

/** Where the PRoot binary is looked for (a source build in /usr/local first, then the distribution's). */
export const PROOT_BINARIES: readonly string[] = ['/usr/local/bin/proot', '/usr/bin/proot'];
