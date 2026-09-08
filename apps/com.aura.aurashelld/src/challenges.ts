/**
 * Confirmation codes for stop/kill.
 *
 * Ending a process is the one destructive thing this MCP does, so it is a
 * two-step call: the first returns a short code and the question to put to
 * the user; the second carries the code back. A code is bound to one
 * instance AND one mode (a "stop" code cannot kill), is single-use, and dies
 * after two minutes. Module scope survives the stateless per-request MCP
 * servers; a restart of this service clears the table, and the agent simply
 * asks again.
 */
import { randomBytes } from 'node:crypto';

export const CHALLENGE_TTL_MS = 120_000;

/** No 0/O/1/I: the code is read aloud or retyped by a person. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

interface Issued { instanceId: string; mode: 'stop' | 'kill'; expiresAt: number }
const issued = new Map<string, Issued>();

function sweep(now: number): void {
  for (const [code, c] of issued) if (c.expiresAt <= now) issued.delete(code);
}

export function issueChallenge(instanceId: string, mode: 'stop' | 'kill', now = Date.now()): string {
  sweep(now);
  let code: string;
  do {
    const bytes = randomBytes(6);
    code = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
  } while (issued.has(code));
  issued.set(code, { instanceId, mode, expiresAt: now + CHALLENGE_TTL_MS });
  return code;
}

export type Verdict = { ok: true } | { ok: false; reason: 'unknown' | 'expired' | 'mismatch' };

/** Consumes the code on success. */
export function verifyChallenge(code: string, instanceId: string, mode: 'stop' | 'kill', now = Date.now()): Verdict {
  const key = String(code ?? '').trim().toUpperCase();
  const c = issued.get(key);
  if (!c) return { ok: false, reason: 'unknown' };
  if (c.expiresAt <= now) { issued.delete(key); return { ok: false, reason: 'expired' }; }
  if (c.instanceId !== instanceId || c.mode !== mode) return { ok: false, reason: 'mismatch' };
  issued.delete(key);
  return { ok: true };
}

export function _resetForTests(): void { issued.clear(); }
