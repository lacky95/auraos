/**
 * The one login-session mechanism, for password and shared-key sessions.
 *
 *   token   <prefix>.<b64url {s,e,m,u?,f?}>.<b64url HMAC>
 *   prefix  `aura-sess1` for password sessions; `aura-admin1` for shared-key
 *           sessions, which is the prefix the shell and CLI route as admin.
 *           The prefix is covered by the MAC and must match the method, so a
 *           password session can never be relabelled as an admin session.
 *   HMAC    password: subkey of identity.key. shared-key: derived from the
 *           admin credential, so recovery never depends on identity.key. The
 *           method is part of the MAC input as well.
 *   nonce   usersess:<sid> in Valkey with the session's TTL; deleting it
 *           revokes the session.
 *   `f`     shared-key sessions only: must match the current credential, so a
 *           rotation invalidates them at once, even before the purge runs.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Redis } from '@aura/kv-store';
import { deriveIdentitySubkey } from './identityKey.js';
import {
  LOGIN_SESSION_PREFIX,
  type LoginMethod, type LoginSession, type LoginSessionInput, type LoginSessionPayload, type LoginSessions,
} from './identityContracts.js';

export const SHARED_KEY_SESSION_PREFIX = 'aura-admin1';
export const SHARED_KEY_SESSION_TTL_MS = 15 * 60_000;
export const PASSWORD_SESSION_TTL_MS = 12 * 60 * 60_000;
export const STAY_SIGNED_IN_TTL_MS = 30 * 24 * 60 * 60_000;
export const loginSessionKey = (sid: string) => `usersess:${sid}`;

const SESSION_ID_RE = /^[0-9a-f]{32}$/;
const MAX_TOKEN_LENGTH = 2048;

interface Nonce { m: LoginMethod; u?: string; createdAt: number; expiresAt: number }

export interface LoginSessionStoreOptions {
  identityKeyFile: string;
  redis: () => Redis;
  now?: () => number;
  /** MAC key and fingerprint of the current shared credential; null when there is none. */
  sharedKey?: () => { fingerprint: string; macKey: Buffer } | null;
}

type SharedKey = () => { fingerprint: string; macKey: Buffer } | null;

const prefixFor = (m: LoginMethod) => (m === 'password' ? LOGIN_SESSION_PREFIX : SHARED_KEY_SESSION_PREFIX);

export class LoginSessionStore implements LoginSessions {
  private readonly redis: () => Redis;
  private readonly now: () => number;
  private readonly identityKeyFile: string;
  private readonly sharedKey: () => { fingerprint: string; macKey: Buffer } | null;

  constructor(opts: LoginSessionStoreOptions) {
    this.identityKeyFile = opts.identityKeyFile;
    this.redis = opts.redis;
    this.now = opts.now ?? Date.now;
    this.sharedKey = opts.sharedKey ?? (() => null);
  }

  /** Throws `IdentityKeyError` for a password session when identity.key is unusable. */
  private mac(method: LoginMethod, prefix: string, payload: string, shared: SharedKey = this.sharedKey): Buffer {
    const key = method === 'password'
      ? deriveIdentitySubkey(this.identityKeyFile, 'login-session')
      : shared()?.macKey;
    if (!key) throw new Error('no shared credential');
    return createHmac('sha256', key).update(`${method}\0${prefix}.${payload}`).digest();
  }

  async issue(input: LoginSessionInput): Promise<{ token: string; session: LoginSession }> {
    const maxTtl = input.method === 'password' ? STAY_SIGNED_IN_TTL_MS : SHARED_KEY_SESSION_TTL_MS;
    const ttlMs = input.ttlMs ?? (input.method === 'password' ? PASSWORD_SESSION_TTL_MS : SHARED_KEY_SESSION_TTL_MS);
    if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > maxTtl) throw new RangeError('invalid session lifetime');
    if (input.method === 'shared-key' && this.sharedKey()?.fingerprint !== input.keyFingerprint) {
      throw new Error('shared-key fingerprint does not match the current credential');
    }

    const sessionId = randomBytes(16).toString('hex');
    const createdAt = this.now();
    const expiresAt = createdAt + ttlMs;
    const claims: LoginSessionPayload = {
      s: sessionId, e: expiresAt, m: input.method,
      ...(input.userId ? { u: input.userId } : {}),
      ...(input.method === 'shared-key' ? { f: input.keyFingerprint } : {}),
    };
    const prefix = prefixFor(input.method);
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const token = `${prefix}.${payload}.${this.mac(input.method, prefix, payload).toString('base64url')}`;
    const nonce: Nonce = { m: input.method, ...(input.userId ? { u: input.userId } : {}), createdAt, expiresAt };
    await this.redis().set(loginSessionKey(sessionId), JSON.stringify(nonce), 'PX', ttlMs);
    return {
      token,
      session: {
        sessionId, expiresAt, method: input.method,
        ...(input.userId ? { userId: input.userId } : {}),
        ...(input.method === 'shared-key' ? { keyFingerprint: input.keyFingerprint } : {}),
      },
    };
  }

  verify(token: string | null | undefined): Promise<LoginSession | null> {
    return this.check(token, this.sharedKey);
  }

  /**
   * `verify` of a shared-key session against key material the caller already
   * holds, so it can't trigger rotation handling. Reads only.
   */
  async peekShared(
    token: string | null | undefined,
    material: { fingerprint: string; macKey: Buffer },
  ): Promise<LoginSession | null> {
    if (typeof token !== 'string' || !token.startsWith(`${SHARED_KEY_SESSION_PREFIX}.`)) return null;
    return this.check(token, () => material);
  }

  private async check(token: string | null | undefined, shared: SharedKey): Promise<LoginSession | null> {
    if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [prefix, payload, sig] = parts as [string, string, string];
    const method: LoginMethod | null = prefix === LOGIN_SESSION_PREFIX ? 'password'
      : prefix === SHARED_KEY_SESSION_PREFIX ? 'shared-key' : null;
    if (!method) return null;

    const p = this.claimsOf(method, prefix, payload, sig, shared);
    if (!p) return null;

    // Outside any catch: a Valkey failure is a service error, not a bad session.
    const raw = await this.redis().get(loginSessionKey(p.s));
    if (!raw) return null;
    let nonce: Partial<Nonce>;
    try { nonce = JSON.parse(raw) as Partial<Nonce>; } catch { return null; }
    if (nonce.m !== p.m || nonce.u !== p.u) return null;
    return {
      sessionId: p.s, expiresAt: p.e, method: p.m,
      ...(p.u ? { userId: p.u } : {}),
      ...(p.f ? { keyFingerprint: p.f } : {}),
    };
  }

  /** The token's verified claims, or null. An unusable MAC key counts as invalid. */
  private claimsOf(
    method: LoginMethod, prefix: string, payload: string, sig: string, shared: SharedKey,
  ): { s: string; e: number; m: LoginMethod; u?: string; f?: string } | null {
    try {
      const given = Buffer.from(sig, 'base64url');
      const want = this.mac(method, prefix, payload, shared);
      if (given.length !== want.length || !timingSafeEqual(given, want)) return null;

      const p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as Partial<LoginSessionPayload>;
      if (typeof p.s !== 'string' || !SESSION_ID_RE.test(p.s) || typeof p.e !== 'number') return null;
      if (p.m !== method || p.e <= this.now()) return null;
      if (p.u !== undefined && typeof p.u !== 'string') return null;
      if (p.m === 'password' && !p.u) return null;
      if (p.m === 'shared-key' && (typeof p.f !== 'string' || p.f !== shared()?.fingerprint)) return null;
      return {
        s: p.s, e: p.e, m: p.m,
        ...(p.u ? { u: p.u } : {}),
        ...(p.f ? { f: p.f } : {}),
      };
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
    return (await this.redis().del(loginSessionKey(sessionId))) > 0;
  }

  revokeByUser(userId: string): Promise<number> {
    return this.revokeWhere((n) => n.u === userId);
  }

  revokeByMethod(method: LoginMethod): Promise<number> {
    return this.revokeWhere((n) => n.m === method);
  }

  private async revokeWhere(match: (n: Partial<Nonce>) => boolean): Promise<number> {
    const r = this.redis();
    let cursor = '0';
    let removed = 0;
    do {
      const [next, keys] = await r.scan(cursor, 'MATCH', loginSessionKey('*'), 'COUNT', 200);
      cursor = next;
      if (keys.length === 0) continue;
      const values = await r.mget(...keys);
      const doomed = keys.filter((_, i) => {
        const raw = values[i];
        if (!raw) return false;
        try { return match(JSON.parse(raw) as Partial<Nonce>); } catch { return false; }
      });
      if (doomed.length) removed += await r.del(...doomed);
    } while (cursor !== '0');
    return removed;
  }
}
