/**
 * The one login-session mechanism: the owner's password sessions.
 *
 *   token   aura-sess1.<b64url {s,e,m,u}>.<b64url HMAC>
 *   HMAC    subkey of identity.key; the prefix and the method are MAC input.
 *   nonce   usersess:<sid> in Valkey with the session's TTL; deleting it
 *           revokes the session.
 *
 * The shared admin credential's `shared-key` sessions (`aura-admin1.`) are
 * gone (D50). Their nonces left in Valkey are purged once on boot
 * (`revokeLegacySharedKey`); a token that names one no longer parses.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Redis } from '@aura/kv-store';
import { OsEventBus } from '../ipc/OsEventBus.js';
import { deriveIdentitySubkey } from './identityKey.js';
import {
  LOGIN_SESSION_PREFIX,
  type LoginMethod, type LoginSession, type LoginSessionInfo, type LoginSessionInput, type LoginSessionPayload,
  type LoginSessions,
} from './identityContracts.js';

/** The method of the retired shared-admin sessions (D50), for the boot purge only. */
export const LEGACY_SHARED_KEY_METHOD = 'shared-key';
export const PASSWORD_SESSION_TTL_MS = 12 * 60 * 60_000;
export const STAY_SIGNED_IN_TTL_MS = 30 * 24 * 60 * 60_000;
export const loginSessionKey = (sid: string) => `usersess:${sid}`;

const SESSION_ID_RE = /^[0-9a-f]{32}$/;
const MAX_TOKEN_LENGTH = 2048;

interface Nonce { m: LoginMethod | typeof LEGACY_SHARED_KEY_METHOD; u?: string; createdAt: number; expiresAt: number }

export interface LoginSessionStoreOptions {
  identityKeyFile: string;
  redis: () => Redis;
  now?: () => number;
}

export class LoginSessionStore implements LoginSessions {
  private readonly redis: () => Redis;
  private readonly now: () => number;
  private readonly identityKeyFile: string;

  constructor(opts: LoginSessionStoreOptions) {
    this.identityKeyFile = opts.identityKeyFile;
    this.redis = opts.redis;
    this.now = opts.now ?? Date.now;
  }

  /** Throws `IdentityKeyError` when identity.key is unusable. */
  private mac(method: LoginMethod, prefix: string, payload: string): Buffer {
    const key = deriveIdentitySubkey(this.identityKeyFile, 'login-session');
    return createHmac('sha256', key).update(`${method}\0${prefix}.${payload}`).digest();
  }

  async issue(input: LoginSessionInput): Promise<{ token: string; session: LoginSession }> {
    const ttlMs = input.ttlMs ?? PASSWORD_SESSION_TTL_MS;
    if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > STAY_SIGNED_IN_TTL_MS) throw new RangeError('invalid session lifetime');
    if (!input.userId) throw new Error('a login session belongs to a user');

    const sessionId = randomBytes(16).toString('hex');
    const createdAt = this.now();
    const expiresAt = createdAt + ttlMs;
    const claims: LoginSessionPayload = { s: sessionId, e: expiresAt, m: input.method, u: input.userId };
    const prefix = LOGIN_SESSION_PREFIX;
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const token = `${prefix}.${payload}.${this.mac(input.method, prefix, payload).toString('base64url')}`;
    const nonce: Nonce = { m: input.method, u: input.userId, createdAt, expiresAt };
    await this.redis().set(loginSessionKey(sessionId), JSON.stringify(nonce), 'PX', ttlMs);
    return { token, session: { sessionId, expiresAt, method: input.method, userId: input.userId } };
  }

  async verify(token: string | null | undefined): Promise<LoginSession | null> {
    if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [prefix, payload, sig] = parts as [string, string, string];
    if (prefix !== LOGIN_SESSION_PREFIX) return null;

    const p = this.claimsOf('password', prefix, payload, sig);
    if (!p) return null;

    // Outside any catch: a Valkey failure is a service error, not a bad session.
    const raw = await this.redis().get(loginSessionKey(p.s));
    if (!raw) return null;
    let nonce: Partial<Nonce>;
    try { nonce = JSON.parse(raw) as Partial<Nonce>; } catch { return null; }
    if (nonce.m !== p.m || nonce.u !== p.u) return null;
    return { sessionId: p.s, expiresAt: p.e, method: p.m, userId: p.u };
  }

  /** The token's verified claims, or null. An unusable MAC key counts as invalid. */
  private claimsOf(
    method: LoginMethod, prefix: string, payload: string, sig: string,
  ): { s: string; e: number; m: LoginMethod; u: string } | null {
    try {
      const given = Buffer.from(sig, 'base64url');
      const want = this.mac(method, prefix, payload);
      if (given.length !== want.length || !timingSafeEqual(given, want)) return null;

      const p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as Partial<LoginSessionPayload>;
      if (typeof p.s !== 'string' || !SESSION_ID_RE.test(p.s) || typeof p.e !== 'number') return null;
      if (p.m !== method || p.e <= this.now()) return null;
      if (typeof p.u !== 'string' || !p.u) return null;
      return { s: p.s, e: p.e, m: p.m, u: p.u };
    } catch {
      return null;
    }
  }

  /**
   * Whether the password session `sessionId` of `userId` is live: not revoked
   * and not expired. For holders of a sealed reference to a session (an App
   * Host cookie) rather than its token. Rejects only when Valkey fails.
   */
  async isLive(sessionId: string, userId: string): Promise<boolean> {
    if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId) || typeof userId !== 'string' || !userId) return false;
    const raw = await this.redis().get(loginSessionKey(sessionId));
    if (!raw) return false;
    let nonce: Partial<Nonce>;
    try { nonce = JSON.parse(raw) as Partial<Nonce>; } catch { return false; }
    return nonce.m === 'password' && nonce.u === userId
      && typeof nonce.expiresAt === 'number' && nonce.expiresAt > this.now();
  }

  async revoke(sessionId: string): Promise<boolean> {
    if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return false;
    const removed = (await this.redis().del(loginSessionKey(sessionId))) > 0;
    if (removed) this.emitRevoked(1);
    return removed;
  }

  revokeByUser(userId: string, opts: { except?: string } = {}): Promise<number> {
    const keep = opts.except ? loginSessionKey(opts.except) : null;
    return this.revokeWhere((n, key) => n.u === userId && key !== keep);
  }

  revokeByMethod(method: LoginMethod): Promise<number> {
    return this.revokeWhere((n) => n.m === method);
  }

  /** Delete what is left of the retired shared-admin sessions (D50, once on boot). How many. */
  revokeLegacySharedKey(): Promise<number> {
    return this.revokeWhere((n) => n.m === LEGACY_SHARED_KEY_METHOD);
  }

  /**
   * The live sessions of `userId`, oldest first. Nonces past their `expiresAt`
   * that Valkey still holds (its TTL runs on its own clock) are deleted on
   * the way, from the batch already read.
   */
  async listByUser(userId: string): Promise<LoginSessionInfo[]> {
    const found: LoginSessionInfo[] = [];
    const prefix = loginSessionKey('');
    const now = this.now();
    await this.scanNonces(async (batch) => {
      const expired: string[] = [];
      for (const { key, nonce: n } of batch) {
        if (typeof n.expiresAt === 'number' && n.expiresAt <= now) { expired.push(key); continue; }
        const sessionId = key.slice(prefix.length);
        if (n.u !== userId || !SESSION_ID_RE.test(sessionId) || n.m !== 'password') continue;
        if (typeof n.createdAt !== 'number' || typeof n.expiresAt !== 'number') continue;
        found.push({ sessionId, method: n.m, createdAt: n.createdAt, expiresAt: n.expiresAt });
      }
      if (expired.length) await this.redis().del(...expired);
    });
    return found.sort((a, b) => a.createdAt - b.createdAt);
  }

  private async revokeWhere(match: (n: Partial<Nonce>, key: string) => boolean): Promise<number> {
    let removed = 0;
    await this.scanNonces(async (batch) => {
      const doomed = batch.filter(({ key, nonce }) => match(nonce, key)).map(({ key }) => key);
      if (doomed.length) removed += await this.redis().del(...doomed);
    });
    if (removed > 0) this.emitRevoked(removed);
    return removed;
  }

  /** Tell session holders (open event streams) to check theirs again. Never breaks a revoke. */
  private emitRevoked(count: number): void {
    try { OsEventBus.emit('auth:sessionsRevoked', { count }); } catch { /* the bus must never break a revoke */ }
  }

  /** Every stored session nonce, a SCAN batch at a time. Unparseable values are skipped. */
  private async scanNonces(
    each: (batch: { key: string; nonce: Partial<Nonce> }[]) => Promise<void> | void,
  ): Promise<void> {
    const r = this.redis();
    let cursor = '0';
    do {
      const [next, keys] = await r.scan(cursor, 'MATCH', loginSessionKey('*'), 'COUNT', 200);
      cursor = next;
      if (keys.length === 0) continue;
      const values = await r.mget(...keys);
      const batch = keys.flatMap((key, i) => {
        const raw = values[i];
        if (!raw) return [];
        try { return [{ key, nonce: JSON.parse(raw) as Partial<Nonce> }]; } catch { return []; }
      });
      await each(batch);
    } while (cursor !== '0');
  }
}
