/**
 * ClientSessionStore — the lock state of each shell CLIENT (today: one per
 * browser tab), in the central Valkey.
 *
 *   client:<clientId>   JSON ClientSessionRecord, PX = ttl (refreshed by heartbeats)
 *   client:secret       the HMAC key of the sids (SET NX on first use)
 *
 * A sid is `cs1.<clientId>.<hmac(clientId)>`: opaque, bound to a random
 * client id, signed so a forged or mangled sid is rejected without a lookup.
 *
 * THE SID IS NOT A CREDENTIAL. It grants no permission and authenticates
 * nobody; it only selects the REDACTION VIEW a shell screen gets (lock
 * screen vs. unlocked). Anyone on the shell origin can register one. Lock
 * screen privacy is against glances, not against an attacker.
 *
 * `effectiveLock(sid)` is `'locked'` whenever the sid is missing, invalid,
 * unknown or expired — an unknown state is always the redacted one.
 *
 * Unlocking (register as unlocked, `unlock`, a heartbeat that reports
 * unlocked) goes through the `UnlockVerifier` hook. Today it allows every
 * request: a client-reported unlock is NOT an authentication boundary (the
 * lock screen has no PIN). An authenticated unlock (PIN, user login) plugs
 * in here later, without changing callers.
 *
 * D87 B1 (I.2): a session registered by a signed-in user records that
 * `userId` and its `loginSessionId`. A sid that names a user counts only for
 * that user (`effectiveLock(sid, { userId })` reads `locked` for anyone
 * else), and `endBy` ends a user's screens when the account is disabled or
 * its login sessions are revoked. There is no device concept.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Redis } from '@aura/kv-store';

export type LockState = 'locked' | 'unlocked';

export const CLIENT_SESSION_PREFIX = 'client:';
export const CLIENT_SESSION_SECRET_KEY = 'client:secret';
export const DEFAULT_CLIENT_SESSION_TTL_MS = 90_000;
export const CLIENT_SESSION_HEADER = 'x-aura-client-session';
const SID_PATTERN = /^cs1\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{22})$/;

export interface ClientSessionRecord {
  clientId: string;
  /** D87 B1: the signed-in user that registered this screen, if one did. */
  userId?: string;
  /** D87 B1: that user's login session; the screen ends with it. */
  loginSessionId?: string;
  lock: LockState;
  createdAt: number;
  lastSeen: number;
  lockAt?: number;
  unlockAt?: number;
}

export interface ClientSessionState {
  sid: string;
  lock: LockState;
  /** The session expires this long after the last heartbeat. */
  ttlMs: number;
  /** Set when an unlock was asked for but the verifier refused it. */
  unlockRefused?: string;
}

/** Proof an unlock request may carry (a PIN, a user token — none exists yet). */
export interface UnlockRequest {
  clientId: string;
  proof?: unknown;
}

/**
 * The authenticated-unlock hook. `allow:false` keeps the client locked and
 * reports `reason`. The default allows everything (see the file header).
 */
export interface UnlockVerifier {
  verify(req: UnlockRequest): Promise<{ allow: boolean; reason?: string }> | { allow: boolean; reason?: string };
}

export const ALLOW_CLIENT_UNLOCK: UnlockVerifier = Object.freeze({
  verify: () => ({ allow: true, reason: 'client-reported unlock (no authenticated unlock exists yet)' }),
});

export interface ClientSessionStoreOptions {
  redis: () => Redis;
  now?: () => number;
  ttlMs?: number;
  verifier?: UnlockVerifier;
  /** Fixed HMAC key (tests). Default: `client:secret` in Valkey, created on first use. */
  secret?: Buffer;
}

export class ClientSessionError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ClientSessionError';
  }
}

const b64 = (buf: Buffer) => buf.toString('base64url');

export class ClientSessionStore {
  private readonly redis: () => Redis;
  private readonly now: () => number;
  readonly ttlMs: number;
  private verifier: UnlockVerifier;
  private secret: Buffer | undefined;
  private secretLoad: Promise<Buffer> | null = null;

  constructor(opts: ClientSessionStoreOptions) {
    this.redis = opts.redis;
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? DEFAULT_CLIENT_SESSION_TTL_MS;
    this.verifier = opts.verifier ?? ALLOW_CLIENT_UNLOCK;
    this.secret = opts.secret;
  }

  /** Plug in an authenticated unlock (PIN / user auth) later. */
  setUnlockVerifier(v: UnlockVerifier | undefined): void {
    this.verifier = v ?? ALLOW_CLIENT_UNLOCK;
  }

  private async key(): Promise<Buffer> {
    if (this.secret) return this.secret;
    this.secretLoad ??= (async () => {
      const r = this.redis();
      await r.set(CLIENT_SESSION_SECRET_KEY, b64(randomBytes(32)), 'NX');
      const v = await r.get(CLIENT_SESSION_SECRET_KEY);
      if (!v) throw new Error('[client-sessions] no HMAC key');
      this.secret = Buffer.from(v, 'base64url');
      return this.secret;
    })().finally(() => { this.secretLoad = null; });
    return this.secretLoad;
  }

  private async sign(clientId: string): Promise<string> {
    return b64(createHmac('sha256', await this.key()).update(`cs1.${clientId}`).digest().subarray(0, 16));
  }

  /** The client id of a well-formed, correctly signed sid — else null. No lookup. */
  async clientIdOf(sid: string | null | undefined): Promise<string | null> {
    if (typeof sid !== 'string') return null;
    const m = SID_PATTERN.exec(sid.trim());
    if (!m) return null;
    const expected = Buffer.from(await this.sign(m[1]!), 'base64url');
    const got = Buffer.from(m[2]!, 'base64url');
    if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
    return m[1]!;
  }

  private async load(clientId: string): Promise<ClientSessionRecord | null> {
    const raw = await this.redis().get(CLIENT_SESSION_PREFIX + clientId);
    if (!raw) return null;
    try { return JSON.parse(raw) as ClientSessionRecord; } catch { return null; }
  }

  private async save(rec: ClientSessionRecord): Promise<void> {
    await this.redis().set(CLIENT_SESSION_PREFIX + rec.clientId, JSON.stringify(rec), 'PX', this.ttlMs);
  }

  private async mayUnlock(clientId: string, proof?: unknown): Promise<{ allow: boolean; reason?: string }> {
    try {
      const d = await this.verifier.verify({ clientId, ...(proof !== undefined ? { proof } : {}) });
      return d && d.allow ? { allow: true } : { allow: false, reason: d?.reason ?? 'unlock refused' };
    } catch (err) {
      return { allow: false, reason: `unlock verifier failed: ${(err as Error).message}` };
    }
  }

  private state(sid: string, rec: ClientSessionRecord, unlockRefused?: string): ClientSessionState {
    return { sid, lock: rec.lock, ttlMs: this.ttlMs, ...(unlockRefused ? { unlockRefused } : {}) };
  }

  /** A new session. `lock` is the client's current state; unlocked goes through the verifier. */
  async register(opts: { lock?: LockState; proof?: unknown; userId?: string; loginSessionId?: string } = {}): Promise<ClientSessionState> {
    const clientId = b64(randomBytes(16));
    const sid = `cs1.${clientId}.${await this.sign(clientId)}`;
    const now = this.now();
    let lock: LockState = opts.lock === 'unlocked' ? 'unlocked' : 'locked';
    let refused: string | undefined;
    if (lock === 'unlocked') {
      const d = await this.mayUnlock(clientId, opts.proof);
      if (!d.allow) { lock = 'locked'; refused = d.reason; }
    }
    const rec: ClientSessionRecord = {
      clientId, lock, createdAt: now, lastSeen: now,
      ...(opts.userId ? { userId: opts.userId } : {}),
      ...(opts.userId && opts.loginSessionId ? { loginSessionId: opts.loginSessionId } : {}),
      ...(lock === 'locked' ? { lockAt: now } : { unlockAt: now }),
    };
    await this.save(rec);
    return this.state(sid, rec, refused);
  }

  /**
   * Set the lock state of a session (and refresh its TTL). Locking always
   * works; unlocking asks the verifier. `null` when the sid is unknown,
   * invalid or expired — the client re-registers.
   */
  async setLock(sid: string, lock: LockState, proof?: unknown): Promise<ClientSessionState | null> {
    const clientId = await this.clientIdOf(sid);
    if (!clientId) return null;
    const rec = await this.load(clientId);
    if (!rec) return null;
    const now = this.now();
    let refused: string | undefined;
    if (lock === 'unlocked' && rec.lock !== 'unlocked') {
      const d = await this.mayUnlock(clientId, proof);
      if (d.allow) { rec.lock = 'unlocked'; rec.unlockAt = now; }
      else refused = d.reason;
    } else if (lock === 'locked' && rec.lock !== 'locked') {
      rec.lock = 'locked';
      rec.lockAt = now;
    }
    rec.lastSeen = now;
    await this.save(rec);
    return this.state(sid, rec, refused);
  }

  lock(sid: string): Promise<ClientSessionState | null> {
    return this.setLock(sid, 'locked');
  }

  unlock(sid: string, proof?: unknown): Promise<ClientSessionState | null> {
    return this.setLock(sid, 'unlocked', proof);
  }

  /** Keep the session alive; with `lock`, also re-sync the client's state. */
  async heartbeat(sid: string, opts: { lock?: LockState; proof?: unknown } = {}): Promise<ClientSessionState | null> {
    if (opts.lock) return this.setLock(sid, opts.lock, opts.proof);
    const clientId = await this.clientIdOf(sid);
    if (!clientId) return null;
    const rec = await this.load(clientId);
    if (!rec) return null;
    rec.lastSeen = this.now();
    await this.save(rec);
    return this.state(sid, rec);
  }

  /** End a session (tab closed). */
  async end(sid: string): Promise<boolean> {
    const clientId = await this.clientIdOf(sid);
    if (!clientId) return false;
    return (await this.redis().del(CLIENT_SESSION_PREFIX + clientId)) > 0;
  }

  /** The record of a live session, or null. */
  async get(sid: string | null | undefined): Promise<ClientSessionRecord | null> {
    const clientId = await this.clientIdOf(sid);
    if (!clientId) return null;
    const rec = await this.load(clientId);
    // Valkey expires the key; also refuse anything past its TTL by our own clock.
    if (!rec || this.now() - rec.lastSeen > this.ttlMs) return null;
    return rec;
  }

  /**
   * D87 B1: end every screen of a user, or of one login session. How many.
   * Called when an account is disabled and when login sessions are revoked.
   */
  async endBy(sel: { userId: string } | { loginSessionId: string }): Promise<number> {
    return this.endWhere((rec) => ('userId' in sel ? rec.userId === sel.userId : rec.loginSessionId === sel.loginSessionId));
  }

  /** D87 B1: end the screens whose login session is no longer live (after a revoke). How many. */
  async endRevoked(loginSessionLive: (loginSessionId: string) => Promise<boolean>): Promise<number> {
    const dead = new Set<string>();
    const ids = new Set<string>();
    await this.eachRecord((rec) => { if (rec.loginSessionId) ids.add(rec.loginSessionId); });
    for (const id of ids) if (!(await loginSessionLive(id))) dead.add(id);
    return dead.size ? this.endWhere((rec) => !!rec.loginSessionId && dead.has(rec.loginSessionId)) : 0;
  }

  private async eachRecord(fn: (rec: ClientSessionRecord, key: string) => void): Promise<void> {
    const r = this.redis();
    let cursor = '0';
    do {
      const [next, keys] = await r.scan(cursor, 'MATCH', `${CLIENT_SESSION_PREFIX}*`, 'COUNT', 500);
      cursor = next;
      const recs = keys.filter((k) => k !== CLIENT_SESSION_SECRET_KEY);
      if (!recs.length) continue;
      const values = await r.mget(...recs);
      recs.forEach((key, i) => {
        try { const rec = JSON.parse(values[i] ?? 'null') as ClientSessionRecord | null; if (rec) fn(rec, key); } catch { /* skip */ }
      });
    } while (cursor !== '0');
  }

  private async endWhere(match: (rec: ClientSessionRecord) => boolean): Promise<number> {
    const doomed: string[] = [];
    await this.eachRecord((rec, key) => { if (match(rec)) doomed.push(key); });
    return doomed.length ? this.redis().del(...doomed) : 0;
  }

  /**
   * `'unlocked'` only for a live session that says so; everything else is
   * `'locked'`. D87 B1: asked for a user (`userId`), a sid that another user
   * registered reads `locked`: it is not this user's screen.
   */
  async effectiveLock(sid: string | null | undefined, opts: { userId?: string } = {}): Promise<LockState> {
    try {
      const rec = await this.get(sid);
      if (rec?.userId && opts.userId !== undefined && rec.userId !== opts.userId) return 'locked';
      return rec?.lock === 'unlocked' ? 'unlocked' : 'locked';
    } catch {
      return 'locked';
    }
  }
}
