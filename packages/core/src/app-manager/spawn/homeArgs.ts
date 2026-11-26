/**
 * `/home/aura` of an app process (Phase 5 stream H). The runners mount the
 * `ResolvedHome` the kernel Home Resolver decided at spawn (homes/HomeResolver.ts)
 * and never compute a home path themselves (ARI §9.4). An app process gets its
 * App Home; a Private Home only reaches a user's own session context (D65 §8).
 *
 * Fail closed: a spawn without a resolved home, or with a home the runtime
 * can't mount (a tmpfs `ephemeral` home is a session's, never an app's), is
 * refused. Nothing falls back to the shared home.
 */
import { SHARED_HOME_PATH } from '../tool-provision.js';
import type { ResolvedHome } from '../../homes/types.js';

export class HomeMountError extends Error {
  override readonly name = 'HomeMountError';
}

function volumeHome(home: ResolvedHome | undefined): ResolvedHome & { hostPath: string; volumeSubpath: string } {
  if (!home) throw new HomeMountError('no home was resolved for this process: not started (no shared-home fallback)');
  if (!home.hostPath || !home.volumeSubpath) throw new HomeMountError(`a ${home.kind} home can't be an app process's home`);
  if (home.volumeSubpath.split('/').some((s) => s === '' || s === '.' || s === '..')) throw new HomeMountError('invalid home subpath');
  return home as ResolvedHome & { hostPath: string; volumeSubpath: string };
}

/** `--mount` of the resolved home, a subpath of the app-data volume. */
export function containerHomeMount(o: { appDataVolume: string; home: ResolvedHome | undefined }): string[] {
  const h = volumeHome(o.home);
  return ['--mount', `type=volume,source=${o.appDataVolume},target=${SHARED_HOME_PATH},volume-subpath=${h.volumeSubpath}`];
}

/** `-e HOME=…`, after the context env so a context key can't move it. */
export function containerHomeEnv(): string[] {
  return ['-e', `HOME=${SHARED_HOME_PATH}`];
}

/** PRoot bind of the resolved home. */
export function prootHomeBind(o: { home: ResolvedHome | undefined }): string {
  return `--bind=${volumeHome(o.home).hostPath}:${SHARED_HOME_PATH}`;
}
