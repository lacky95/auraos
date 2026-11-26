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
 * Nothing for any other app. The uid itself, the capability drop and the
 * passwd come from the session identity (identityArgs.ts).
 */
import type { SpawnIdentity } from '../../identity/types.js';
import { terminalNetworkUser } from './networkArgs.js';

/** Where the tmux socket directory of a session host is mounted. */
export const TERMINAL_RUN_DIR = '/run/aura-term';

/** A safe user id: what the identity registry accepts (no separator, no option syntax). */
const USER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function terminalSessionArgs(appId: string, ctx: { appDir: string; owner?: string; identity?: SpawnIdentity | null }): string[] {
  // The session identity names its user (a pool member's too); else the owner N's network uses.
  const user = terminalNetworkUser(appId, ctx) === null ? null : ctx.identity?.userId ?? terminalNetworkUser(appId, ctx);
  if (!user || !USER_ID_RE.test(user)) return [];
  const uid = ctx.identity?.uid ?? 0;
  const gid = ctx.identity?.gid ?? 0;
  return [
    '-e', `AURA_SESSION_USER=${user}`,
    '--tmpfs', `${TERMINAL_RUN_DIR}:rw,nosuid,nodev,noexec,mode=0700,uid=${uid},gid=${gid}`,
  ];
}
