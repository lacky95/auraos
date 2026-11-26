// Namespace import, as in auth.ts: the running shell may cache an older core build.
import * as core from '@aura/core';
import type { AccessPrincipal } from '@aura/core';
import { loadAppHostServices } from '../../server/app-host-auth.mjs';
import { gatewayClaimOf } from '../../server/gateway-identity.mjs';

/**
 * The sign-in a long-lived response (an event stream) rides on, so it can end
 * with it. A stream is authorised once, when it opens; without this it would
 * keep delivering after a logout, "sign out other sessions" or a password
 * reset.
 *
 *   App Host gateway claim with a session  → that owner session (the frame's cookie)
 *   user (login cookie or `aura-sess1.` bearer, or D45) → its login session
 *   anything else                           → nothing to follow (null)
 *
 * The check fails closed: a store that can't be read ends the stream, and
 * the client reconnects through the normal checks.
 */
export interface StreamSession {
  /** Whether the session is still live. Never throws. */
  live(): Promise<boolean>;
}

export interface StreamSessionDeps {
  sessionLive(sid: string, userId: string): Promise<boolean>;
}

const liveDeps: StreamSessionDeps = {
  sessionLive: async (sid, userId) => {
    const svc = await loadAppHostServices();
    return !!svc && !!(await svc.sessionLive(sid, userId));
  },
};

const check = (fn: () => Promise<unknown>): StreamSession => ({
  live: async () => { try { return !!(await fn()); } catch { return false; } },
});

/** The session this request's stream follows, or null when it rides on none. */
export function streamSessionOf(
  request: Request, principal: AccessPrincipal | null, deps: StreamSessionDeps = liveDeps,
): StreamSession | null {
  const claim = gatewayClaimOf(request);
  if (claim) {
    const sid = claim.owner?.sid ?? claim.sid;
    const userId = claim.owner?.userId ?? claim.userId;
    return typeof sid === 'string' && sid && typeof userId === 'string' && userId
      ? check(() => deps.sessionLive(sid, userId))
      : null;
  }
  return principalSession(principal, deps);
}

/** The login session a verified principal rides on: a user's, else none. */
function principalSession(principal: AccessPrincipal | null, deps: StreamSessionDeps): StreamSession | null {
  if (principal?.kind !== 'user') return null;
  const { sessionId, userId } = principal;
  return check(() => deps.sessionLive(sessionId, userId));
}

/**
 * Calls `end` once, as soon as `session` is no longer live: checked on every
 * session revocation (core `auth:sessionsRevoked`) and whenever `recheck()`
 * is called (the stream's heartbeat, which also catches expiry). Returns the
 * stream's handle; `stop()` unsubscribes.
 */
export function followSession(session: StreamSession, end: () => void): { recheck(): void; stop(): void } {
  let done = false;
  const recheck = () => {
    if (done) return;
    void session.live().then((ok) => {
      if (ok || done) return;
      stop();
      end();
    });
  };
  const onRevoked = () => recheck();
  const stop = () => {
    done = true;
    core.OsEventBus.off('auth:sessionsRevoked', onRevoked);
  };
  core.OsEventBus.on('auth:sessionsRevoked', onRevoked);
  return { recheck, stop };
}

/** How often a socket rechecks its session (expiry); a revocation ends it at once. */
export const SOCKET_RECHECK_MS = 60_000;

/**
 * followSession for a long-lived socket of the `.mjs` servers (M4): the
 * socket.io `/os-events` connection, an App Host upgrade (the Terminal PTY),
 * the WebSocket proxy. They reach it through the access bridge
 * (access-bridge.mjs `followIdentity`) with the verdict they were let in on.
 * Null when that rides on no session.
 */
export function followSocket(
  principal: AccessPrincipal | null, end: () => void, deps: StreamSessionDeps = liveDeps,
): { stop(): void } | null {
  const session = principalSession(principal, deps);
  if (!session) return null;
  const following = followSession(session, end);
  const timer = setInterval(following.recheck, SOCKET_RECHECK_MS);
  timer.unref?.();
  return { stop() { clearInterval(timer); following.stop(); } };
}
