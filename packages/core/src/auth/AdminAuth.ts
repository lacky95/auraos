/**
 * AdminAuth — the shared operator credential, kept as the recovery path.
 *
 *   credential  <dataDir>/aura/secrets/admin.key (see adminCredential.ts)
 *   unlock      credential → 15-minute `shared-key` login session, not renewed.
 *               Sessions live in `LoginSessionStore`, but their MAC key comes
 *               from this credential, so recovery works without identity.key.
 *
 * Sent as `Authorization: Bearer aura-admin1.…` — never as a cookie, because
 * the shell proxy forwards request headers (and cookies) to app upstreams.
 *
 * Rotation (`aura admin rotate` in the master container) rewrites the key
 * file. The session fingerprint stops matching at once; the next check here
 * also purges the shared-key sessions and reports it through `onRotated`
 * (audit). Password sessions are not affected.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Redis } from '@aura/kv-store';
import { ensureAdminCredential, readAdminCredential } from './adminCredential.js';
import {
  LoginSessionStore, SHARED_KEY_SESSION_PREFIX, SHARED_KEY_SESSION_TTL_MS,
} from './LoginSessionStore.js';

export const ADMIN_SESSION_PREFIX = SHARED_KEY_SESSION_PREFIX;
export const ADMIN_SESSION_TTL_MS = SHARED_KEY_SESSION_TTL_MS;
const FAILED_UNLOCKS_PER_MINUTE = 30;

export interface AdminSession {
  sessionId: string;
  expiresAt: number;
}

export type UnlockResult =
  | ({ ok: true; token: string } & AdminSession)
  | { ok: false; reason: 'invalid' | 'rate-limited' | 'no-credential' };

export interface AdminAuthOptions {
  keyFile: string;
  redis: () => Redis;
  /** Defaults to `identity.key` next to `keyFile`. */
  identityKeyFile?: string;
  now?: () => number;
  ttlMs?: number;
  /** Called once when a changed key file is detected (after sessions were purged). */
  onRotated?: (purged: number) => void;
}

interface Loaded {
  credential: string;
  sessionKey: Buffer;
  fp: string;
  stamp: string;
}

function sha256(s: string): Buffer {
  return createHash('sha256').update(s).digest();
}

export function looksLikeAdminSession(s: string): boolean {
  return s.startsWith(`${ADMIN_SESSION_PREFIX}.`);
}

export class AdminAuth {
  readonly keyFile: string;
  /** The one login-session store, shared with password logins. */
  readonly sessions: LoginSessionStore;
  private readonly redis: () => Redis;
  private readonly now: () => number;
  readonly ttlMs: number;
  private readonly onRotated?: (purged: number) => void;
  private loaded: Loaded | null = null;

  constructor(opts: AdminAuthOptions) {
    this.keyFile = opts.keyFile;
    this.redis = opts.redis;
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? ADMIN_SESSION_TTL_MS;
    this.onRotated = opts.onRotated;
    this.sessions = new LoginSessionStore({
      identityKeyFile: opts.identityKeyFile ?? join(dirname(opts.keyFile), 'identity.key'),
      redis: opts.redis,
      now: this.now,
      sharedKey: () => {
        const cur = this.load();
        return cur ? { fingerprint: cur.fp, macKey: cur.sessionKey } : null;
      },
    });
  }

  /** Create the credential file when missing (first shell start). Never returns the secret. */
  ensure(): { created: boolean; keyFile: string } {
    const r = ensureAdminCredential(this.keyFile);
    this.load();
    return { ...r, keyFile: this.keyFile };
  }

  private stamp(): string | null {
    try { const st = statSync(this.keyFile); return `${st.mtimeMs}:${st.size}:${st.ino}`; }
    catch { return null; }
  }

  /** Current credential material; reloads (and handles rotation) when the file changed. */
  private load(): Loaded | null {
    const stamp = this.stamp();
    if (!stamp) { this.loaded = null; return null; }
    if (this.loaded && this.loaded.stamp === stamp) return this.loaded;
    const credential = readAdminCredential(this.keyFile);
    if (!credential) { this.loaded = null; return null; }
    const prev = this.loaded;
    const next: Loaded = {
      credential,
      sessionKey: createHmac('sha256', credential).update('aura-login-session/shared-key/v1').digest(),
      fp: sha256(credential).toString('hex').slice(0, 12),
      stamp,
    };
    this.loaded = next;
    if (prev && prev.credential !== credential) {
      void this.sessions.revokeByMethod('shared-key').then((n) => this.onRotated?.(n)).catch(() => undefined);
    }
    return next;
  }

  /** Constant-time check of a presented credential. */
  verifyCredential(input: unknown): boolean {
    const cur = this.load();
    if (!cur || typeof input !== 'string' || input.length === 0 || input.length > 200) return false;
    return timingSafeEqual(sha256(input.trim()), sha256(cur.credential));
  }

  /**
   * Exchange the credential for a session token. FAILED attempts are counted
   * (30/min, then `rate-limited`); the right credential always gets through,
   * so nobody can lock the operator out by spamming wrong ones.
   */
  async unlock(credential: unknown): Promise<UnlockResult> {
    const r = this.redis();
    const cur = this.load();
    if (!cur) return { ok: false, reason: 'no-credential' };
    if (!this.verifyCredential(credential)) {
      const bucket = `ratelimit:admin-unlock-fail:${Math.floor(this.now() / 60_000)}`;
      const fails = await r.incr(bucket);
      if (fails === 1) await r.pexpire(bucket, 120_000);
      return { ok: false, reason: fails > FAILED_UNLOCKS_PER_MINUTE ? 'rate-limited' : 'invalid' };
    }
    const { token, session } = await this.sessions.issue({ method: 'shared-key', keyFingerprint: cur.fp, ttlMs: this.ttlMs });
    return { ok: true, token, sessionId: session.sessionId, expiresAt: session.expiresAt };
  }

  /** The shared-key session of a valid token, else null. Never throws on bad input. */
  async verifySession(token: string | null | undefined): Promise<AdminSession | null> {
    if (!token || !looksLikeAdminSession(token)) return null;
    const s = await this.sessions.verify(token);
    if (!s || s.method !== 'shared-key') return null;
    return { sessionId: s.sessionId, expiresAt: s.expiresAt };
  }

  /**
   * `verifySession` that can't trigger rotation handling: for the access
   * report. It uses the loaded credential and answers null if the file changed.
   */
  async peekSession(token: string | null | undefined): Promise<AdminSession | null> {
    const cur = this.loaded;
    if (!token || !looksLikeAdminSession(token) || !cur || this.stamp() !== cur.stamp) return null;
    const s = await this.sessions.peekShared(token, { fingerprint: cur.fp, macKey: cur.sessionKey });
    return s ? { sessionId: s.sessionId, expiresAt: s.expiresAt } : null;
  }

  /** Revoke one session (lock). */
  lock(sessionId: string): Promise<boolean> {
    return this.sessions.revoke(sessionId);
  }
}
