/**
 * The one login-session mechanism, for password and shared-key sessions.
 *
 *   token   <prefix>.<b64url {s,e,m,u?,f?}>.<b64url HMAC>
 *   prefix  `aura-sess1` for password sessions; `aura-admin1` for shared-key
 *           sessions, which is the prefix the shell and CLI route as admin.
 *           The prefix is covered by the MAC and must match the method, so a
 *           password session can never be relabelled as an admin session.
 *   HMAC    subkey of identity.key
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
  /** Fingerprint of the current shared credential; null when there is none. */
  sharedKeyFingerprint?: () => string | null;
}

const prefixFor = (m: LoginMethod) => (m === 'password' ? LOGIN_SESSION_PREFIX : SHARED_KEY_SESSION_PREFIX);

export class LoginSessionStore implements LoginSessions {
  private readonly redis: () => Redis;
  private readonly now: () => number;
  private readonly identityKeyFile: string;
  private readonly sharedKeyFingerprint: () => string | null;
  private macKey: Buffer | null = null;

  constructor(opts: LoginSessionStoreOptions) {
    this.identityKeyFile = opts.identityKeyFile;
    this.redis = opts.redis;
    this.now = opts.now ?? Date.now;
    this.sharedKeyFingerprint = opts.sharedKeyFingerprint ?? (() => null);
  }

  private mac(prefix: string, payload: string): Buffer {
    this.macKey ??= deriveIdentitySubkey(this.identityKeyFile, 'login-session');
    return createHmac('sha256', this.macKey).update(`${prefix}.${payload}`).digest();
  }

  async issue(input: LoginSessionInput): Promise<{ token: string; session: LoginSession }> {
    const maxTtl = input.method === 'password' ? STAY_SIGNED_IN_TTL_MS : SHARED_KEY_SESSION_TTL_MS;
    const ttlMs = input.ttlMs ?? (input.method === 'password' ? PASSWORD_SESSION_TTL_MS : SHARED_KEY_SESSION_TTL_MS);
    if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > maxTtl) throw new RangeError('invalid session lifetime');

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
    const token = `${prefix}.${payload}.${this.mac(prefix, payload).toString('base64url')}`;
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

  async verify(token: string | null | undefined): Promise<LoginSession | null> {
    if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [prefix, payload, sig] = parts as [string, string, string];
    if (prefix !== LOGIN_SESSION_PREFIX && prefix !== SHARED_KEY_SESSION_PREFIX) return null;

    try {
      const given = Buffer.from(sig, 'base64url');
      const want = this.mac(prefix, payload);
      if (given.length !== want.length || !timingSafeEqual(given, want)) return null;

      const p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as Partial<LoginSessionPayload>;
      if (typeof p.s !== 'string' || !SESSION_ID_RE.test(p.s) || typeof p.e !== 'number') return null;
      if (p.m !== 'password' && p.m !== 'shared-key') return null;
      if (prefix !== prefixFor(p.m) || p.e <= this.now()) return null;
      if (p.u !== undefined && typeof p.u !== 'string') return null;
      if (p.m === 'password' && !p.u) return null;
      if (p.m === 'shared-key' && (typeof p.f !== 'string' || p.f !== this.sharedKeyFingerprint())) return null;

      const raw = await this.redis().get(loginSessionKey(p.s));
      if (!raw) return null;
      const nonce = JSON.parse(raw) as Partial<Nonce>;
      if (nonce.m !== p.m || nonce.u !== p.u) return null;
      return {
        sessionId: p.s, expiresAt: p.e, method: p.m,
        ...(p.u ? { userId: p.u } : {}),
        ...(p.f ? { keyFingerprint: p.f } : {}),
      };
    } catch {
      return null;
    }
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
