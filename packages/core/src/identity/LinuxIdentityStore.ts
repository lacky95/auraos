/**
 * The one authoritative Linux identity registry (D70, D84; Phase 5 stream I).
 *
 *   ident:linux:user:<userId>         JSON UserIdentityRecord
 *   ident:linux:app:<installationId>  JSON AppIdentityRecord (keyed by installation, never by instance: D85 A7)
 *   ident:linux:uid:<uid>             STRING "<kind>:<id>", the tombstone: kept forever, so a uid is never reused
 *   ident:linux:next:<range>          INT the next candidate of an allocated range
 *
 * `ident:` is not a KvClient namespace, so `/api/kv` can't reach it (like
 * `apphost:` and `user:`). Each allocation is one Lua script: the record, the
 * tombstone and the counter move together or not at all.
 *
 * Never reused across a Valkey restore: before each commit the allocator
 * writes the uid it is about to hand out as the range's high-water mark to
 * `hwm.json` (fsync, 0600), and it only ever allocates above that mark. A
 * restored older Valkey therefore can't hand a uid out twice; a crash between
 * the mark and the commit only skips a uid.
 *
 * The ranges come from `LINUX_ID_RANGES`. The owner (`default`, D47 rule 2) is
 * fixed at 1000. Allocation is lazy and idempotent (`ensureUser`,
 * `ensureApp`); `retire` keeps the tombstone. Logical ids only: a runtime maps
 * them to host ids (ARI §2.2).
 */
import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Redis } from '@aura/kv-store';
import { DEFAULT_OWNER_ID } from '../auth/identityContracts.js';
import {
  LINUX_ID_RANGES, OWNER_UID, formatPrincipalRef,
  type AllocatedLinuxIdRange, type AppIdentityRecord, type IdentityHighWaterMark, type LinuxIdentityState,
  type UidTombstone, type UserIdentityRecord,
} from './types.js';

export const IDENTITY_KEY_PREFIX = 'ident:linux:';
export const identityUserKey = (userId: string): string => `${IDENTITY_KEY_PREFIX}user:${userId}`;
export const identityAppKey = (installationId: string): string => `${IDENTITY_KEY_PREFIX}app:${installationId}`;
export const identityUidKey = (uid: number): string => `${IDENTITY_KEY_PREFIX}uid:${uid}`;
export const identityNextKey = (range: AllocatedLinuxIdRange): string => `${IDENTITY_KEY_PREFIX}next:${range}`;

/** `<dataDir>/aura/identity/hwm.json`. */
export function defaultHighWaterMarkFile(dataDir: string = process.env['AURA_DATA_DIR'] ?? '/data'): string {
  return join(dataDir, 'aura', 'identity', 'hwm.json');
}

const USER_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const INSTALLATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const APP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const MAX_ATTEMPTS = 16;

export class LinuxIdentityError extends Error {
  constructor(readonly code: 'invalid-id' | 'range-exhausted' | 'uid-taken' | 'hwm-unwritable' | 'not-settled' | 'corrupt', message: string) {
    super(message);
    this.name = 'LinuxIdentityError';
  }
}

/**
 * KEYS[1] record, KEYS[2] next counter (unused when fixed).
 * ARGV: 1 tombstone, 2 uid key prefix, 3 floor, 4 ceiling, 5 range last,
 *       6 record JSON with "__UID__" for uid and gid, 7 '1' for a fixed uid.
 * Returns {status, value}: existing|ok (record JSON), retry|exhausted (uid), taken (holder).
 */
const ALLOCATE = `
local cur = redis.call('GET', KEYS[1])
if cur then return {'existing', cur} end
local fixed = ARGV[7] == '1'
local n = tonumber(ARGV[3])
if not fixed then
  local nx = tonumber(redis.call('GET', KEYS[2]) or '')
  if nx and nx > n then n = nx end
  while redis.call('EXISTS', ARGV[2] .. string.format('%d', n)) == 1 do n = n + 1 end
else
  local holder = redis.call('GET', ARGV[2] .. string.format('%d', n))
  if holder and holder ~= ARGV[1] then return {'taken', holder} end
end
if n > tonumber(ARGV[5]) then return {'exhausted', string.format('%d', n)} end
if n > tonumber(ARGV[4]) then return {'retry', string.format('%d', n)} end
local id = string.format('%d', n)
local rec = string.gsub(ARGV[6], '"__UID__"', id)
redis.call('SET', ARGV[2] .. id, ARGV[1])
redis.call('SET', KEYS[1], rec)
if not fixed then redis.call('SET', KEYS[2], string.format('%d', n + 1)) end
return {'ok', rec}
`;

/** Compare-and-set of one key. */
const SET_IF_UNCHANGED = `if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2]) return 1 end return 0`;

/** The registry's invariants, as `diagnose/identity-registry` reads them. Never a secret. */
export interface IdentityRegistryCheck {
  users: number;
  apps: number;
  /** The owner's uid when it has a record; null before its first allocation. */
  ownerUid: number | null;
  hwm: IdentityHighWaterMark | null;
  maxAllocated: { user: number | null; app: number | null };
  /** Each finding names a key or a uid, never a value. Empty when the registry holds. */
  findings: string[];
}

export interface LinuxIdentityStoreOptions {
  redis: () => Redis;
  /** `hwm.json`; see `defaultHighWaterMarkFile`. */
  hwmFile: string;
  now?: () => number;
}

type AnyRecord = UserIdentityRecord | AppIdentityRecord;

export class LinuxIdentityStore {
  private readonly redis: () => Redis;
  private readonly hwmFile: string;
  private readonly now: () => number;
  /** One allocation at a time in this process; the script and the mark keep other processes safe. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(opts: LinuxIdentityStoreOptions) {
    this.redis = opts.redis;
    this.hwmFile = opts.hwmFile;
    this.now = opts.now ?? Date.now;
  }

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.catch(() => undefined);
    return run;
  }

  // ── the high-water mark ────────────────────────────────────────────────────

  /** The marks on disk; null when there is no file yet. Throws on a file that does not parse. */
  readHighWaterMark(): IdentityHighWaterMark | null {
    let raw: string;
    try { raw = readFileSync(this.hwmFile, 'utf-8'); } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new LinuxIdentityError('hwm-unwritable', `cannot read ${this.hwmFile}`);
    }
    try {
      const o = JSON.parse(raw) as Partial<IdentityHighWaterMark>;
      const user = Number.isSafeInteger(o.user) ? o.user! : 0;
      const app = Number.isSafeInteger(o.app) ? o.app! : 0;
      return { user, app };
    } catch {
      throw new LinuxIdentityError('corrupt', `${this.hwmFile} does not parse; refusing to allocate`);
    }
  }

  /** Atomic and durable: temp file, fsync, rename, fsync of the directory. */
  private writeHighWaterMark(hwm: IdentityHighWaterMark): void {
    const dir = dirname(this.hwmFile);
    const tmp = join(dir, `.hwm.${process.pid}.${randomBytes(4).toString('hex')}`);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const fd = openSync(tmp, 'w', 0o600);
      try {
        writeSync(fd, JSON.stringify(hwm));
        fsyncSync(fd);
      } finally { closeSync(fd); }
      renameSync(tmp, this.hwmFile);
      const dfd = openSync(dir, 'r');
      try { fsyncSync(dfd); } finally { closeSync(dfd); }
    } catch (err) {
      rmSync(tmp, { force: true });
      throw new LinuxIdentityError('hwm-unwritable', `cannot write ${this.hwmFile}: ${(err as NodeJS.ErrnoException).code ?? 'error'}`);
    }
  }

  // ── allocation ─────────────────────────────────────────────────────────────

  private async allocate<T extends AnyRecord>(
    key: string, kind: 'user' | 'app', id: string, template: Omit<T, 'uid' | 'gid'>, range: AllocatedLinuxIdRange | 'owner',
  ): Promise<T> {
    const existing = await this.read<T>(key);
    if (existing) return existing;
    return this.serialized(async () => {
      const again = await this.read<T>(key);
      if (again) return again;
      const tombstone: UidTombstone = formatPrincipalRef({ kind, id });
      const json = JSON.stringify({ ...template, uid: '__UID__', gid: '__UID__' });
      const r = this.redis();
      if (range === 'owner') {
        const out = await r.eval(ALLOCATE, 2, key, identityNextKey('user'),
          tombstone, `${IDENTITY_KEY_PREFIX}uid:`, OWNER_UID, OWNER_UID, OWNER_UID, json, '1') as [string, string];
        if (out[0] === 'taken') throw new LinuxIdentityError('uid-taken', `uid ${OWNER_UID} is held by another principal`);
        return this.parse<T>(out[1]);
      }
      const { first, last } = LINUX_ID_RANGES[range];
      let atLeast: number = first;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const hwm = this.readHighWaterMark() ?? { user: 0, app: 0 };
        const next = Number(await r.get(identityNextKey(range)) ?? first);
        const candidate = Math.max(first, Number.isSafeInteger(next) ? next : first, hwm[range] + 1, atLeast);
        if (candidate > last) throw new LinuxIdentityError('range-exhausted', `the ${range} range ${first}-${last} is exhausted`);
        // The mark goes to disk before the uid is committed (never reused after a Valkey restore).
        if (hwm[range] < candidate) this.writeHighWaterMark({ ...hwm, [range]: candidate });
        const out = await r.eval(ALLOCATE, 2, key, identityNextKey(range),
          tombstone, `${IDENTITY_KEY_PREFIX}uid:`, candidate, candidate, last, json, '0') as [string, string];
        if (out[0] === 'existing' || out[0] === 'ok') return this.parse<T>(out[1]);
        if (out[0] === 'exhausted') throw new LinuxIdentityError('range-exhausted', `the ${range} range ${first}-${last} is exhausted`);
        atLeast = Number(out[1]); // another allocator or a tombstone was ahead: mark that one next
      }
      throw new LinuxIdentityError('not-settled', `allocating a ${range} identity did not settle`);
    });
  }

  private parse<T>(raw: string): T {
    try { return JSON.parse(raw) as T; } catch { throw new LinuxIdentityError('corrupt', 'an identity record does not parse'); }
  }

  private async read<T>(key: string): Promise<T | null> {
    const raw = await this.redis().get(key);
    return raw ? this.parse<T>(raw) : null;
  }

  /** The user's identity, allocated on first use. The owner (`default`) is 1000:1000. */
  ensureUser(userId: string): Promise<UserIdentityRecord> {
    if (!USER_ID_RE.test(userId)) throw new LinuxIdentityError('invalid-id', 'invalid user id');
    const template: Omit<UserIdentityRecord, 'uid' | 'gid'> = {
      userId, allocatedAt: new Date(this.now()).toISOString(), state: 'active',
    };
    return this.allocate<UserIdentityRecord>(identityUserKey(userId), 'user', userId, template, userId === DEFAULT_OWNER_ID ? 'owner' : 'user');
  }

  /** The installation's app identity, allocated on first use. */
  ensureApp(installationId: string, appId: string): Promise<AppIdentityRecord> {
    if (!INSTALLATION_ID_RE.test(installationId) || !APP_ID_RE.test(appId)) throw new LinuxIdentityError('invalid-id', 'invalid installation or app id');
    const template: Omit<AppIdentityRecord, 'uid' | 'gid'> = {
      installationId, appId, allocatedAt: new Date(this.now()).toISOString(), state: 'active',
    };
    return this.allocate<AppIdentityRecord>(identityAppKey(installationId), 'app', installationId, template, 'app');
  }

  getUser(userId: string): Promise<UserIdentityRecord | null> {
    return USER_ID_RE.test(userId) ? this.read<UserIdentityRecord>(identityUserKey(userId)) : Promise.resolve(null);
  }

  getApp(installationId: string): Promise<AppIdentityRecord | null> {
    return INSTALLATION_ID_RE.test(installationId) ? this.read<AppIdentityRecord>(identityAppKey(installationId)) : Promise.resolve(null);
  }

  /** Marks a record retired. The tombstone stays, so its uid is never handed out again. */
  async retire(kind: 'user' | 'app', id: string): Promise<boolean> {
    const key = kind === 'user' ? identityUserKey(id) : identityAppKey(id);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const raw = await this.redis().get(key);
      if (!raw) return false;
      const rec = this.parse<AnyRecord & { state: LinuxIdentityState }>(raw);
      if (rec.state === 'retired') return true;
      if ((await this.redis().eval(SET_IF_UNCHANGED, 1, key, raw, JSON.stringify({ ...rec, state: 'retired' }))) === 1) return true;
    }
    throw new LinuxIdentityError('not-settled', 'retiring an identity did not settle');
  }

  // ── reading the whole registry ─────────────────────────────────────────────

  private async scan(pattern: string): Promise<string[]> {
    const out: string[] = [];
    let cursor = '0';
    do {
      const [next, keys] = await this.redis().scan(cursor, 'MATCH', pattern, 'COUNT', 1000);
      cursor = next;
      out.push(...keys);
    } while (cursor !== '0');
    return out.sort();
  }

  async listUsers(): Promise<UserIdentityRecord[]> {
    const out: UserIdentityRecord[] = [];
    for (const key of await this.scan(`${IDENTITY_KEY_PREFIX}user:*`)) {
      const rec = await this.read<UserIdentityRecord>(key);
      if (rec) out.push(rec);
    }
    return out;
  }

  async listApps(): Promise<AppIdentityRecord[]> {
    const out: AppIdentityRecord[] = [];
    for (const key of await this.scan(`${IDENTITY_KEY_PREFIX}app:*`)) {
      const rec = await this.read<AppIdentityRecord>(key);
      if (rec) out.push(rec);
    }
    return out;
  }

  /**
   * The registry's invariants (`diagnose/identity-registry`): the owner is
   * 1000; every record's uid is in its range, has gid = uid, and holds its
   * own tombstone; uids are unique; each mark is at or above the highest uid
   * of its range; the counters are above every allocated uid.
   */
  async check(): Promise<IdentityRegistryCheck> {
    const findings: string[] = [];
    const users = await this.listUsers();
    const apps = await this.listApps();
    let hwm: IdentityHighWaterMark | null = null;
    try { hwm = this.readHighWaterMark(); } catch (err) { findings.push((err as Error).message); }
    const seen = new Map<number, string>();
    const max: { user: number | null; app: number | null } = { user: null, app: null };
    let ownerUid: number | null = null;
    const checkOne = async (ref: string, rec: AnyRecord, range: 'owner' | AllocatedLinuxIdRange) => {
      const { first, last } = LINUX_ID_RANGES[range];
      if (!Number.isSafeInteger(rec.uid) || rec.uid < first || rec.uid > last) findings.push(`${ref}: uid outside the ${range} range`);
      if (rec.gid !== rec.uid) findings.push(`${ref}: gid differs from uid`);
      const dup = seen.get(rec.uid);
      if (dup) findings.push(`uid ${rec.uid}: held by ${dup} and ${ref}`);
      seen.set(rec.uid, ref);
      const tomb = await this.redis().get(identityUidKey(rec.uid));
      if (tomb !== ref) findings.push(`uid ${rec.uid}: tombstone ${tomb === null ? 'missing' : 'names another principal'} (${ref})`);
      if (range !== 'owner') max[range] = Math.max(max[range] ?? 0, rec.uid);
    };
    for (const u of users) {
      const owner = u.userId === DEFAULT_OWNER_ID;
      if (owner) ownerUid = u.uid;
      await checkOne(`user:${u.userId}`, u, owner ? 'owner' : 'user');
    }
    for (const a of apps) await checkOne(`app:${a.installationId}`, a, 'app');
    for (const range of ['user', 'app'] as const) {
      const top = max[range];
      if (top === null) continue;
      if (!hwm || hwm[range] < top) findings.push(`hwm.${range} is below the highest allocated uid ${top}`);
      const next = Number(await this.redis().get(identityNextKey(range)));
      if (!Number.isSafeInteger(next) || next <= top) findings.push(`next:${range} is not above the highest allocated uid ${top}`);
    }
    if (ownerUid !== null && ownerUid !== OWNER_UID) findings.push(`the owner is uid ${ownerUid}, not ${OWNER_UID}`);
    return { users: users.length, apps: apps.length, ownerUid, hwm, maxAllocated: max, findings };
  }
}
