/**
 * The per-session agent-hook token (Phase 5 stream T, D69).
 *
 * Each session's shell gets `AURA_TERM_HOOK_TOKEN` in its own environment
 * (tmux `new-session -e`, never the server's env), and agent-hook.sh sends it
 * with every event (`x-aura-hook-token`). `POST /api/sessions/events`
 * refuses an event without the token of the session it names, so neither
 * another app nor another session can report agent state for a session
 * (the tokenless hook forgery).
 *
 *   token = HMAC-SHA256(key, sessionId), key = HMAC-SHA256(secret, "aura-term-hook-v1")
 *
 * The secret is this start's lifecycle token (`AURA_LIFECYCLE_TOKEN`): it
 * survives a restart of the server inside the same container, as the tmux
 * sessions do, and a new container (a new start) gets new tokens with its
 * new sessions. Without one (started by hand) a random per-process secret.
 *
 * Node builtins only: the tests import this file under --experimental-strip-types.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const HOOK_TOKEN_ENV = 'AURA_TERM_HOOK_TOKEN';
export const HOOK_TOKEN_HEADER = 'x-aura-hook-token';

const LABEL = 'aura-term-hook-v1';
let fallbackSecret: string | null = null;

function hookKey(secret: string | undefined): Buffer {
  const s = secret || (fallbackSecret ??= randomBytes(32).toString('hex'));
  return createHmac('sha256', s).update(LABEL).digest();
}

/** The hook token of one session. */
export function hookToken(sessionId: string, secret: string | undefined = process.env['AURA_LIFECYCLE_TOKEN']): string {
  return createHmac('sha256', hookKey(secret)).update(String(sessionId)).digest('base64url');
}

/** Whether `presented` is `sessionId`'s hook token (constant time). */
export function hookTokenValid(
  sessionId: string, presented: string | null | undefined, secret: string | undefined = process.env['AURA_LIFECYCLE_TOKEN'],
): boolean {
  if (!presented) return false;
  const want = Buffer.from(hookToken(sessionId, secret));
  const got = Buffer.from(String(presented));
  return got.length === want.length && timingSafeEqual(got, want);
}
