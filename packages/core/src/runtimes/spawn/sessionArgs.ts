/**
 * The System Terminal as a user's session host (Phase 5 stream T, D69; T2).
 *
 * A Terminal instance belongs to one user, from its spawn on (a warm-pool
 * member is warmed for its user, D58/D78). Its server runs under the
 * non-login service uid `aura-terminal` (TERMINAL_SERVICE_UID, owner decision
 * 2026-11-27), its sessions (tmux, the shells) as the user's uid/gid with the
 * Private Home; the container's command is the session launcher
 * (os/term-launch: `serve`, root with SETUID/SETGID only, spawn/identityArgs.ts),
 * which starts the server as the service uid and runs what the server asks
 * as the user, for the server only. Its container gets:
 *
 *   AURA_SESSION_USER=<userId>   the user whose sessions it hosts: its servers
 *                                serve that user only (the shell's relay claim
 *                                must name them), its session list is theirs
 *   AURA_SESSION_UID=<uid>       that user's uid (the tmux socket path)
 *   --tmpfs /run/aura-term/<uid> the tmux socket directory, owned by the
 *                                session uid, 0700 (tmux-control.ts
 *                                `-S /run/aura-term/<uid>/tmux.sock`): the
 *                                server never connects to it, only the user's
 *                                own tmux clients do (through the launcher)
 *   --tmpfs /run/aura-term-server the server's own runtime dir (pane-tap
 *                                FIFOs), the service uid's, 0711
 *   AURA_SESSION_HOST=1          the production build only (no dev server)
 *   AURA_TERM_TMUX_BIN           the launcher's `aura-term-tmux`: every tmux
 *                                command the server runs, runs as the user
 *   /run/aura-secret             the lifecycle token as a one-time file of the
 *                                service uid (the user can't read it, not even
 *                                before the server takes it)
 *   aura.session-identity label  the session uid:gid (adoption: the container's
 *                                own user is 0)
 *
 * Nothing for any other app. The passwd (with the service account) comes
 * from the session identity (identityArgs.ts). Before the owner's Private Home
 * is handed over (the deploy window, a root identity) the Terminal runs as
 * root without the launcher, as before.
 */
import { chmodSync, chownSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TERMINAL_SERVICE_GID, TERMINAL_SERVICE_UID, type SpawnIdentity } from '../../identity/types.js';
import { isSessionIdentity } from './identityArgs.js';
import { terminalNetworkUser } from './networkArgs.js';

/** Where the tmux socket directory of a session host is mounted. */
export const TERMINAL_RUN_DIR = '/run/aura-term';

/** A safe user id: what the identity registry accepts (no separator, no option syntax). */
const USER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** The server's own runtime dir (service uid, 0711): pane-tap FIFOs the user's tmux writes into. */
export const TERMINAL_SERVER_RUN_DIR = '/run/aura-term-server';

/** The session launcher in aura-base (Dockerfile; os/term-launch) and its tmux alias. */
export const TERM_LAUNCH_BIN = '/usr/local/libexec/aura-term-launch';
export const TERM_TMUX_BIN = '/usr/local/libexec/aura-term-tmux';

/** The label that records a session host's session uid:gid (the container itself runs as 0). */
export const SESSION_IDENTITY_LABEL = 'aura.session-identity';

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
 * The session host's args (see the header). Empty for every other app. With
 * a session identity the server runs as the service uid through the launcher
 * (terminalSessionCommand); with root (the owner's Terminal inside the deploy
 * window) it runs as root, as before T2.
 */
export function terminalSessionArgs(
  appId: string, ctx: SessionCtx, opts?: { appDataVolume: string; instanceId: string },
): string[] {
  const user = sessionHostUser(appId, ctx);
  if (!user) return [];
  const id = ctx.identity;
  const secret = opts ? [
    '--mount', `type=volume,source=${opts.appDataVolume},target=${SESSION_SECRET_DIR},volume-subpath=${sessionSecretSubpath(opts.instanceId)}`,
    '-e', `AURA_LIFECYCLE_TOKEN_FILE=${SESSION_SECRET_FILE}`,
  ] : [];
  if (!id || !isSessionIdentity(id)) {
    return [
      '-e', `AURA_SESSION_USER=${user}`,
      '--tmpfs', `${TERMINAL_RUN_DIR}:rw,nosuid,nodev,noexec,mode=0700,uid=0,gid=0`,
      '-e', 'AURA_SESSION_HOST=1',
      ...secret,
    ];
  }
  return [
    '-e', `AURA_SESSION_USER=${user}`,
    '-e', `AURA_SESSION_UID=${id.uid}`,
    '--label', `${SESSION_IDENTITY_LABEL}=${id.uid}:${id.gid}`,
    '--tmpfs', `${TERMINAL_RUN_DIR}/${id.uid}:rw,nosuid,nodev,noexec,mode=0700,uid=${id.uid},gid=${id.gid}`,
    '--tmpfs', `${TERMINAL_SERVER_RUN_DIR}:rw,nosuid,nodev,noexec,mode=0711,uid=${TERMINAL_SERVICE_UID},gid=${TERMINAL_SERVICE_GID}`,
    '-e', 'AURA_SESSION_HOST=1',
    '-e', `AURA_TERM_TMUX_BIN=${TERM_TMUX_BIN}`,
    '-e', `AURA_TERM_LAUNCH=${TERM_LAUNCH_BIN}`,
    '-e', `AURA_TERM_TAP_DIR=${TERMINAL_SERVER_RUN_DIR}/tap`,
    ...secret,
  ];
}

/**
 * A session host's container command (stream T2): the launcher, which starts
 * `entrypoint` as the service uid and serves the server's session requests as
 * the user. Unchanged for every other app and for a root Terminal.
 */
export function terminalSessionCommand(appId: string, ctx: SessionCtx, entrypoint: string[]): string[] {
  const id = ctx.identity;
  if (!sessionHostUser(appId, ctx) || !id || !isSessionIdentity(id)) return entrypoint;
  return [
    TERM_LAUNCH_BIN, 'serve',
    '--service', `${TERMINAL_SERVICE_UID}:${TERMINAL_SERVICE_GID}`,
    '--user', `${id.uid}:${id.gid}`,
    '--', ...entrypoint,
  ];
}

/** Who owns a session host's server-side files (the token file, its data dir): the service uid, or root before T2's identity. */
export function sessionServerOwner(identity: SpawnIdentity | null | undefined): { uid: number; gid: number } {
  return identity && isSessionIdentity(identity) ? { uid: TERMINAL_SERVICE_UID, gid: TERMINAL_SERVICE_GID } : { uid: 0, gid: 0 };
}

/**
 * Writes a session host's lifecycle token for its server to take once:
 * `<dataDir>/aura/runtime/<inst>/secret/lifecycle-token`, the directory 0700
 * and the file 0400, both the server's (sessionServerOwner: the service uid,
 * never the session user's; the server unlinks it). And the
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
