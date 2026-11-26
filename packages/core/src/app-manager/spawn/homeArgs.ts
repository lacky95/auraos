/**
 * `/home/aura` of an app process (Phase 5 Stage 1 extraction; stream H owns
 * this file). Today every app gets the one user home: the runners take the
 * mount from here and no longer compute a home path themselves (ARI §9.4).
 * Stream H mounts the `ResolvedHome` of the spawn context instead.
 */
import { SHARED_HOME_PATH } from '../tool-provision.js';
import { userHomeDir, userHomeSubpath } from '../../scopes/home.js';

/** `--mount` of the home, a subpath of the app-data volume. */
export function containerHomeMount(o: { appDataVolume: string }): string[] {
  return ['--mount', `type=volume,source=${o.appDataVolume},target=${SHARED_HOME_PATH},volume-subpath=${userHomeSubpath()}`];
}

/** `-e HOME=…`, after the context env so a context key can't move it. */
export function containerHomeEnv(): string[] {
  return ['-e', `HOME=${SHARED_HOME_PATH}`];
}

/** PRoot bind of the home. */
export function prootHomeBind(o: { dataDir: string }): string {
  return `--bind=${userHomeDir(o.dataDir)}:${SHARED_HOME_PATH}`;
}

/** The `HOME` a PRoot (or master-direct) app process gets. */
export const PROOT_HOME_ENV = SHARED_HOME_PATH;
