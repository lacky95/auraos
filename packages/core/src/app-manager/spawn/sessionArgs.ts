/**
 * The System Terminal as a user's session host (Phase 5 stream T, D69).
 *
 * A Terminal instance belongs to one user, from its spawn on (a warm-pool
 * member is warmed for its user, D58/D78). Its container gets:
 *
 *   AURA_SESSION_USER=<userId>   the user whose sessions it hosts: its servers
 *                                serve that user only (the shell's relay claim
 *                                must name them), its session list is theirs
 *   --tmpfs /run/aura-term       the tmux socket directory, owned by the
 *                                session uid, 0700, gone with the container
 *                                (tmux-control.ts `-S /run/aura-term/<uid>/tmux.sock`)
 *
 *   AURA_SERVER_SEALED=1         the production build only, from the
 *                                execute-only node (non-dumpable server)
 *   /run/aura-secret             the lifecycle token as a one-time file
 *
 * Nothing for any other app. The uid itself, the capability drop and the
 * passwd come from the session identity (identityArgs.ts).
 */
import { chmodSync, chownSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SpawnIdentity } from '../../identity/types.js';
import { terminalNetworkUser } from './networkArgs.js';

/** Where the tmux socket directory of a session host is mounted. */
export const TERMINAL_RUN_DIR = '/run/aura-term';

/** A safe user id: what the identity registry accepts (no separator, no option syntax). */
const USER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Where a session host's server finds its lifecycle token once (then removes it): never in its env. */
export const SESSION_SECRET_DIR = '/run/aura-secret';
export const SESSION_SECRET_FILE = `${SESSION_SECRET_DIR}/lifecycle-token`;

/** The shell-side directory of that file, relative to the root dataDir (mounted alone at SESSION_SECRET_DIR). */
export function sessionSecretSubpath(instanceId: string): string {
  return `aura/runtime/${instanceId}/secret`;
}

type SessionCtx = { appDir: string; owner?: string; identity?: SpawnIdentity | null };

/** The user a System Terminal container hosts sessions for, or null (any other app, or a same-id copy). */
export function sessionHostUser(appId: string, ctx: SessionCtx): string | null {
  // The session identity names its user (a pool member's too); else the owner N's network uses.
  const user = terminalNetworkUser(appId, ctx) === null ? null : ctx.identity?.userId ?? terminalNetworkUser(appId, ctx);
  return user && USER_ID_RE.test(user) ? user : null;
}

/**
 * The session host's args: its user, the tmux socket tmpfs, a sealed
 * production server (AURA_SERVER_SEALED: the build only, the execute-only
 * node; provisioning.ts), and its lifecycle token as a one-time file
 * (AURA_LIFECYCLE_TOKEN_FILE in a 0700 directory of the session uid, which
 * the server reads and removes at start; the runner leaves the token out of
 * the container env). Empty for every other app.
 */
export function terminalSessionArgs(
  appId: string, ctx: SessionCtx, opts?: { appDataVolume: string; instanceId: string },
): string[] {
  const user = sessionHostUser(appId, ctx);
  if (!user) return [];
  const uid = ctx.identity?.uid ?? 0;
  const gid = ctx.identity?.gid ?? 0;
  return [
    '-e', `AURA_SESSION_USER=${user}`,
    '--tmpfs', `${TERMINAL_RUN_DIR}:rw,nosuid,nodev,noexec,mode=0700,uid=${uid},gid=${gid}`,
    '-e', 'AURA_SERVER_SEALED=1',
    ...(opts ? [
      '--mount', `type=volume,source=${opts.appDataVolume},target=${SESSION_SECRET_DIR},volume-subpath=${sessionSecretSubpath(opts.instanceId)}`,
      '-e', `AURA_LIFECYCLE_TOKEN_FILE=${SESSION_SECRET_FILE}`,
    ] : []),
  ];
}

/**
 * Writes a session host's lifecycle token for its server to take once:
 * `<dataDir>/aura/runtime/<inst>/secret/lifecycle-token`, the directory 0700
 * and the file 0400, both the session uid's (the server unlinks it). And the
 * kernel's own copy, `…/<inst>/lifecycle-token.kernel`, root 0600, never
 * mounted: a shell restart re-learns the token from it (the container env no
 * longer has it). Atomic writes; a symlink in the way is refused.
 */
export function writeSessionSecret(dataDir: string, instanceId: string, token: string, id: { uid: number; gid: number }): void {
  const base = join(dataDir, 'aura', 'runtime', instanceId);
  mkdirSync(base, { recursive: true, mode: 0o755 });
  const dir = join(dataDir, sessionSecretSubpath(instanceId));
  const st = (() => { try { return lstatSync(dir); } catch { return null; } })();
  if (st && (st.isSymbolicLink() || !st.isDirectory())) throw new Error(`${instanceId}: its secret directory is not a directory`);
  if (!st) mkdirSync(dir, { mode: 0o700 });
  chownSync(dir, id.uid, id.gid);
  chmodSync(dir, 0o700);
  const write = (path: string, mode: number, uid: number, gid: number) => {
    const tmp = `${path}.tmp-${process.pid}`;
    rmSync(tmp, { force: true });
    writeFileSync(tmp, token, { mode, flag: 'wx' });
    chownSync(tmp, uid, gid);
    chmodSync(tmp, mode);
    renameSync(tmp, path);
  };
  write(join(dir, 'lifecycle-token'), 0o400, id.uid, id.gid);
  write(join(base, 'lifecycle-token.kernel'), 0o600, 0, 0);
}

/** The kernel's copy of a session host's lifecycle token (adoption after a shell restart), or undefined. */
export function readKernelSessionSecret(dataDir: string, instanceId: string): string | undefined {
  try {
    const p = join(dataDir, 'aura', 'runtime', instanceId, 'lifecycle-token.kernel');
    const st = lstatSync(p);
    if (!st.isFile() || st.uid !== 0) return undefined;
    return readFileSync(p, 'utf-8').trim() || undefined;
  } catch { return undefined; }
}
