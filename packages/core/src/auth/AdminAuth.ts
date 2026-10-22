/**
 * AdminAuth — minimal admin authentication with ONE shared operator
 * credential (no user accounts).
 *
 *   credential  <dataDir>/aura/secrets/admin.key (see adminCredential.ts)
 *   unlock      credential → short-lived session token
 *                 aura-admin1.<b64url {s: sessionId, e: expiresAt, f: keyFp}>.<b64url HMAC>
 *               HMAC key = HMAC-SHA256(credential, 'aura-admin-session/v1'),
 *               so rotating the credential invalidates every token.
 *   nonce       adminsess:<sessionId> in Valkey with the same TTL — `lock`
 *               (DELETE) revokes one session before it expires.
 *   TTL         15 minutes, not renewed.
 *
 * Sent as `Authorization: Bearer aura-admin1.…` — never as a cookie, because
 * the shell proxy forwards request headers (and cookies) to app upstreams.
 *
 * Rotation (`aura admin rotate` in the master container) rewrites the key
 * file; the next check here notices the changed file, purges all sessions and
 * reports it through `onRotated` (audit).
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { statSync } from 'node:fs';
import type { Redis } from '@aura/kv-store';
import { ensureAdminCredential, readAdminCredential } from './adminCredential.js';

export const ADMIN_SESSION_PREFIX = 'aura-admin1';
export const ADMIN_SESSION_TTL_MS = 15 * 60_000;
export const adminSessionKey = (sid: string) => `adminsess:${sid}`;
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
      sessionKey: createHmac('sha256', credential).update('aura-admin-session/v1').digest(),
      fp: sha256(credential).toString('hex').slice(0, 12),
      stamp,
    };
    this.loaded = next;
    if (prev && prev.credential !== credential) {
      void this.purgeSessions().then((n) => this.onRotated?.(n)).catch(() => undefined);
    }
    return next;
  }

  /** Constant-time check of a presented credential. */
  verifyCredential(input: unknown): boolean {
    const cur = this.load();
    if (!cur || typeof input !== 'string' || input.length === 0 || input.length > 200) return false;
    return timingSafeEqual(sha256(input.trim()), sha256(cur.credential));
  }

  private mac(payload: string, key: Buffer): Buffer {
    return createHmac('sha256', key).update(payload).digest();
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

    const sessionId = randomBytes(8).toString('hex');
    const expiresAt = this.now() + this.ttlMs;
    const payload = Buffer.from(JSON.stringify({ s: sessionId, e: expiresAt, f: cur.fp })).toString('base64url');
    const token = `${ADMIN_SESSION_PREFIX}.${payload}.${this.mac(payload, cur.sessionKey).toString('base64url')}`;
    await r.set(adminSessionKey(sessionId), JSON.stringify({ createdAt: this.now(), expiresAt }), 'PX', this.ttlMs);
    return { ok: true, token, sessionId, expiresAt };
  }

  /** The session of a valid, unexpired, unrevoked token, else null. Never throws on bad input. */
  async verifySession(token: string | null | undefined): Promise<AdminSession | null> {
    if (!token || !looksLikeAdminSession(token)) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [, payload, sig] = parts as [string, string, string];
    const cur = this.load();
    if (!cur) return null;
    let given: Buffer;
    try { given = Buffer.from(sig, 'base64url'); } catch { return null; }
    const want = this.mac(payload, cur.sessionKey);
    if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
    let p: { s?: unknown; e?: unknown; f?: unknown };
    try { p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as typeof p; } catch { return null; }
    if (typeof p.s !== 'string' || typeof p.e !== 'number' || p.f !== cur.fp) return null;
    if (p.e <= this.now()) return null;
    const exists = await this.redis().exists(adminSessionKey(p.s));
    if (!exists) return null;
    return { sessionId: p.s, expiresAt: p.e };
  }

  /** Revoke one session (lock). */
  async lock(sessionId: string): Promise<boolean> {
    if (!/^[0-9a-f]{16}$/.test(sessionId)) return false;
    return (await this.redis().del(adminSessionKey(sessionId))) > 0;
  }

  /** Drop every admin session (rotation). */
  async purgeSessions(): Promise<number> {
    const r = this.redis();
    let cursor = '0';
    let n = 0;
    do {
      const [next, keys] = await r.scan(cursor, 'MATCH', 'adminsess:*', 'COUNT', 200);
      cursor = next;
      if (keys.length) n += await r.del(...keys);
    } while (cursor !== '0');
    return n;
  }
}
