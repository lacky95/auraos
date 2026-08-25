/**
 * Where a user's HOME lives on disk.
 *
 * Homes live under one root, one dir per identity — the same shape as /home
 * on any Unix box:
 *
 *     <dataDir>/aura/home/<id>
 *
 * `<id>` is a user id, defaulting to DEFAULT_USER_ID ('default') — AuraOS's
 * first user, the same id ScopeRegistry already uses for the user scope. Real
 * multi-user therefore needs no migration and no new concept: a second user
 * is a second dir, and the only work left is threading a real `userId` down
 * from whoever owns the instance instead of taking the default.
 *
 * Why this dir and not the sandbox's own filesystem: a container's writable
 * layer and the PRoot base-rootfs are both IMAGE layers, discarded on every
 * rebuild, recreate, or host reboot that recreates the container. Anything a
 * tool keeps in HOME — `claude` logins and session history, `gh auth`, ssh
 * keys, shell history, per-tool caches and dotfiles — dies with them. The
 * dataDir is the app-data volume, which survives all of that, so backing HOME
 * with it makes tool state persist for EVERY tool at once. That generality is
 * the point: there is no per-tool list of "paths worth keeping" to maintain,
 * and a tool installed tomorrow is covered without anyone touching the OS.
 *
 * The MASTER container's home is deliberately NOT this dir — see
 * {@link masterHomeDir}. Apps belong to a user; the master is the OS.
 */
import { join } from 'node:path';
import { DEFAULT_USER_ID } from './ScopeRegistry.js';

/** Root of all homes, as a subpath inside the app-data volume. */
export const HOMES_ROOT_SUBPATH = 'aura/home';

/**
 * The master's id within the homes root. Reserved — a user may not be called
 * this, or their home would collide with the OS's.
 */
export const MASTER_HOME_ID = 'master';

/**
 * Subpath INSIDE the app-data volume holding one identity's home. Docker's
 * `--mount volume-subpath=` needs this form, which is why it is exposed
 * separately from the absolute path below. Always POSIX-separated: it is a
 * mount argument, not a filesystem path.
 */
export function homeSubpathFor(id: string): string {
  return `${HOMES_ROOT_SUBPATH}/${id}`;
}

/** Absolute path of one identity's home as seen from the master container. */
export function homeDirFor(dataDir: string, id: string): string {
  return join(dataDir, ...HOMES_ROOT_SUBPATH.split('/'), id);
}

/** Subpath of a user's home (see {@link homeSubpathFor}). */
export function userHomeSubpath(userId: string = DEFAULT_USER_ID): string {
  return homeSubpathFor(userId);
}

/** Absolute path of a user's home. */
export function userHomeDir(dataDir: string, userId: string = DEFAULT_USER_ID): string {
  return homeDirFor(dataDir, userId);
}

/**
 * The master container's home — a sibling of the user homes, never one of
 * them.
 *
 * `aura-shell` is not a sandbox and not a user: it is the OS process. What
 * lands in its HOME is operator state about running AuraOS itself (an `aura
 * jump --master` shell history, a `claude` login used to work ON the OS), not
 * the state of the person using the apps. Mixing the two would push
 * OS-maintenance state into every app sandbox and let any app read or clobber
 * it. Same philosophy as a user home — one dir, persistent, on the volume,
 * mounted at /home/<id> — different identity.
 *
 * It isn't just /root for the usual reason: /root is an image layer, so a
 * rebuild or recreate throws the operator's tool state away.
 */
export function masterHomeDir(dataDir: string): string {
  return homeDirFor(dataDir, MASTER_HOME_ID);
}

/** Where the master container's own home is mounted (a symlink, see Dockerfile). */
export const MASTER_HOME_PATH = `/home/${MASTER_HOME_ID}`;

/**
 * Pre-multi-user home location: a single `aura/home/user` dir shared by every
 * app container, from before homes were keyed by user id. Kept only so
 * AppManager can migrate an existing install onto the layout above; nothing
 * should mount it.
 */
export function legacySharedHomeDir(dataDir: string): string {
  return join(dataDir, 'aura', 'home', 'user');
}
