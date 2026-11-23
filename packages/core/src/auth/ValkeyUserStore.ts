/**
 * The owner account at `user:default` (D5, D16). `/api/kv` cannot reach the
 * `user:` namespace.
 *
 * The record carries a MAC from identity.key, so a Valkey writer cannot swap
 * the hash, username or role. A record that fails the MAC never authenticates,
 * and still counts as an existing owner so setup cannot replace it. Only
 * `recoverOwnerPassword`, with a claimed reset ticket, can re-seal it.
 *
 * Passwords use async scrypt with its parameters in the hash string. Hashing is
 * serialized and login attempts are rate limited BEFORE any hashing, because
 * each hash costs about 128 MiB.
 */
import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { Redis } from '@aura/kv-store';
import { consumeClaimedTicket, isClaimedTicket } from './claimedTickets.js';
import { deriveIdentitySubkey, IdentityKeyError, identityKeyStatus, type IdentityKeyStatus } from './identityKey.js';
import {
  DEFAULT_OWNER_ID,
  type LoginSessions, type PasswordCheck, type SetupTicket, type UserAccount, type UserStore,
} from './identityContracts.js';
import type { UserRole } from './types.js';

export const OWNER_RECORD_KEY = `user:${DEFAULT_OWNER_ID}`;
export const PASSWORD_MIN_LENGTH = 8;
/** In UTF-8 bytes. Longer input is refused before hashing. */
export const PASSWORD_MAX_BYTES = 1024;
export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/;
export const LOGIN_ATTEMPTS_PER_MINUTE = 30;
export const LOGIN_ATTEMPTS_PER_KEY_PER_MINUTE = 10;

const SCRYPT = { N: 2 ** 17, r: 8, p: 1, keyLen: 32, saltLen: 16 } as const;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
const MAX_QUEUED_VERIFIES = 8;
/** Compare-and-set, so a concurrent change is never overwritten. */
const SET_IF_UNCHANGED = `if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2]) return 1 end return 0`;

export class UserStoreError extends Error {
  constructor(readonly code: 'invalid-username' | 'invalid-password', message: string) {
    super(message);
    this.name = 'UserStoreError';
  }
}

interface StoredUser extends UserAccount { passwordHash: string }

export type OwnerRecoveryResult =
  | {
    ok: true;
    user: UserAccount;
    /** False when the old record failed its MAC, so the username came from the ticket. */
    recordTrusted: boolean;
    /** Null when the password changed but revoking sessions failed. */
    sessionsRevoked: number | null;
  }
  | { ok: false; reason: 'invalid-ticket' | 'no-owner' | 'username-mismatch' | 'identity-key-unavailable' | 'conflict' };

export interface OwnerRecoveryEvent {
  username: string;
  recordTrusted: boolean;
  usernameSource: 'record' | 'ticket';
  sessionsRevoked: number | null;
}

function deriveKey(password: string, salt: Buffer, N: number, r: number, p: number, keyLen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLen, { N, r, p, maxmem: SCRYPT_MAXMEM }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

// One hash at a time across the process, with a bounded queue for logins.
let hashTail: Promise<unknown> = Promise.resolve();
let queuedVerifies = 0;

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = hashTail.then(fn, fn);
  hashTail = run.catch(() => undefined);
  return run;
}

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT.saltLen);
  const key = await serialized(() => deriveKey(password, salt, SCRYPT.N, SCRYPT.r, SCRYPT.p, SCRYPT.keyLen));
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

async function checkHash(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (![N, r, p].every(Number.isInteger) || N < 2 ** 14 || N > SCRYPT.N || (N & (N - 1)) !== 0) return false;
  if (r < 1 || r > 16 || p < 1 || p > 4 || 128 * N * r * p > SCRYPT_MAXMEM / 2) return false;
  const salt = Buffer.from(parts[4]!, 'base64url');
  const want = Buffer.from(parts[5]!, 'base64url');
  if (salt.length === 0 || want.length !== SCRYPT.keyLen) return false;
  const got = await serialized(() => deriveKey(password, salt, N, r, p, want.length));
  return timingSafeEqual(got, want);
}

/** Same work as a real check. Its all-zero key is never compared as a success. */
const dummyHash = (): string =>
  `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${randomBytes(SCRYPT.saltLen).toString('base64url')}$${Buffer.alloc(SCRYPT.keyLen).toString('base64url')}`;

const normalizeUsername = (u: string) => u.trim().toLowerCase();
const accountOf = ({ passwordHash: _omit, ...account }: StoredUser): UserAccount => account;

function assertPassword(password: unknown): asserts password is string {
  if (typeof password !== 'string' || [...password].length < PASSWORD_MIN_LENGTH) {
    throw new UserStoreError('invalid-password', `password must have at least ${PASSWORD_MIN_LENGTH} characters`);
  }
  if (Buffer.byteLength(password) > PASSWORD_MAX_BYTES) {
    throw new UserStoreError('invalid-password', `password must be at most ${PASSWORD_MAX_BYTES} bytes`);
  }
}

/** Display-only metadata from a record that failed its MAC. */
function untrustedCreatedAt(raw: string, fallback: number): number {
  try {
    const t = (JSON.parse(raw) as { createdAt?: unknown }).createdAt;
    return typeof t === 'number' && Number.isSafeInteger(t) && t > 0 && t <= fallback ? t : fallback;
  } catch {
    return fallback;
  }
}

export interface ValkeyUserStoreOptions {
  identityKeyFile: string;
  redis: () => Redis;
  now?: () => number;
  /** A stored record failed its MAC. Never receives record contents. */
  onTampered?: () => void;
  /** identity.key is unusable, so password login is disabled. Reported once per outage. */
  onIdentityKeyError?: (err: IdentityKeyError) => void;
  /** Required by `recoverOwnerPassword`, which revokes every password session. */
  sessions?: Pick<LoginSessions, 'revokeByMethod'>;
  /** Audit hook for a completed recovery. Its failure never undoes the recovery. */
  onOwnerRecovered?: (e: OwnerRecoveryEvent) => Promise<void> | void;
}

export class ValkeyUserStore implements UserStore {
  private readonly redis: () => Redis;
  private readonly now: () => number;
  private readonly identityKeyFile: string;
  private readonly onTampered?: () => void;
  private readonly onIdentityKeyError?: (err: IdentityKeyError) => void;
  private readonly sessions?: Pick<LoginSessions, 'revokeByMethod'>;
  private readonly onOwnerRecovered?: (e: OwnerRecoveryEvent) => Promise<void> | void;
  private keyErrorReported = false;
  /** Digest of the last bad record, so one tampering is reported once. */
  private reportedTamper: string | null = null;

  constructor(opts: ValkeyUserStoreOptions) {
    this.identityKeyFile = opts.identityKeyFile;
    this.redis = opts.redis;
    this.now = opts.now ?? Date.now;
    this.onTampered = opts.onTampered;
    this.onIdentityKeyError = opts.onIdentityKeyError;
    this.sessions = opts.sessions;
    this.onOwnerRecovered = opts.onOwnerRecovered;
  }

  private mac(u: StoredUser): Buffer {
    const key = deriveIdentitySubkey(this.identityKeyFile, 'user-record');
    const canonical = JSON.stringify([OWNER_RECORD_KEY, u.id, u.username, u.passwordHash, u.role, u.createdAt, u.disabled]);
    return createHmac('sha256', key).update(canonical).digest();
  }

  private seal(u: StoredUser): string {
    return JSON.stringify({ ...u, mac: this.mac(u).toString('base64url') });
  }

  private reportKeyError(err: IdentityKeyError): void {
    if (this.keyErrorReported) return;
    this.keyErrorReported = true;
    this.onIdentityKeyError?.(err);
  }

  /** For status routes: `malformed` means password login is disabled. */
  identityKeyStatus(): IdentityKeyStatus {
    return identityKeyStatus(this.identityKeyFile);
  }

  /** The record if it exists and its MAC is valid. */
  private unseal(raw: string | null, report = true): StoredUser | null {
    if (!raw) return null;
    try {
      const o = JSON.parse(raw) as Partial<StoredUser> & { mac?: unknown };
      if (typeof o.id !== 'string' || typeof o.username !== 'string' || typeof o.passwordHash !== 'string'
        || o.role !== 'owner' || typeof o.createdAt !== 'number' || typeof o.disabled !== 'boolean'
        || typeof o.mac !== 'string') throw new Error('shape');
      const u: StoredUser = {
        id: o.id, username: o.username, passwordHash: o.passwordHash,
        role: o.role as UserRole, createdAt: o.createdAt, disabled: o.disabled,
      };
      const given = Buffer.from(o.mac, 'base64url');
      const want = this.mac(u);
      this.keyErrorReported = false;
      if (given.length !== want.length || !timingSafeEqual(given, want)) throw new Error('mac');
      return u;
    } catch (err) {
      if (err instanceof IdentityKeyError) {
        if (report) this.reportKeyError(err);
        return null;
      }
      if (!report) return null;
      const digest = createHash('sha256').update(raw).digest('hex');
      if (digest !== this.reportedTamper) {
        this.reportedTamper = digest;
        this.onTampered?.();
      }
      return null;
    }
  }

  async hasOwner(): Promise<boolean> {
    return (await this.redis().exists(OWNER_RECORD_KEY)) > 0;
  }

  async getOwner(): Promise<UserAccount | null> {
    const u = this.unseal(await this.redis().get(OWNER_RECORD_KEY));
    return u ? accountOf(u) : null;
  }

  async createOwner(input: { username: string; password: string }): Promise<UserAccount | null> {
    const username = typeof input.username === 'string' ? normalizeUsername(input.username) : '';
    if (!USERNAME_PATTERN.test(username)) {
      throw new UserStoreError('invalid-username', 'username must be 1-32 letters, digits, ".", "_" or "-"');
    }
    assertPassword(input.password);
    if (await this.hasOwner()) return null; // Skip the expensive hash; SET NX below is the real guard.
    deriveIdentitySubkey(this.identityKeyFile, 'user-record'); // Fail before hashing on a bad key.
    const user: StoredUser = {
      id: DEFAULT_OWNER_ID, username, passwordHash: await hashPassword(input.password),
      role: 'owner', createdAt: this.now(), disabled: false,
    };
    const created = await this.redis().set(OWNER_RECORD_KEY, this.seal(user), 'NX');
    return created === 'OK' ? accountOf(user) : null;
  }

  /** Counts this attempt. True when it is over a limit, or the limit can't be checked. */
  private async overLimit(username: string, rateLimitKey?: string): Promise<boolean> {
    const minute = Math.floor(this.now() / 60_000);
    const id = createHash('sha256').update(rateLimitKey ?? `user:${username}`).digest('hex').slice(0, 32);
    const bump = async (bucket: string) => {
      const r = this.redis();
      const n = await r.incr(bucket);
      if (n === 1) await r.pexpire(bucket, 120_000);
      return n;
    };
    try {
      const all = await bump(`ratelimit:login:all:${minute}`);
      const perKey = await bump(`ratelimit:login:key:${id}:${minute}`);
      return all > LOGIN_ATTEMPTS_PER_MINUTE || perKey > LOGIN_ATTEMPTS_PER_KEY_PER_MINUTE;
    } catch {
      return true;
    }
  }

  /**
   * @param opts.rateLimitKey  the caller's identity for the per-client limit,
   *   e.g. its address. Defaults to the username. Stored only as a hash.
   */
  async verifyPassword(username: string, password: string, opts: { rateLimitKey?: string } = {}): Promise<PasswordCheck> {
    const name = typeof username === 'string' ? normalizeUsername(username).slice(0, 64) : '';
    if (await this.overLimit(name, opts.rateLimitKey)) return { ok: false, reason: 'rate-limited' };
    if (typeof password !== 'string' || password.length === 0 || Buffer.byteLength(password) > PASSWORD_MAX_BYTES) {
      return { ok: false, reason: 'invalid' };
    }
    if (queuedVerifies >= MAX_QUEUED_VERIFIES) return { ok: false, reason: 'rate-limited' };

    queuedVerifies++;
    try {
      let user: StoredUser | null = null;
      try { user = this.unseal(await this.redis().get(OWNER_RECORD_KEY)); } catch { user = null; }
      const candidate = user && user.username === name ? user : null;
      const matches = await checkHash(password, candidate?.passwordHash ?? dummyHash());
      if (!candidate || !matches || candidate.disabled) return { ok: false, reason: 'invalid' };
      return { ok: true, user: accountOf(candidate) };
    } catch {
      return { ok: false, reason: 'invalid' };
    } finally {
      queuedVerifies--;
    }
  }

  async setPassword(userId: string, password: string): Promise<boolean> {
    assertPassword(password);
    if (userId !== DEFAULT_OWNER_ID) return false;
    const r = this.redis();
    const raw = await r.get(OWNER_RECORD_KEY);
    const user = this.unseal(raw);
    if (!user) return false;
    const next = this.seal({ ...user, passwordHash: await hashPassword(password) });
    return (await r.eval(SET_IF_UNCHANGED, 1, OWNER_RECORD_KEY, raw!, next)) === 1;
  }

  /**
   * Operator recovery, e.g. after identity.key was lost or replaced. Needs the
   * object returned by a successful `FileSetupTickets.claim(code, 'reset')`,
   * which it spends. Re-seals the owner record even if its MAC fails, then
   * revokes every password session. When the MAC fails, nothing in the old
   * record is trusted: the username comes from the ticket and the account is
   * re-enabled. Audited through `onOwnerRecovered`.
   */
  async recoverOwnerPassword(ticket: SetupTicket, password: string): Promise<OwnerRecoveryResult> {
    assertPassword(password);
    if (!this.sessions) throw new Error('recoverOwnerPassword needs a session store');
    if (!isClaimedTicket(ticket) || ticket.purpose !== 'reset' || ticket.expiresAt <= this.now()) {
      return { ok: false, reason: 'invalid-ticket' };
    }
    const ticketName = typeof ticket.username === 'string' ? normalizeUsername(ticket.username) : '';
    if (!USERNAME_PATTERN.test(ticketName)) return { ok: false, reason: 'invalid-ticket' };
    try {
      deriveIdentitySubkey(this.identityKeyFile, 'user-record');
    } catch (err) {
      if (err instanceof IdentityKeyError) this.reportKeyError(err);
      return { ok: false, reason: 'identity-key-unavailable' };
    }
    if (!consumeClaimedTicket(ticket)) return { ok: false, reason: 'invalid-ticket' };

    const r = this.redis();
    const raw = await r.get(OWNER_RECORD_KEY);
    if (!raw) return { ok: false, reason: 'no-owner' };
    const trusted = this.unseal(raw, false);
    if (trusted && trusted.username !== ticketName) return { ok: false, reason: 'username-mismatch' };

    const passwordHash = await hashPassword(password);
    const user: StoredUser = trusted
      ? { ...trusted, passwordHash }
      : {
        id: DEFAULT_OWNER_ID, username: ticketName, passwordHash,
        role: 'owner', createdAt: untrustedCreatedAt(raw, this.now()), disabled: false,
      };
    if ((await r.eval(SET_IF_UNCHANGED, 1, OWNER_RECORD_KEY, raw, this.seal(user))) !== 1) {
      return { ok: false, reason: 'conflict' };
    }
    this.reportedTamper = null;

    let sessionsRevoked: number | null = null;
    try { sessionsRevoked = await this.sessions.revokeByMethod('password'); } catch { /* reported below */ }
    try {
      await this.onOwnerRecovered?.({
        username: user.username, recordTrusted: !!trusted,
        usernameSource: trusted ? 'record' : 'ticket', sessionsRevoked,
      });
    } catch { /* the recovery itself succeeded */ }
    return { ok: true, user: accountOf(user), recordTrusted: !!trusted, sessionsRevoked };
  }
}
