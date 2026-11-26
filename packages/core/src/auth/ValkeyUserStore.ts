/**
 * The user accounts (D5, D16, D82, D83; Phase 5 I.2). `/api/kv` cannot reach
 * the `user:` or `ident:` namespaces.
 *
 *   user:<userId>              sealed JSON v2 { v: 2, id, username, role: 'owner'|'member', createdAt,
 *                                               disabled, passwordHash: string|null, externalIdentities: [], mac }
 *   ident:username:<username>  STRING <userId>  (the username index; only authentication reads it)
 *   ident:user:tomb:<userId>   STRING "retired" (never reused; written only by a future explicit delete)
 *
 * The owner keeps `id = default` (D47 rule 2) and is created only by
 * `createOwner` (the setup code): exactly one owner, and it always has a
 * password (break-glass, D83 §3). Members get generated ids (`u` + 15
 * lowercase base32 characters), never derived from the username.
 *
 * Each record carries a MAC from identity.key over its key and every field,
 * so a Valkey writer cannot swap the hash, username or role, move a record
 * to another id, or plant an external identity link. A record that fails the
 * MAC never authenticates, and the owner's still counts as an existing owner
 * so setup cannot replace it. Only `recoverOwnerPassword`, with a claimed
 * reset ticket, can re-seal the owner's. `externalIdentities` is reserved for
 * D83 §4 and must be empty in Phase 5: a record holding anything else does
 * not unseal.
 *
 * The v1 owner record (before I.2: no `v`, a MAC over the fixed owner key) is
 * still read for one release and re-sealed as v2 by `migrateRecords` at boot.
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
  type LoginSessions, type PasswordCheck, type SetupTicket, type UserAccount, type UserProfiles, type UserStore,
} from './identityContracts.js';
import { PROFILE_FIELDS, PROFILE_FIELD_NAMES, type ProfileFieldName, type UserProfile } from '../users/profileRegistry.js';
import { readUserPref, userPrefsNamespace, type UserDataKv } from '../users/userData.js';
import {
  DEFAULT_PASSWORD_POLICY, PASSWORD_MAX_BYTES, parsePasswordPolicy, passwordViolation,
  type PasswordPolicy, type PasswordRule,
} from './passwordPolicy.js';
import type { ChangeAttribution, UserRole } from './types.js';

export const userRecordKey = (userId: string): string => `user:${userId}`;
export const OWNER_RECORD_KEY = userRecordKey(DEFAULT_OWNER_ID);
/** The username index (I.2): authentication's one lookup from a name to an id. */
export const usernameIndexKey = (username: string): string => `ident:username:${username}`;
/** Reserved: a retired user id, never handed out again. Nothing writes it in Phase 5. */
export const userTombstoneKey = (userId: string): string => `ident:user:tomb:${userId}`;
/** The profile record (D46), versioned. Not sealed: it holds nothing that grants anything. */
export const profileKey = (userId: string): string => `user:${userId}:profile`;
/** The sealed password policy (passwordPolicy.ts). Missing means the defaults. */
export const PASSWORD_POLICY_KEY = 'user:policy:password';
export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/;
/**
 * Every local user id: the owner's `default` and the generated ones. It fits
 * the instance owner label, the GrantStore id and `aura-term-<userId>` (C10).
 */
export const USER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** A generated id: `u` plus 15 lowercase base32 characters (75 random bits). */
export const GENERATED_USER_ID_PATTERN = /^u[a-z2-7]{15}$/;
export const USER_RECORD_VERSION = 2;
export const LOGIN_ATTEMPTS_PER_KEY_PER_MINUTE = 10;

const SCRYPT = { N: 2 ** 17, r: 8, p: 1, keyLen: 32, saltLen: 16 } as const;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
const MAX_QUEUED_VERIFIES = 8;
/** Compare-and-set, so a concurrent change is never overwritten. */
const SET_IF_UNCHANGED = `if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2]) return 1 end return 0`;
/**
 * A new account: record and index together, or nothing. KEYS: record, index,
 * tombstone; ARGV: sealed record, its id. Returns {'ok'} | {'existing',
 * <userId>} (another account holds the username) | {'collision'} (the id is
 * taken: try another). An index entry already naming this id (the owner's,
 * left behind by a removed record) is rewritten.
 */
const CREATE_ACCOUNT = `
local holder = redis.call('GET', KEYS[2])
if holder and holder ~= ARGV[2] then return {'existing', holder} end
if redis.call('EXISTS', KEYS[1]) == 1 or redis.call('EXISTS', KEYS[3]) == 1 then return {'collision'} end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('SET', KEYS[2], ARGV[2])
return {'ok'}
`;

export class UserStoreError extends Error {
  constructor(
    readonly code: 'invalid-username' | 'invalid-password' | 'invalid-policy' | 'invalid-role',
    message: string,
    /** For `invalid-password`: the rule the password broke. */
    readonly rule?: PasswordRule,
  ) {
    super(message);
    this.name = 'UserStoreError';
  }
}

/** The record as stored (v2), without its MAC. */
interface StoredUser extends UserAccount {
  /** Null: no local password yet (an enrolment is pending). Never null for the owner. */
  passwordHash: string | null;
  /** Reserved (D83 §4): always empty in Phase 5. */
  externalIdentities: [];
}

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
  userId: string;
  username: string;
  recordTrusted: boolean;
  usernameSource: 'record' | 'ticket';
  sessionsRevoked: number | null;
}

/** What `migrateRecords` found and did at boot. Never a record's contents. */
export interface UserRecordMigration {
  /** The owner record was v1 and is now v2. */
  resealed: boolean;
  /** Usernames whose index entry was written. */
  indexed: number;
  /** The owner record failed its MAC (left as it is) or is missing. */
  owner: 'v2' | 'missing' | 'untrusted';
  /** An index entry names another id than the record that holds the name. */
  conflicts: number;
}

/** `diagnose/identity-accounts`: the account invariants, by id only. */
export interface AccountsCheck {
  users: number;
  owners: number;
  members: number;
  disabled: number;
  /** Each names a user id or an index entry by its id, never a hash or a username. */
  findings: string[];
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
const accountOf = ({ passwordHash: _omit, externalIdentities: _ext, ...account }: StoredUser): UserAccount => account;

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
/** A fresh user id (C10): random, lowercase, never derived from the username. */
export function generateUserId(): string {
  return `u${[...randomBytes(15)].map((b) => BASE32[b & 31]!).join('')}`;
}

/** The id a record key names, or null for any other `user:` key (profiles, the policy). */
function userIdOfKey(key: string): string | null {
  const id = key.slice('user:'.length);
  return key.startsWith('user:') && USER_ID_PATTERN.test(id) && id !== 'policy' ? id : null;
}

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
  /** Required by the password resets (the user's sessions) and `changeOwnerPassword` (the owner's others). */
  sessions?: Pick<LoginSessions, 'revokeByUser'>;
  /** Audit hook for a completed owner recovery. Its failure never undoes the recovery. */
  onOwnerRecovered?: (e: OwnerRecoveryEvent) => Promise<void> | void;
  /** The audit trail for account, password and policy changes. Its failure never undoes the change. */
  audit?: { record(entry: AuditInput): Promise<unknown> };
  /** The stored password policy failed its MAC, so the defaults apply. Reported once per record. */
  onPolicyTampered?: () => void;
  /** Stream I: a new member gets its Linux identity eagerly (`createUser`). */
  identity?: { ensureUser(userId: string): Promise<unknown> };
}

export class ValkeyUserStore implements UserStore, UserProfiles {
  private readonly redis: () => Redis;
  private readonly now: () => number;
  private readonly identityKeyFile: string;
  private readonly onTampered?: () => void;
  private readonly onIdentityKeyError?: (err: IdentityKeyError) => void;
  private readonly sessions?: Pick<LoginSessions, 'revokeByUser'>;
  private readonly onOwnerRecovered?: (e: OwnerRecoveryEvent) => Promise<void> | void;
  private readonly audit?: { record(entry: AuditInput): Promise<unknown> };
  private readonly onPolicyTampered?: () => void;
  private readonly identity?: { ensureUser(userId: string): Promise<unknown> };
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
    this.identity = opts.identity;
  }

  /** v2: the record key and every field, `externalIdentities` included. */
  private mac(u: StoredUser): Buffer {
    const key = deriveIdentitySubkey(this.identityKeyFile, 'user-record');
    const canonical = JSON.stringify([
      userRecordKey(u.id), USER_RECORD_VERSION, u.id, u.username, u.passwordHash, u.role, u.createdAt, u.disabled, u.externalIdentities,
    ]);
    return createHmac('sha256', key).update(canonical).digest();
  }

  /** v1 (before I.2), read for one release: the owner only, over the fixed owner key. */
  private macV1(u: StoredUser): Buffer {
    const key = deriveIdentitySubkey(this.identityKeyFile, 'user-record');
    const canonical = JSON.stringify([OWNER_RECORD_KEY, u.id, u.username, u.passwordHash, u.role, u.createdAt, u.disabled]);
    return createHmac('sha256', key).update(canonical).digest();
  }

  private seal(u: StoredUser): string {
    if (u.role === 'owner' && u.passwordHash === null) throw new Error('the owner always has a password');
    return JSON.stringify({ v: USER_RECORD_VERSION, ...u, mac: this.mac(u).toString('base64url') });
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

  /** The record at `key` if its MAC is valid, with its version. */
  private unsealVersioned(key: string, raw: string | null, report = true): { user: StoredUser; v: 1 | 2 } | null {
    if (!raw) return null;
    try {
      const o = JSON.parse(raw) as Partial<StoredUser> & { mac?: unknown; v?: unknown };
      const v1 = o.v === undefined;
      if (!v1 && o.v !== USER_RECORD_VERSION) throw new Error('version');
      const role = o.role;
      const hash = o.passwordHash;
      if (typeof o.id !== 'string' || userRecordKey(o.id) !== key || typeof o.username !== 'string'
        || (role !== 'owner' && role !== 'member') || typeof o.createdAt !== 'number' || typeof o.disabled !== 'boolean'
        || typeof o.mac !== 'string') throw new Error('shape');
      // v1 was the owner's alone; the owner always has a password (break-glass).
      if (v1 && (role !== 'owner' || key !== OWNER_RECORD_KEY)) throw new Error('shape');
      if (hash !== null && typeof hash !== 'string') throw new Error('shape');
      if ((v1 || role === 'owner') && typeof hash !== 'string') throw new Error('owner without a password');
      // Reserved (D83 §4): nothing may plant an external identity link before the feature exists.
      if (!v1 && !(Array.isArray(o.externalIdentities) && o.externalIdentities.length === 0)) throw new Error('external identities');
      const u: StoredUser = {
        id: o.id, username: o.username, passwordHash: hash as string | null,
        role: role as UserRole, createdAt: o.createdAt, disabled: o.disabled, externalIdentities: [],
      };
      const given = Buffer.from(o.mac, 'base64url');
      const want = v1 ? this.macV1(u) : this.mac(u);
      this.keyErrorReported = false;
      if (given.length !== want.length || !timingSafeEqual(given, want)) throw new Error('mac');
      return { user: u, v: v1 ? 1 : 2 };
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

  private unseal(key: string, raw: string | null, report = true): StoredUser | null {
    return this.unsealVersioned(key, raw, report)?.user ?? null;
  }

  private async readUser(userId: string): Promise<{ raw: string; user: StoredUser } | null> {
    if (typeof userId !== 'string' || !USER_ID_PATTERN.test(userId)) return null;
    const raw = await this.redis().get(userRecordKey(userId));
    const user = raw ? this.unseal(userRecordKey(userId), raw) : null;
    return raw && user ? { raw, user } : null;
  }

  async hasOwner(): Promise<boolean> {
    return (await this.redis().exists(OWNER_RECORD_KEY)) > 0;
  }

  async getOwner(): Promise<UserAccount | null> {
    const u = (await this.readUser(DEFAULT_OWNER_ID))?.user;
    return u && u.role === 'owner' ? accountOf(u) : null;
  }

  /** The account `userId` names, any role (C1). Null for an unknown id or a record that fails its MAC. */
  async getUser(userId: string): Promise<UserAccount | null> {
    const u = (await this.readUser(userId))?.user;
    return u ? accountOf(u) : null;
  }

  /** The id the username index names, or null. Authentication's lookup only. */
  async userIdOf(username: string): Promise<string | null> {
    const name = typeof username === 'string' ? normalizeUsername(username) : '';
    if (!USERNAME_PATTERN.test(name)) return null;
    const id = await this.redis().get(usernameIndexKey(name));
    return id && USER_ID_PATTERN.test(id) ? id : null;
  }

  /** Every account whose record verifies, by id. */
  async listUsers(): Promise<UserAccount[]> {
    const out: UserAccount[] = [];
    for (const key of await this.scanKeys('user:*')) {
      const id = userIdOfKey(key);
      if (!id) continue;
      const u = await this.getUser(id);
      if (u) out.push(u);
    }
    return out.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  private async scanKeys(pattern: string): Promise<string[]> {
    const out: string[] = [];
    let cursor = '0';
    do {
      const [next, keys] = await this.redis().scan(cursor, 'MATCH', pattern, 'COUNT', 1000);
      cursor = next;
      out.push(...keys);
    } while (cursor !== '0');
    return out.sort();
  }

  async createOwner(input: { username: string; password: string }): Promise<UserAccount | null> {
    const username = typeof input.username === 'string' ? normalizeUsername(input.username) : '';
    if (!USERNAME_PATTERN.test(username)) {
      throw new UserStoreError('invalid-username', 'username must be 1-32 letters, digits, ".", "_" or "-"');
    }
    assertPassword(input.password, { username, policy: await this.getPasswordPolicy() });
    if (await this.hasOwner()) return null; // Skip the expensive hash; the script below is the real guard.
    deriveIdentitySubkey(this.identityKeyFile, 'user-record'); // Fail before hashing on a bad key.
    const user: StoredUser = {
      id: DEFAULT_OWNER_ID, username, passwordHash: await hashPassword(input.password),
      role: 'owner', createdAt: this.now(), disabled: false, externalIdentities: [],
    };
    const out = await this.redis().eval(CREATE_ACCOUNT, 3,
      OWNER_RECORD_KEY, usernameIndexKey(username), userTombstoneKey(DEFAULT_OWNER_ID), this.seal(user), DEFAULT_OWNER_ID) as string[];
    return out[0] === 'ok' ? accountOf(user) : null;
  }

  /**
   * A member account (D82), with no password yet: the member sets it with a
   * one-time enrolment code (`setPasswordWithTicket`). Idempotent on the
   * username: an existing one returns its account unchanged. Never an owner
   * (one owner, D5/D16). Gives the user its Linux identity eagerly (stream I)
   * and audits `auth.user-created` by id.
   *
   * Plumbing only in 5-pre2: no route or command calls it until 5-main
   * (`aura admin user add`, I.2 part 2).
   */
  async createUser(input: { username: string; role?: UserRole }, by: ChangeAttribution): Promise<{ user: UserAccount; created: boolean }> {
    if (input.role !== undefined && input.role !== 'member') throw new UserStoreError('invalid-role', 'only member accounts can be created; there is one owner');
    const username = typeof input.username === 'string' ? normalizeUsername(input.username) : '';
    if (!USERNAME_PATTERN.test(username)) {
      throw new UserStoreError('invalid-username', 'username must be 1-32 letters, digits, ".", "_" or "-"');
    }
    deriveIdentitySubkey(this.identityKeyFile, 'user-record');
    for (let attempt = 0; attempt < 8; attempt++) {
      const user: StoredUser = {
        id: generateUserId(), username, passwordHash: null,
        role: 'member', createdAt: this.now(), disabled: false, externalIdentities: [],
      };
      const out = await this.redis().eval(CREATE_ACCOUNT, 3,
        userRecordKey(user.id), usernameIndexKey(username), userTombstoneKey(user.id), this.seal(user), user.id) as string[];
      if (out[0] === 'existing') {
        const existing = await this.getUser(out[1]!);
        if (!existing) throw new Error('the username index names an account that does not verify');
        return { user: existing, created: false };
      }
      if (out[0] !== 'ok') continue;
      await this.identity?.ensureUser(user.id);
      await this.record({ by, action: IDENTITY_AUDIT_ACTIONS.userCreated, target: `user:${user.id}`, detail: { username, role: user.role } });
      return { user: accountOf(user), created: true };
    }
    throw new Error('could not allocate a user id');
  }

  /**
   * Disable or enable an account (D82). Disabling takes effect on the next
   * request everywhere (the per-request checks read the record) and revokes
   * the user's login sessions. Deletes nothing. The owner is never disabled
   * (break-glass). Audited by id.
   */
  async setDisabled(userId: string, disabled: boolean, by: ChangeAttribution): Promise<{ ok: true; changed: boolean; sessionsRevoked: number | null } | { ok: false; reason: 'no-user' | 'owner' | 'conflict' }> {
    const found = await this.readUser(userId);
    if (!found) return { ok: false, reason: 'no-user' };
    if (found.user.role === 'owner') return { ok: false, reason: 'owner' };
    if (found.user.disabled === disabled) return { ok: true, changed: false, sessionsRevoked: 0 };
    const next: StoredUser = { ...found.user, disabled };
    if ((await this.redis().eval(SET_IF_UNCHANGED, 1, userRecordKey(userId), found.raw, this.seal(next))) !== 1) {
      return { ok: false, reason: 'conflict' };
    }
    let sessionsRevoked: number | null = 0;
    if (disabled) {
      sessionsRevoked = null;
      try { sessionsRevoked = await this.sessions?.revokeByUser(userId) ?? null; } catch { /* reported below */ }
    }
    await this.record({
      by, action: disabled ? IDENTITY_AUDIT_ACTIONS.userDisabled : IDENTITY_AUDIT_ACTIONS.userEnabled,
      target: `user:${userId}`, outcome: disabled && sessionsRevoked === null ? 'failed' : 'ok', detail: { sessionsRevoked },
    });
    return { ok: true, changed: true, sessionsRevoked };
  }

  /**
   * Boot (I.2): re-seal a v1 owner record as v2 (its MAC must hold; a record
   * that fails it stays as it is, the tampered state recovery handles), and
   * write the username index for every account that verifies. Idempotent.
   */
  async migrateRecords(): Promise<UserRecordMigration> {
    const out: UserRecordMigration = { resealed: false, indexed: 0, owner: 'missing', conflicts: 0 };
    const r = this.redis();
    const raw = await r.get(OWNER_RECORD_KEY);
    if (raw) {
      const found = this.unsealVersioned(OWNER_RECORD_KEY, raw);
      if (!found) out.owner = 'untrusted';
      else {
        out.owner = 'v2';
        if (found.v === 1 && (await r.eval(SET_IF_UNCHANGED, 1, OWNER_RECORD_KEY, raw, this.seal(found.user))) === 1) out.resealed = true;
      }
    }
    for (const u of await this.listUsers()) {
      const key = usernameIndexKey(u.username);
      if ((await r.set(key, u.id, 'NX')) === 'OK') out.indexed++;
      else if ((await r.get(key)) !== u.id) out.conflicts++;
    }
    return out;
  }

  /**
   * The account invariants (`diagnose/identity-accounts`, D83): every record
   * verifies as v2; exactly one owner, with a password; the username index
   * and the records agree 1:1; no external identity is linked. By id only.
   */
  async checkAccounts(): Promise<AccountsCheck> {
    const findings: string[] = [];
    const r = this.redis();
    const ids = (await this.scanKeys('user:*')).map(userIdOfKey).filter((id): id is string => !!id);
    const accounts: UserAccount[] = [];
    for (const id of ids) {
      const raw = await r.get(userRecordKey(id));
      const found = this.unsealVersioned(userRecordKey(id), raw, false);
      if (!found) { findings.push(`user:${id}: does not verify`); continue; }
      if (found.v !== USER_RECORD_VERSION) findings.push(`user:${id}: record is v${found.v}, not v${USER_RECORD_VERSION}`);
      accounts.push(accountOf(found.user));
    }
    const owners = accounts.filter((a) => a.role === 'owner');
    if (owners.length !== 1) findings.push(`${owners.length} owner accounts (want exactly 1)`);
    if (owners[0] && owners[0].id !== DEFAULT_OWNER_ID) findings.push(`the owner is ${owners[0].id}, not ${DEFAULT_OWNER_ID}`);
    const byName = new Map(accounts.map((a) => [a.username, a.id]));
    for (const a of accounts) {
      if ((await r.get(usernameIndexKey(a.username))) !== a.id) findings.push(`user:${a.id}: the username index does not name this account`);
    }
    for (const key of await this.scanKeys('ident:username:*')) {
      const name = key.slice('ident:username:'.length);
      const id = await r.get(key);
      if (!id || byName.get(name) !== id) findings.push(`index entry for ${id ?? '(none)'}: no verified account holds that username`);
    }
    return {
      users: accounts.length, owners: owners.length, members: accounts.filter((a) => a.role === 'member').length,
      disabled: accounts.filter((a) => a.disabled).length, findings,
    };
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
   * The record a username signs in to: through the index, else (an owner
   * record not yet migrated) the owner record if it holds that name.
   */
  private async userByName(name: string): Promise<StoredUser | null> {
    const id = await this.userIdOf(name);
    if (id) {
      const u = (await this.readUser(id))?.user ?? null;
      return u && u.username === name ? u : null;
    }
    const owner = (await this.readUser(DEFAULT_OWNER_ID))?.user ?? null;
    return owner && owner.username === name ? owner : null;
  }

  /**
   * Any enabled account with a local password (C1, C3); the role is the
   * record's. Same work on every miss: the dummy hash.
   *
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
      let candidate: StoredUser | null = null;
      try { candidate = USERNAME_PATTERN.test(name) ? await this.userByName(name) : null; } catch { candidate = null; }
      const matches = await checkHash(password, candidate?.passwordHash ?? dummyHash());
      if (!candidate || candidate.passwordHash === null || !matches || candidate.disabled) return { ok: false, reason: 'invalid' };
      return { ok: true, user: accountOf(candidate) };
    } catch {
      return { ok: false, reason: 'invalid' };
    } finally {
      queuedVerifies--;
    }
  }

  /**
   * The one ticket-based password set (I.2, C5): an enrolment or a reset, for
   * any account. Needs the object returned by a successful
   * `FileSetupTickets.claim(code, 'reset')`, which it spends. The ticket names
   * its account by `userId` (shell-made) or by username (the host CLI's
   * `aura user reset-password`), resolved through the index. Revokes only
   * that user's sessions (`revokeByUser`). The owner goes through
   * `recoverOwnerPassword`, which keeps its MAC-failure re-seal path.
   */
  async setPasswordWithTicket(ticket: SetupTicket, password: string): Promise<OwnerRecoveryResult> {
    const policy = await this.getPasswordPolicy();
    assertPassword(password, { policy });
    if (!this.sessions) throw new Error('setPasswordWithTicket needs a session store');
    if (!isClaimedTicket(ticket) || ticket.purpose !== 'reset' || ticket.expiresAt <= this.now()) {
      return { ok: false, reason: 'invalid-ticket' };
    }
    const ticketName = typeof ticket.username === 'string' ? normalizeUsername(ticket.username) : undefined;
    const userId = ticket.userId ?? (ticketName ? await this.userIdOf(ticketName) : null);
    if (!userId || userId === DEFAULT_OWNER_ID) return this.recoverOwnerPassword(ticket, password);

    try {
      deriveIdentitySubkey(this.identityKeyFile, 'user-record');
    } catch (err) {
      if (err instanceof IdentityKeyError) this.reportKeyError(err);
      return { ok: false, reason: 'identity-key-unavailable' };
    }
    const found = await this.readUser(userId);
    if (!found || found.user.role !== 'member') return { ok: false, reason: 'invalid-ticket' };
    if (ticketName !== undefined && found.user.username !== ticketName) return { ok: false, reason: 'username-mismatch' };
    assertPassword(password, { username: found.user.username, policy });
    if (!consumeClaimedTicket(ticket)) return { ok: false, reason: 'invalid-ticket' };

    const user: StoredUser = { ...found.user, passwordHash: await hashPassword(password) };
    if ((await this.redis().eval(SET_IF_UNCHANGED, 1, userRecordKey(userId), found.raw, this.seal(user))) !== 1) {
      return { ok: false, reason: 'conflict' };
    }
    this.epoch += 1;
    let sessionsRevoked: number | null = null;
    try { sessionsRevoked = await this.sessions.revokeByUser(userId); } catch { /* reported below */ }
    await this.record({
      by: { kind: 'operator' }, action: IDENTITY_AUDIT_ACTIONS.passwordReset, target: `user:${userId}`,
      outcome: sessionsRevoked === null ? 'failed' : 'ok',
      detail: { username: user.username, enrolment: found.user.passwordHash === null, sessionsRevoked },
    });
    return { ok: true, user: accountOf(user), recordTrusted: true, sessionsRevoked };
  }

  /**
   * Operator recovery of the owner, e.g. after identity.key was lost or
   * replaced. Needs the object returned by a successful
   * `FileSetupTickets.claim(code, 'reset')`, which it spends. Re-seals the
   * owner record even if its MAC fails, then revokes the owner's sessions
   * (C5: no other user's). When the MAC fails, nothing in the old record is
   * trusted: the username comes from the ticket and the account is
   * re-enabled. Audited through `onOwnerRecovered`.
   */
  async recoverOwnerPassword(ticket: SetupTicket, password: string): Promise<OwnerRecoveryResult> {
    const policy = await this.getPasswordPolicy();
    assertPassword(password, { policy });
    if (!this.sessions) throw new Error('recoverOwnerPassword needs a session store');
    if (!isClaimedTicket(ticket) || ticket.purpose !== 'reset' || ticket.expiresAt <= this.now()) {
      return { ok: false, reason: 'invalid-ticket' };
    }
    if (ticket.userId !== undefined && ticket.userId !== DEFAULT_OWNER_ID) return { ok: false, reason: 'invalid-ticket' };
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
    const trusted = this.unseal(OWNER_RECORD_KEY, raw, false);
    if (trusted && trusted.username !== ticketName) return { ok: false, reason: 'username-mismatch' };
    // An untrusted record is re-sealed under the ticket's name, which no other account may hold.
    const holder = await this.userIdOf(ticketName);
    if (holder && holder !== DEFAULT_OWNER_ID) return { ok: false, reason: 'username-mismatch' };

    const passwordHash = await hashPassword(password);
    const user: StoredUser = trusted
      ? { ...trusted, passwordHash }
      : {
        id: DEFAULT_OWNER_ID, username: ticketName, passwordHash,
        role: 'owner', createdAt: untrustedCreatedAt(raw, this.now()), disabled: false, externalIdentities: [],
      };
    if ((await r.eval(SET_IF_UNCHANGED, 1, OWNER_RECORD_KEY, raw, this.seal(user))) !== 1) {
      return { ok: false, reason: 'conflict' };
    }
    // The index follows the re-sealed name; an entry an untrusted record left for another name goes.
    await r.set(usernameIndexKey(user.username), DEFAULT_OWNER_ID);
    for (const key of await this.scanKeys('ident:username:*')) {
      if (key !== usernameIndexKey(user.username) && (await r.get(key)) === DEFAULT_OWNER_ID) await r.del(key);
    }
    this.reportedTamper = null;
    this.epoch += 1;

    let sessionsRevoked: number | null = null;
    try { sessionsRevoked = await this.sessions.revokeByUser(DEFAULT_OWNER_ID); } catch { /* reported below */ }
    try {
      await this.onOwnerRecovered?.({
        userId: DEFAULT_OWNER_ID, username: user.username, recordTrusted: !!trusted,
        usernameSource: trusted ? 'record' : 'ticket', sessionsRevoked,
      });
    } catch { /* the recovery itself succeeded */ }
    return { ok: true, user: accountOf(user), recordTrusted: !!trusted, sessionsRevoked };
  }

  // ── user and profile (D46) ───────────────────────────────────────────────

  /** The KV view of the raw connection, for the preferences that back profile fields. */
  private prefsKv(): Pick<UserDataKv, 'get' | 'set'> {
    const r = this.redis();
    return {
      get: async <T>(ns: string, key: string) => {
        const raw = await r.get(`${ns}:${key}`);
        if (raw === null) return null;
        try { return JSON.parse(raw) as { value: T; updatedAt: number }; } catch { return null; }
      },
      set: async <T>(ns: string, key: string, value: T) => {
        const entry = { value, updatedAt: this.now() };
        await r.set(`${ns}:${key}`, JSON.stringify(entry));
        return entry;
      },
    };
  }

  private async storedProfile(userId: string): Promise<Record<string, unknown>> {
    try {
      const o = JSON.parse((await this.redis().get(profileKey(userId))) ?? 'null') as Record<string, unknown> | null;
      return o && o['v'] === 1 ? o : {};
    } catch {
      return {};
    }
  }

  async getProfile(userId: string): Promise<UserProfile | null> {
    if (!(await this.getUser(userId))) return null;
    const stored = await this.storedProfile(userId);
    const out: UserProfile = {};
    for (const name of PROFILE_FIELD_NAMES) {
      const field = PROFILE_FIELDS[name] as { pref?: 'locale' };
      const value = field.pref
        ? (await readUserPref<unknown>(this.prefsKv(), userId, field.pref))?.value
        : stored[name];
      // A stored value that no longer validates (hand-edited, older rules) is left out.
      if (typeof value === 'string' && PROFILE_FIELDS[name].validate(value) === null) out[name] = value;
    }
    return out;
  }

  async updateProfile(userId: string, patch: { set: UserProfile; clear: readonly ProfileFieldName[] }): Promise<UserProfile | null> {
    if (!(await this.getUser(userId))) return null;
    const stored = await this.storedProfile(userId);
    const next: Record<string, unknown> = { ...stored, v: 1 };
    let recordChanged = false;
    for (const name of [...Object.keys(patch.set) as ProfileFieldName[], ...patch.clear]) {
      const value = patch.set[name] ?? null;
      const field = PROFILE_FIELDS[name] as { pref?: 'locale' };
      if (field.pref) {
        if (value !== null) await this.prefsKv().set(userPrefsNamespace(userId), field.pref, value);
        else await this.redis().del(`${userPrefsNamespace(userId)}:${field.pref}`);
        continue;
      }
      if (value === null) delete next[name]; else next[name] = value;
      recordChanged = true;
    }
    if (recordChanged) await this.redis().set(profileKey(userId), JSON.stringify(next));
    return this.getProfile(userId);
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
    const user = raw ? this.unseal(OWNER_RECORD_KEY, raw) : null;
    if (!raw || !user || user.role !== 'owner' || user.id !== userId || user.disabled) {
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
