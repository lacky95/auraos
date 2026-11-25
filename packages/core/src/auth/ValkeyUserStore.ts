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
import { IDENTITY_AUDIT_ACTIONS, userAttribution, type AuditInput } from './AdminAudit.js';
import { deriveIdentitySubkey, IdentityKeyError, identityKeyStatus, type IdentityKeyStatus } from './identityKey.js';
import {
  DEFAULT_OWNER_ID,
  type LoginSessions, type PasswordCheck, type SetupTicket, type UserAccount, type UserStore,
} from './identityContracts.js';
import {
  DEFAULT_PASSWORD_POLICY, PASSWORD_MAX_BYTES, parsePasswordPolicy, passwordViolation,
  type PasswordPolicy, type PasswordRule,
} from './passwordPolicy.js';
import type { UserRole } from './types.js';

export const OWNER_RECORD_KEY = `user:${DEFAULT_OWNER_ID}`;
/** The sealed password policy (passwordPolicy.ts). Missing means the defaults. */
export const PASSWORD_POLICY_KEY = 'user:policy:password';
export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/;
export const LOGIN_ATTEMPTS_PER_KEY_PER_MINUTE = 10;

const SCRYPT = { N: 2 ** 17, r: 8, p: 1, keyLen: 32, saltLen: 16 } as const;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
const MAX_QUEUED_VERIFIES = 8;
/** Compare-and-set, so a concurrent change is never overwritten. */
const SET_IF_UNCHANGED = `if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2]) return 1 end return 0`;

export class UserStoreError extends Error {
  constructor(
    readonly code: 'invalid-username' | 'invalid-password' | 'invalid-policy',
    message: string,
    /** For `invalid-password`: the rule the password broke. */
    readonly rule?: PasswordRule,
  ) {
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

/** `invalid` covers a wrong current password and a caller that is not the enabled owner. */
export type OwnerCredentialRefusal = { ok: false; reason: 'invalid' | 'rate-limited' | 'conflict' };

export type PasswordChangeResult =
  | {
    ok: true;
    /** The owner's other sessions that were signed out; null when revoking failed. */
    sessionsRevoked: number | null;
  }
  | OwnerCredentialRefusal;

export type PasswordPolicyChangeResult =
  | { ok: true; previous: PasswordPolicy; policy: PasswordPolicy }
  | OwnerCredentialRefusal;

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

const RULE_MESSAGES: Record<PasswordRule, (p: PasswordPolicy) => string> = {
  length: (p) => `password must have at least ${p.minLength} characters`,
  'max-bytes': () => `password must be at most ${PASSWORD_MAX_BYTES} bytes`,
  classes: (p) => `password must use at least ${p.requiredClasses} of lowercase, uppercase, digits and other characters`,
  username: () => 'password must differ from the username',
};

/** The one check for a new password: setup, recovery and change all call it. */
function assertPassword(
  password: unknown,
  opts: { username?: string; policy: PasswordPolicy },
): asserts password is string {
  const rule = passwordViolation(password, opts);
  if (rule) throw new UserStoreError('invalid-password', RULE_MESSAGES[rule](opts.policy), rule);
}

const policyEquals = (a: PasswordPolicy, b: PasswordPolicy) =>
  a.minLength === b.minLength && a.requiredClasses === b.requiredClasses && a.differFromUsername === b.differFromUsername;

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
  /** Required by `recoverOwnerPassword` (every password session) and `changeOwnerPassword` (the owner's others). */
  sessions?: Pick<LoginSessions, 'revokeByMethod' | 'revokeByUser'>;
  /** Audit hook for a completed recovery. Its failure never undoes the recovery. */
  onOwnerRecovered?: (e: OwnerRecoveryEvent) => Promise<void> | void;
  /** The audit trail for password and policy changes. Its failure never undoes the change. */
  audit?: { record(entry: AuditInput): Promise<unknown> };
  /** The stored password policy failed its MAC, so the defaults apply. Reported once per record. */
  onPolicyTampered?: () => void;
}

export class ValkeyUserStore implements UserStore {
  private readonly redis: () => Redis;
  private readonly now: () => number;
  private readonly identityKeyFile: string;
  private readonly onTampered?: () => void;
  private readonly onIdentityKeyError?: (err: IdentityKeyError) => void;
  private readonly sessions?: Pick<LoginSessions, 'revokeByMethod' | 'revokeByUser'>;
  private readonly onOwnerRecovered?: (e: OwnerRecoveryEvent) => Promise<void> | void;
  private readonly audit?: { record(entry: AuditInput): Promise<unknown> };
  private readonly onPolicyTampered?: () => void;
  private keyErrorReported = false;
  /** Digest of the last bad record, so one tampering is reported once. */
  private reportedTamper: string | null = null;
  /** The same for the policy record. */
  private reportedPolicyTamper: string | null = null;
  private epoch = 0;

  constructor(opts: ValkeyUserStoreOptions) {
    this.identityKeyFile = opts.identityKeyFile;
    this.redis = opts.redis;
    this.now = opts.now ?? Date.now;
    this.onTampered = opts.onTampered;
    this.onIdentityKeyError = opts.onIdentityKeyError;
    this.sessions = opts.sessions;
    this.onOwnerRecovered = opts.onOwnerRecovered;
    this.audit = opts.audit;
    this.onPolicyTampered = opts.onPolicyTampered;
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

  /**
   * Moves after each password recovery or change, before sessions are revoked. A
   * login that checked the old password compares this after issuing: either
   * the revoke removed its session, or it sees the change and revokes it.
   */
  credentialEpoch(): number {
    return this.epoch;
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
    assertPassword(input.password, { username, policy: await this.getPasswordPolicy() });
    if (await this.hasOwner()) return null; // Skip the expensive hash; SET NX below is the real guard.
    deriveIdentitySubkey(this.identityKeyFile, 'user-record'); // Fail before hashing on a bad key.
    const user: StoredUser = {
      id: DEFAULT_OWNER_ID, username, passwordHash: await hashPassword(input.password),
      role: 'owner', createdAt: this.now(), disabled: false,
    };
    const created = await this.redis().set(OWNER_RECORD_KEY, this.seal(user), 'NX');
    return created === 'OK' ? accountOf(user) : null;
  }

  /**
   * Counts this attempt for its client. True when it is over the limit, or the
   * limit can't be checked. There is no global bucket and no shared bucket for
   * unattributed callers, because either would let one caller lock out the
   * owner. `MAX_QUEUED_VERIFIES` and serialized hashing bound the cost.
   */
  private async overLimit(rateLimitKey?: string): Promise<boolean> {
    if (!rateLimitKey) return false;
    const minute = Math.floor(this.now() / 60_000);
    const id = createHash('sha256').update(rateLimitKey).digest('hex').slice(0, 32);
    const bucket = `ratelimit:login:key:${id}:${minute}`;
    try {
      const r = this.redis();
      const n = await r.incr(bucket);
      if (n === 1) await r.pexpire(bucket, 120_000);
      return n > LOGIN_ATTEMPTS_PER_KEY_PER_MINUTE;
    } catch {
      return true;
    }
  }

  /**
   * @param opts.rateLimitKey  the caller's identity for the per-client limit,
   *   e.g. its address. Stored only as a hash. Without one, only the hashing
   *   queue limits the attempt.
   */
  async verifyPassword(username: string, password: string, opts: { rateLimitKey?: string } = {}): Promise<PasswordCheck> {
    const name = typeof username === 'string' ? normalizeUsername(username).slice(0, 64) : '';
    if (await this.overLimit(opts.rateLimitKey)) return { ok: false, reason: 'rate-limited' };
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

  /**
   * Operator recovery, e.g. after identity.key was lost or replaced. Needs the
   * object returned by a successful `FileSetupTickets.claim(code, 'reset')`,
   * which it spends. Re-seals the owner record even if its MAC fails, then
   * revokes every password session. When the MAC fails, nothing in the old
   * record is trusted: the username comes from the ticket and the account is
   * re-enabled. Audited through `onOwnerRecovered`.
   */
  async recoverOwnerPassword(ticket: SetupTicket, password: string): Promise<OwnerRecoveryResult> {
    const policy = await this.getPasswordPolicy();
    assertPassword(password, { policy });
    if (!this.sessions) throw new Error('recoverOwnerPassword needs a session store');
    if (!isClaimedTicket(ticket) || ticket.purpose !== 'reset' || ticket.expiresAt <= this.now()) {
      return { ok: false, reason: 'invalid-ticket' };
    }
    const ticketName = typeof ticket.username === 'string' ? normalizeUsername(ticket.username) : '';
    if (!USERNAME_PATTERN.test(ticketName)) return { ok: false, reason: 'invalid-ticket' };
    // The username is known only from the ticket, so this rule is checked here.
    assertPassword(password, { username: ticketName, policy });
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
    this.epoch += 1;

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

  // ── password policy ───────────────────────────────────────────────────────

  private policyMac(p: PasswordPolicy): Buffer {
    const key = deriveIdentitySubkey(this.identityKeyFile, 'password-policy');
    const canonical = JSON.stringify([PASSWORD_POLICY_KEY, 1, p.minLength, p.requiredClasses, p.differFromUsername]);
    return createHmac('sha256', key).update(canonical).digest();
  }

  private sealPolicy(p: PasswordPolicy): string {
    return JSON.stringify({ v: 1, ...p, mac: this.policyMac(p).toString('base64url') });
  }

  /** The stored policy if its MAC holds, else null. Reports a bad record once. */
  private unsealPolicy(raw: string): PasswordPolicy | null {
    try {
      const o = JSON.parse(raw) as Record<string, unknown>;
      const policy = o['v'] === 1 ? parsePasswordPolicy(o) : null;
      if (!policy || typeof o['mac'] !== 'string') throw new Error('shape');
      const given = Buffer.from(o['mac'], 'base64url');
      const want = this.policyMac(policy);
      if (given.length !== want.length || !timingSafeEqual(given, want)) throw new Error('mac');
      return policy;
    } catch (err) {
      if (err instanceof IdentityKeyError) {
        this.reportKeyError(err);
        return null;
      }
      const digest = createHash('sha256').update(raw).digest('hex');
      if (digest !== this.reportedPolicyTamper) {
        this.reportedPolicyTamper = digest;
        this.onPolicyTampered?.();
      }
      return null;
    }
  }

  /**
   * The rules for new passwords. A missing or invalid record means the
   * defaults, so tampering can only ever reset the policy, never lower it
   * below them.
   */
  async getPasswordPolicy(): Promise<PasswordPolicy> {
    const raw = await this.redis().get(PASSWORD_POLICY_KEY);
    return (raw && this.unsealPolicy(raw)) || { ...DEFAULT_PASSWORD_POLICY };
  }

  /** The rule a new password breaks, or null. The shell asks before spending a setup code. */
  async checkNewPassword(password: unknown, username?: string): Promise<PasswordRule | null> {
    const name = typeof username === 'string' ? normalizeUsername(username) : undefined;
    return passwordViolation(password, { username: name, policy: await this.getPasswordPolicy() });
  }

  /**
   * The current, enabled owner `userId` proving `current` through
   * `verifyPassword`, so the login rate limit applies. Returns the raw record
   * it read, for a compare-and-set.
   */
  private async ownerProof(
    userId: string, current: unknown, rateLimitKey?: string,
  ): Promise<{ ok: true; raw: string; user: StoredUser } | OwnerCredentialRefusal> {
    const raw = await this.redis().get(OWNER_RECORD_KEY);
    const user = raw ? this.unseal(raw) : null;
    if (!raw || !user || user.id !== userId || user.disabled) {
      // Still counts against the rate limit, like any failed attempt.
      if (await this.overLimit(rateLimitKey)) return { ok: false, reason: 'rate-limited' };
      return { ok: false, reason: 'invalid' };
    }
    const check = await this.verifyPassword(user.username, typeof current === 'string' ? current : '', { rateLimitKey });
    if (!check.ok) return { ok: false, reason: check.reason };
    return { ok: true, raw, user };
  }

  private async record(entry: AuditInput): Promise<void> {
    try { await this.audit?.record(entry); } catch { /* the change itself succeeded */ }
  }

  /**
   * The signed-in owner changes their password. Checks `current` first
   * (rate limited), applies the policy to `next`, writes with
   * compare-and-set, moves the credential epoch and signs out every other
   * session of the owner, keeping `keepSessionId`. Audited as
   * `auth.password-changed`.
   */
  async changeOwnerPassword(
    userId: string,
    current: string,
    next: string,
    keepSessionId: string,
    opts: { rateLimitKey?: string } = {},
  ): Promise<PasswordChangeResult> {
    if (!this.sessions) throw new Error('changeOwnerPassword needs a session store');
    const policy = await this.getPasswordPolicy();
    // The username rule needs the record; the others are checked before any hashing.
    assertPassword(next, { policy });
    const proof = await this.ownerProof(userId, current, opts.rateLimitKey);
    if (!proof.ok) return proof;
    assertPassword(next, { username: proof.user.username, policy });

    const user: StoredUser = { ...proof.user, passwordHash: await hashPassword(next) };
    if ((await this.redis().eval(SET_IF_UNCHANGED, 1, OWNER_RECORD_KEY, proof.raw, this.seal(user))) !== 1) {
      return { ok: false, reason: 'conflict' };
    }
    this.epoch += 1;

    let sessionsRevoked: number | null = null;
    try { sessionsRevoked = await this.sessions.revokeByUser(userId, { except: keepSessionId }); } catch { /* reported below */ }
    await this.record({
      by: userAttribution({ userId, sessionId: keepSessionId }), action: IDENTITY_AUDIT_ACTIONS.passwordChanged,
      target: `user:${userId}`, outcome: sessionsRevoked === null ? 'failed' : 'ok', detail: { sessionsRevoked },
    });
    return { ok: true, sessionsRevoked };
  }

  /**
   * The owner sets the password policy, proving `current` (rate limited).
   * Existing passwords stay valid: only new and changed ones are checked.
   * Audited as `auth.password-policy-changed` with the old and new rules.
   * Throws `UserStoreError('invalid-policy')` for out-of-range rules.
   */
  async setPasswordPolicy(
    input: unknown,
    opts: { userId: string; current: string; sessionId?: string; rateLimitKey?: string },
  ): Promise<PasswordPolicyChangeResult> {
    const policy = parsePasswordPolicy(input);
    if (!policy) throw new UserStoreError('invalid-policy', 'password policy out of range');
    deriveIdentitySubkey(this.identityKeyFile, 'password-policy'); // Fail before hashing on a bad key.
    const proof = await this.ownerProof(opts.userId, opts.current, opts.rateLimitKey);
    if (!proof.ok) return proof;

    const r = this.redis();
    const raw = await r.get(PASSWORD_POLICY_KEY);
    const previous = (raw && this.unsealPolicy(raw)) || { ...DEFAULT_PASSWORD_POLICY };
    if (!policyEquals(previous, policy)) {
      const written = raw
        ? (await r.eval(SET_IF_UNCHANGED, 1, PASSWORD_POLICY_KEY, raw, this.sealPolicy(policy))) === 1
        : (await r.set(PASSWORD_POLICY_KEY, this.sealPolicy(policy), 'NX')) === 'OK';
      if (!written) return { ok: false, reason: 'conflict' };
      this.reportedPolicyTamper = null;
      await this.record({
        by: userAttribution({ userId: opts.userId, sessionId: opts.sessionId }),
        action: IDENTITY_AUDIT_ACTIONS.passwordPolicyChanged, target: PASSWORD_POLICY_KEY,
        detail: { from: previous, to: policy },
      });
    }
    return { ok: true, previous, policy };
  }
}
