// Owner account, login sessions, setup tickets and instance owner against a
// REAL valkey-server (KvServer on a tmp dataDir).
import { test, after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { kvServer, defaultRedis, createRedis } from '@aura/kv-store';
import {
  AdminAudit, FileSetupTickets, IDENTITY_AUDIT_ACTIONS, IdentityKeyError, getAuthServices, resetAuthServices, LOGIN_ATTEMPTS_PER_KEY_PER_MINUTE,
  LOGIN_SESSION_PREFIX, LoginSessionStore, OWNER_RECORD_KEY, PASSWORD_MAX_BYTES, PASSWORD_SESSION_TTL_MS,
  DEFAULT_PASSWORD_POLICY, PASSWORD_POLICY_KEY, UserStoreError, parsePasswordPolicy, passwordViolation,
  SETUP_TICKET_TTL_MS, STAY_SIGNED_IN_TTL_MS, ValkeyUserStore, createSetupTicket, defaultIdentityKeyFile,
  defaultSetupTicketDir, operatorAttribution, retireSharedAdminCredential, userAttribution,
} from '../dist/auth/index.js';
import { adoptedInstanceOwner } from '../dist/app-manager/instanceOwner.js';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'aura-identity-'));
const SECRETS = join(DATA_DIR, 'aura', 'secrets');
const IDENTITY_KEY = defaultIdentityKeyFile(DATA_DIR);
const PASSWORD = 'correct horse battery';
const server = kvServer; // The singleton, so getAuthServices() can be tested for real.
let redis;
let clock = 1_800_000_000_000;
const now = () => clock;
const r = () => redis;
let users, sessions, audit;

before(async () => {
  const uri = await server.start({ dataDir: join(DATA_DIR, 'kv') });
  redis = createRedis(uri);
  users = new ValkeyUserStore({ identityKeyFile: IDENTITY_KEY, redis: r, now });
  sessions = new LoginSessionStore({ identityKeyFile: IDENTITY_KEY, redis: r, now });
  audit = new AdminAudit(r, now);
});

after(async () => {
  redis?.disconnect();
  defaultRedis().disconnect();
  await server.stop();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

// Every test starts in its own rate-limit minute.
beforeEach(() => { clock += 120_000; });

test('createOwner is create-once and never exposes the hash', async () => {
  assert.equal(await users.hasOwner(), false);
  const results = await Promise.all([
    users.createOwner({ username: 'Lukas', password: PASSWORD }),
    users.createOwner({ username: 'mallory', password: 'another password' }),
  ]);
  const winners = results.filter(Boolean);
  assert.equal(winners.length, 1);
  assert.equal(winners[0].id, 'default');
  assert.equal(winners[0].role, 'owner');
  assert.equal('passwordHash' in winners[0], false);
  assert.equal(await users.createOwner({ username: 'late', password: PASSWORD }), null);
  assert.equal('passwordHash' in await users.getOwner(), false);

  const stored = JSON.parse(await redis.get(OWNER_RECORD_KEY));
  assert.match(stored.passwordHash, /^scrypt\$131072\$8\$1\$/);
  assert.equal(statSync(IDENTITY_KEY).mode & 0o777, 0o600);
});

test('verifyPassword: right, wrong, unknown user and over-long input', async () => {
  const username = (await users.getOwner()).username;
  const good = await users.verifyPassword(username, PASSWORD, { rateLimitKey: 'c1' });
  assert.equal(good.ok, true);
  assert.equal('passwordHash' in good.user, false);
  assert.deepEqual(await users.verifyPassword(username, 'wrong password', { rateLimitKey: 'c1' }), { ok: false, reason: 'invalid' });
  assert.deepEqual(await users.verifyPassword('nobody', PASSWORD, { rateLimitKey: 'c1' }), { ok: false, reason: 'invalid' });
  assert.deepEqual(await users.verifyPassword(username, 'x'.repeat(PASSWORD_MAX_BYTES + 1), { rateLimitKey: 'c1' }), { ok: false, reason: 'invalid' });
});

test('rate limit is enforced before any hashing', async () => {
  const username = (await users.getOwner()).username;
  // Over-long passwords are counted but never hashed, so they fill the bucket quickly.
  const long = 'x'.repeat(PASSWORD_MAX_BYTES + 1);
  for (let i = 0; i < LOGIN_ATTEMPTS_PER_KEY_PER_MINUTE; i++) await users.verifyPassword(username, long, { rateLimitKey: 'c2' });
  const started = process.hrtime.bigint();
  const limited = await users.verifyPassword(username, PASSWORD, { rateLimitKey: 'c2' });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.deepEqual(limited, { ok: false, reason: 'rate-limited' });
  assert.ok(elapsedMs < 50, `no scrypt ran (${elapsedMs}ms)`);
  // Another client has its own per-key bucket.
  assert.equal((await users.verifyPassword(username, PASSWORD, { rateLimitKey: 'c3' })).ok, true);
});

test('a tampered record never authenticates and cannot be replaced by setup', async () => {
  const original = await redis.get(OWNER_RECORD_KEY);
  const o = JSON.parse(original);
  await redis.set(OWNER_RECORD_KEY, JSON.stringify({ ...o, username: 'mallory' }));
  assert.equal(await users.getOwner(), null);
  assert.equal(await users.hasOwner(), true);
  assert.equal((await users.verifyPassword('mallory', PASSWORD, { rateLimitKey: 'c4' })).ok, false);
  assert.equal(await users.createOwner({ username: 'mallory', password: PASSWORD }), null);
  await redis.set(OWNER_RECORD_KEY, original);
  assert.ok(await users.getOwner());
});

test('one client cannot lock out another, and no address means no shared bucket', async () => {
  const username = (await users.getOwner()).username;
  const long = 'x'.repeat(PASSWORD_MAX_BYTES + 1);
  // More attempts than any old global limit, all refused before hashing.
  for (let i = 0; i < 40; i++) await users.verifyPassword(username, long, { rateLimitKey: 'attacker' });
  assert.deepEqual(await users.verifyPassword(username, PASSWORD, { rateLimitKey: 'attacker' }), { ok: false, reason: 'rate-limited' });
  assert.equal((await users.verifyPassword(username, PASSWORD, { rateLimitKey: 'owner-client' })).ok, true);
  for (let i = 0; i < 40; i++) await users.verifyPassword(username, long);
  assert.equal((await users.verifyPassword(username, PASSWORD)).ok, true, 'no client address');
});

test('a Valkey failure is a service error, not an invalid session', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aura-session-outage-'));
  let down = false;
  const flaky = new Proxy({}, {
    get: (_t, prop) => {
      if (prop === 'get' && down) return async () => { throw new Error('valkey down'); };
      const v = redis[prop];
      return typeof v === 'function' ? v.bind(redis) : v;
    },
  });
  try {
    const store = new LoginSessionStore({ identityKeyFile: join(dir, 'identity.key'), redis: () => flaky, now });
    const password = await store.issue({ method: 'password', userId: 'default' });
    down = true;
    await assert.rejects(store.verify(password.token), /valkey down/);
    assert.equal(await store.verify('aura-sess1.bad.sig'), null, 'a bad token needs no store');
    down = false;
    assert.ok(await store.verify(password.token), 'the session survives the blip');

    await redis.set(`usersess:${password.session.sessionId}`, 'not json');
    assert.equal(await store.verify(password.token), null, 'a corrupt nonce is invalid');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('password session: lifetimes, expiry, revoke and revokeByUser', async () => {
  const a = await sessions.issue({ method: 'password', userId: 'default' });
  assert.ok(a.token.startsWith(`${LOGIN_SESSION_PREFIX}.`));
  assert.equal(a.session.expiresAt, clock + PASSWORD_SESSION_TTL_MS);
  assert.equal((await sessions.verify(a.token)).userId, 'default');
  const stay = await sessions.issue({ method: 'password', userId: 'default', ttlMs: STAY_SIGNED_IN_TTL_MS });
  assert.equal(stay.session.expiresAt, clock + STAY_SIGNED_IN_TTL_MS);
  await assert.rejects(sessions.issue({ method: 'password', userId: 'default', ttlMs: STAY_SIGNED_IN_TTL_MS + 1 }), RangeError);

  clock += PASSWORD_SESSION_TTL_MS + 1;
  assert.equal(await sessions.verify(a.token), null, 'expired');
  assert.ok(await sessions.verify(stay.token));
  assert.equal(await sessions.revoke(stay.session.sessionId), true);
  assert.equal(await sessions.verify(stay.token), null, 'revoked');

  const b = await sessions.issue({ method: 'password', userId: 'default' });
  const c = await sessions.issue({ method: 'password', userId: 'default' });
  assert.ok(await sessions.revokeByUser('default') >= 2);
  assert.equal(await sessions.verify(b.token), null);
  assert.equal(await sessions.verify(c.token), null);
});

test('session tokens cannot be forged or relabelled', async () => {
  const { token } = await sessions.issue({ method: 'password', userId: 'default' });
  const [, payload, sig] = token.split('.');
  assert.equal(await sessions.verify(`aura-admin1.${payload}.${sig}`), null, 'the retired admin prefix never verifies');
  const forged = Buffer.from(JSON.stringify({ s: 'a'.repeat(32), e: clock + 1000, m: 'password', u: 'default' })).toString('base64url');
  assert.equal(await sessions.verify(`${LOGIN_SESSION_PREFIX}.${forged}.${sig}`), null);
  for (const bad of [null, undefined, '', 'garbage', 'a.b.c', `${LOGIN_SESSION_PREFIX}.x`, 'x'.repeat(5000)]) {
    assert.equal(await sessions.verify(bad), null);
  }
  // A session with a different key file cannot verify this token.
  const other = new LoginSessionStore({ identityKeyFile: join(DATA_DIR, 'other', 'identity.key'), redis: r, now });
  assert.equal(await other.verify(token), null);
});

test('D50 boot migration: retired shared-admin sessions are deleted, password sessions stay, admin.key stays', async () => {
  const password = await sessions.issue({ method: 'password', userId: 'default' });
  const sid = 'b'.repeat(32);
  await redis.set(`usersess:${sid}`, JSON.stringify({ m: 'shared-key', createdAt: clock, expiresAt: clock + 60_000 }), 'PX', 60_000);
  const keyFile = join(SECRETS, 'admin.key');
  mkdirSync(SECRETS, { recursive: true });
  writeFileSync(keyFile, 'aura_admin_' + 'x'.repeat(43) + '\n', { mode: 0o600 });

  const first = await retireSharedAdminCredential({ loginSessions: sessions, audit }, DATA_DIR);
  assert.deepEqual(first, { sessionsRevoked: 1, keyFileLeft: true });
  assert.equal(await redis.exists(`usersess:${sid}`), 0);
  assert.equal((await sessions.verify(password.token)).userId, 'default', 'the owner stays signed in');
  assert.equal(existsSync(keyFile), true, 'the key file is left in place');
  assert.equal((await audit.list(1))[0].action, 'auth.shared-admin-retired');

  assert.deepEqual(await retireSharedAdminCredential({ loginSessions: sessions, audit }, DATA_DIR), { sessionsRevoked: 0, keyFileLeft: true });
  rmSync(keyFile);
  await sessions.revoke(password.session.sessionId);
});

test('setup ticket: stored hashed at 0600, single use, purpose-bound, wrong code harmless', async () => {
  const dir = defaultSetupTicketDir(DATA_DIR);
  const tickets = new FileSetupTickets({ dir, now });
  const { code, expiresAt } = createSetupTicket(DATA_DIR, { purpose: 'setup' }, now);
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/);
  assert.equal(expiresAt, clock + SETUP_TICKET_TTL_MS);

  const files = readdirSync(dir).filter((n) => n.endsWith('.json'));
  assert.equal(files.length, 1);
  const file = join(dir, files[0]);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const raw = readFileSync(file, 'utf-8');
  assert.equal(raw.includes(code) || raw.includes(code.replaceAll('-', '')), false);
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['expiresAt', 'purpose', 'sha256']);

  assert.equal(await tickets.claim('00000-00000-00000-00000', 'setup'), null);
  assert.equal(await tickets.claim(code, 'reset'), null, 'other purpose');
  assert.ok(existsSync(file), 'a failed claim consumes nothing');

  const claims = await Promise.all(Array.from({ length: 8 }, () => tickets.claim(code, 'setup')));
  assert.equal(claims.filter(Boolean).length, 1, 'exactly one concurrent claim wins');
  assert.equal(await tickets.claim(code, 'setup'), null, 'single use');
});

test('setup ticket: expiry, reset username, and a new code replaces the old one', async () => {
  const tickets = new FileSetupTickets({ dir: defaultSetupTicketDir(DATA_DIR), now });
  const expired = createSetupTicket(DATA_DIR, { purpose: 'setup' }, now);
  clock += SETUP_TICKET_TTL_MS;
  assert.equal(await tickets.claim(expired.code, 'setup'), null);

  const first = createSetupTicket(DATA_DIR, { purpose: 'reset', username: 'lukas' }, now);
  const second = createSetupTicket(DATA_DIR, { purpose: 'reset', username: 'lukas' }, now);
  assert.equal(await tickets.claim(first.code, 'reset'), null);
  assert.equal((await tickets.claim(second.code.toLowerCase(), 'reset')).username, 'lukas');
});

test('ticket creation is audited once, without the code', async () => {
  const dir = defaultSetupTicketDir(DATA_DIR);
  const tickets = new FileSetupTickets({ dir, now });
  await tickets.drainCreatedEvents(async () => undefined);
  const { code } = createSetupTicket(DATA_DIR, { purpose: 'reset', username: 'lukas' }, now);

  await assert.rejects(tickets.drainCreatedEvents(async () => { throw new Error('valkey down'); }));
  const seen = [];
  assert.equal(await tickets.drainCreatedEvents(async (e) => { seen.push(e); }), 1, 'kept for retry');
  assert.equal(await tickets.drainCreatedEvents(async (e) => { seen.push(e); }), 0);
  assert.equal(seen[0].purpose, 'reset');
  assert.equal(JSON.stringify(seen).includes(code), false);
});

test('audit: user and operator attribution, secrets never recorded', async () => {
  const secret = 'sup3r-s3cret-value';
  await audit.record({
    by: userAttribution({ userId: 'default', sessionId: 'abcdef0123456789' }),
    action: IDENTITY_AUDIT_ACTIONS.login,
    detail: { password: secret, nested: { sessionToken: secret, passwordHash: secret, code: secret }, method: 'password' },
  });
  await audit.record({ by: operatorAttribution(), action: IDENTITY_AUDIT_ACTIONS.ownerRecovered, target: 'user:default' });
  const [reset, login] = await audit.list(2);
  assert.equal(reset.actor, 'operator');
  assert.equal(login.actor, 'user:default');
  assert.equal(login.session, 'abcdef01');
  assert.equal(login.detail.method, 'password');
  assert.equal(JSON.stringify(login).includes(secret), false);
});

test('the setup-tickets entry is file-only: its import graph has no Valkey', () => {
  const coreRoot = join(import.meta.dirname, '..');
  const pkg = JSON.parse(readFileSync(join(coreRoot, 'package.json'), 'utf-8'));
  const entry = join(coreRoot, pkg.exports['./setup-tickets'].import);
  const seen = new Set();
  const external = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, 'utf-8');
    for (const m of source.matchAll(/^(?:import|export)\s(?:[^'"\n;]*\sfrom\s)?['"]([^'"]+)['"]/gm)) {
      if (m[1].startsWith('.')) visit(join(dirname(file), m[1]));
      else external.add(m[1]);
    }
    assert.equal(/\bimport\s*\(|\brequire\s*\(/.test(source), false, `dynamic import in ${file}`);
  };
  visit(entry);
  assert.ok(seen.size >= 2, 'follows relative imports');
  assert.deepEqual([...external].filter((d) => !d.startsWith('node:')), [], 'only Node builtins');
});

test('instance owner: label wins, adoption falls back, pool members stay unowned', () => {
  assert.equal(adoptedInstanceOwner('default', false), 'default');
  assert.equal(adoptedInstanceOwner('user-2', true), 'user-2');
  assert.equal(adoptedInstanceOwner(undefined, false), 'default', 'pre-owner container');
  assert.equal(adoptedInstanceOwner('../bad owner', false), 'default', 'malformed label');
  assert.equal(adoptedInstanceOwner(undefined, true), undefined, 'unclaimed pool member');
});

// ── identity.key failure and operator recovery ──────────────────────────────

const NEW_PASSWORD = 'recovered password 1';

/** An isolated secrets dir and stores, with a fresh owner record. */
async function isolated(username = 'lukas', extra = {}) {
  const dataDir = mkdtempSync(join(DATA_DIR, 'iso-'));
  const secrets = join(dataDir, 'aura', 'secrets');
  mkdirSync(secrets, { recursive: true });
  const identityKeyFile = defaultIdentityKeyFile(dataDir);
  const loginSessions = new LoginSessionStore({ identityKeyFile, redis: r, now });
  const store = new ValkeyUserStore({ identityKeyFile, redis: r, now, sessions: loginSessions, ...extra });
  await redis.del(OWNER_RECORD_KEY);
  if (username) assert.ok(await store.createOwner({ username, password: PASSWORD }));
  const tickets = new FileSetupTickets({ dir: defaultSetupTicketDir(dataDir), now });
  const claimReset = (name = username) =>
    tickets.claim(createSetupTicket(dataDir, { purpose: 'reset', username: name }, now).code, 'reset');
  return { dataDir, identityKeyFile, loginSessions, store, tickets, claimReset };
}

test('a malformed identity.key fails password login closed, with a clear error', async () => {
  const errors = [];
  const { identityKeyFile, loginSessions, store } = await isolated('lukas', { onIdentityKeyError: (e) => errors.push(e) });
  const live = await loginSessions.issue({ method: 'password', userId: 'default' });
  rmSync(identityKeyFile);
  writeFileSync(identityKeyFile, 'garbage', { mode: 0o600 });

  assert.equal(store.identityKeyStatus(), 'malformed');
  assert.deepEqual(await store.verifyPassword('lukas', PASSWORD, { rateLimitKey: 'k1' }), { ok: false, reason: 'invalid' });
  assert.equal(await store.getOwner(), null);
  assert.equal(await store.hasOwner(), true);
  assert.equal(await loginSessions.verify(live.token), null);
  await assert.rejects(loginSessions.issue({ method: 'password', userId: 'default' }), IdentityKeyError);
  assert.equal(errors.length, 1, 'reported once');
  assert.match(errors[0].message, /identity\.key is malformed.*reset-password/);
  assert.equal(errors[0].message.includes('garbage'), false);
  assert.equal(readFileSync(identityKeyFile, 'utf-8'), 'garbage', 'never overwritten');
});

test('a password session cannot be relabelled as the retired shared-key method', async () => {
  const { loginSessions: sessionsStore } = await isolated();
  const pw = await sessionsStore.issue({ method: 'password', userId: 'default' });
  const swap = (token, prefix) => [prefix, ...token.split('.').slice(1)].join('.');
  assert.equal(await sessionsStore.verify(swap(pw.token, 'aura-admin1')), null);

  // A correctly keyed payload claiming the other method is also refused.
  const [, payload, sig] = pw.token.split('.');
  const claim = JSON.parse(Buffer.from(payload, 'base64url').toString());
  const flipped = Buffer.from(JSON.stringify({ ...claim, m: 'shared-key' })).toString('base64url');
  assert.equal(await sessionsStore.verify(`${LOGIN_SESSION_PREFIX}.${flipped}.${sig}`), null);
  assert.equal(await sessionsStore.verify(`aura-admin1.${flipped}.${sig}`), null);
});

test('recovery after a replaced identity.key re-seals from the ticket and revokes password sessions', async () => {
  const recovered = [];
  const { identityKeyFile, loginSessions, store, claimReset } = await isolated('lukas', { onOwnerRecovered: (e) => { recovered.push(e); } });
  const pw = await loginSessions.issue({ method: 'password', userId: 'default' });
  rmSync(identityKeyFile);
  assert.equal(await store.getOwner(), null, 'old MAC no longer verifies');

  const out = await store.recoverOwnerPassword(await claimReset('lukas'), NEW_PASSWORD);
  assert.equal(out.ok, true);
  assert.equal(out.recordTrusted, false);
  assert.ok(out.sessionsRevoked >= 1);
  assert.deepEqual(recovered, [{ username: 'lukas', recordTrusted: false, usernameSource: 'ticket', sessionsRevoked: out.sessionsRevoked }]);
  assert.equal((await store.getOwner()).username, 'lukas');
  assert.equal((await store.verifyPassword('lukas', NEW_PASSWORD, { rateLimitKey: 'k2' })).ok, true);
  assert.equal((await store.verifyPassword('lukas', PASSWORD, { rateLimitKey: 'k2' })).ok, false);
  assert.equal(await redis.exists(`usersess:${pw.session.sessionId}`), 0);
});

test('recovery with an untrusted record ignores its forged username, role and disabled flag', async () => {
  const { store, claimReset } = await isolated();
  const o = JSON.parse(await redis.get(OWNER_RECORD_KEY));
  await redis.set(OWNER_RECORD_KEY, JSON.stringify({ ...o, username: 'mallory', role: 'admin', disabled: true, id: 'evil' }));
  const out = await store.recoverOwnerPassword(await claimReset('lukas'), NEW_PASSWORD);
  assert.equal(out.ok, true);
  assert.equal(out.recordTrusted, false);
  assert.deepEqual(
    { id: out.user.id, username: out.user.username, role: out.user.role, disabled: out.user.disabled },
    { id: 'default', username: 'lukas', role: 'owner', disabled: false },
  );
  assert.equal((await store.verifyPassword('mallory', NEW_PASSWORD, { rateLimitKey: 'k3' })).ok, false);
});

test('recovery is refused without a claimed reset ticket, and a ticket cannot be replayed', async () => {
  const { dataDir, store, tickets, claimReset } = await isolated();
  const original = await redis.get(OWNER_RECORD_KEY);
  const invalid = { ok: false, reason: 'invalid-ticket' };

  // A hand-built ticket, even a copy of a real claimed one.
  const forged = { sha256: 'a'.repeat(64), purpose: 'reset', expiresAt: clock + 60_000, username: 'lukas' };
  assert.deepEqual(await store.recoverOwnerPassword(forged, NEW_PASSWORD), invalid);
  const real = await claimReset('lukas');
  assert.deepEqual(await store.recoverOwnerPassword({ ...real }, NEW_PASSWORD), invalid);

  // A claimed setup ticket, and a reset code claimed for the wrong purpose.
  const setup = await tickets.claim(createSetupTicket(dataDir, { purpose: 'setup', username: 'lukas' }, now).code, 'setup');
  assert.deepEqual(await store.recoverOwnerPassword(setup, NEW_PASSWORD), invalid);
  const { code } = createSetupTicket(dataDir, { purpose: 'reset', username: 'lukas' }, now);
  assert.equal(await tickets.claim(code, 'setup'), null);
  assert.equal(await redis.get(OWNER_RECORD_KEY), original, 'nothing changed');

  // Replay of the same object, and of the same code.
  const once = await tickets.claim(code, 'reset');
  assert.equal((await store.recoverOwnerPassword(once, NEW_PASSWORD)).ok, true);
  assert.deepEqual(await store.recoverOwnerPassword(once, 'another password 2'), invalid);
  assert.equal(await tickets.claim(code, 'reset'), null);
  assert.equal((await store.verifyPassword('lukas', NEW_PASSWORD, { rateLimitKey: 'k4' })).ok, true);
});

test('recovery refuses a mismatched username on a trusted record, and a malformed key', async () => {
  const { identityKeyFile, store, claimReset } = await isolated();
  const original = await redis.get(OWNER_RECORD_KEY);
  assert.deepEqual(await store.recoverOwnerPassword(await claimReset('someone'), NEW_PASSWORD), { ok: false, reason: 'username-mismatch' });
  assert.equal(await redis.get(OWNER_RECORD_KEY), original);

  const ticket = await claimReset('lukas');
  rmSync(identityKeyFile);
  writeFileSync(identityKeyFile, 'garbage', { mode: 0o600 });
  assert.deepEqual(await store.recoverOwnerPassword(ticket, NEW_PASSWORD), { ok: false, reason: 'identity-key-unavailable' });
  rmSync(identityKeyFile);
  assert.equal((await store.recoverOwnerPassword(ticket, NEW_PASSWORD)).ok, true, 'the unspent claim works once the file is moved aside');
});

test('getAuthServices initializes with a malformed identity.key; recovery is audited', async () => {
  const dataDir = mkdtempSync(join(DATA_DIR, 'svc-'));
  const prev = process.env.AURA_DATA_DIR;
  process.env.AURA_DATA_DIR = dataDir;
  resetAuthServices();
  const quiet = console.error;
  console.error = () => undefined;
  try {
    const keyFile = defaultIdentityKeyFile(dataDir);
    mkdirSync(join(dataDir, 'aura', 'secrets'), { recursive: true });
    const svc0 = getAuthServices();
    await redis.del(OWNER_RECORD_KEY);
    assert.ok(await svc0.users.createOwner({ username: 'lukas', password: PASSWORD }));
    writeFileSync(keyFile, 'garbage', { mode: 0o600 });

    resetAuthServices();
    const svc = getAuthServices();
    assert.equal('admin' in svc, false, 'no shared admin credential (D50)');
    assert.equal((await svc.users.verifyPassword('lukas', PASSWORD, { rateLimitKey: 'k5' })).ok, false);

    rmSync(keyFile);
    const { code } = createSetupTicket(dataDir, { purpose: 'reset', username: 'lukas' });
    const out = await svc.users.recoverOwnerPassword(await svc.setupTickets.claim(code, 'reset'), NEW_PASSWORD);
    assert.equal(out.ok, true);
    const entries = await svc.audit.list(20);
    const entry = entries.find((e) => e.action === IDENTITY_AUDIT_ACTIONS.ownerRecovered);
    assert.equal(entry.actor, 'operator');
    assert.equal(entry.target, 'user:lukas');
    assert.equal(entry.detail.recordTrusted, false);
    assert.equal(entry.detail.usernameSource, 'ticket');
    assert.equal(JSON.stringify(entries).includes(NEW_PASSWORD), false);
    assert.equal(JSON.stringify(entries).includes(code), false);
  } finally {
    console.error = quiet;
    if (prev === undefined) delete process.env.AURA_DATA_DIR; else process.env.AURA_DATA_DIR = prev;
    resetAuthServices();
  }
});

// ── password policy and password change ─────────────────────────────────────

test('passwordViolation: length, bytes, classes and username at their boundaries', () => {
  const policy = { ...DEFAULT_PASSWORD_POLICY };
  assert.deepEqual(DEFAULT_PASSWORD_POLICY, { minLength: 4, requiredClasses: 0, differFromUsername: true });
  assert.equal(passwordViolation('abc', { policy }), 'length');
  assert.equal(passwordViolation('abcd', { policy }), null);
  assert.equal(passwordViolation('äöü', { policy }), 'length', 'code points, not bytes');
  assert.equal(passwordViolation('😀😀😀😀', { policy }), null);
  assert.equal(passwordViolation(7, { policy }), 'length');
  assert.equal(passwordViolation('x'.repeat(PASSWORD_MAX_BYTES + 1), { policy }), 'max-bytes');
  assert.equal(passwordViolation('Lukas', { username: 'lukas', policy }), 'username');
  assert.equal(passwordViolation('Lukas', { username: 'lukas', policy: { ...policy, differFromUsername: false } }), null);
  const two = { ...policy, requiredClasses: 2 };
  assert.equal(passwordViolation('abcdef', { policy: two }), 'classes');
  assert.equal(passwordViolation('abcde1', { policy: two }), null);
  assert.equal(passwordViolation('ab-CD1', { policy: { ...policy, requiredClasses: 4 } }), null);
  assert.equal(passwordViolation('abCD12', { policy: { ...policy, requiredClasses: 4 } }), 'classes');
});

test('parsePasswordPolicy accepts only in-range rules', () => {
  assert.deepEqual(parsePasswordPolicy({ minLength: 4, requiredClasses: 0, differFromUsername: false, extra: 1 }),
    { minLength: 4, requiredClasses: 0, differFromUsername: false });
  assert.ok(parsePasswordPolicy({ minLength: 128, requiredClasses: 4, differFromUsername: true }));
  for (const bad of [
    null, [], 'x', { minLength: 3, requiredClasses: 0, differFromUsername: true },
    { minLength: 129, requiredClasses: 0, differFromUsername: true },
    { minLength: 4.5, requiredClasses: 0, differFromUsername: true },
    { minLength: 4, requiredClasses: 5, differFromUsername: true },
    { minLength: 4, requiredClasses: -1, differFromUsername: true },
    { minLength: 4, requiredClasses: 0, differFromUsername: 'yes' },
  ]) assert.equal(parsePasswordPolicy(bad), null, JSON.stringify(bad));
});

/** An isolated owner with an audit trail; the policy key starts empty. */
async function withPolicyOwner(extra = {}) {
  await redis.del(PASSWORD_POLICY_KEY);
  const recorded = [];
  const iso = await isolated('lukas', { audit: { record: async (e) => { recorded.push(e); } }, ...extra });
  return { ...iso, recorded };
}

test('password policy: round trip, missing and tampered records fall back to the defaults', async () => {
  const tampered = [];
  const { store, recorded } = await withPolicyOwner({ onPolicyTampered: () => tampered.push(1) });
  assert.deepEqual(await store.getPasswordPolicy(), DEFAULT_PASSWORD_POLICY, 'missing');

  const want = { minLength: 6, requiredClasses: 2, differFromUsername: true };
  const out = await store.setPasswordPolicy(want, { userId: 'default', current: PASSWORD, sessionId: 'a'.repeat(32), rateLimitKey: 'p1' });
  assert.deepEqual(out, { ok: true, previous: DEFAULT_PASSWORD_POLICY, policy: want });
  assert.deepEqual(await store.getPasswordPolicy(), want);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].action, IDENTITY_AUDIT_ACTIONS.passwordPolicyChanged);
  assert.deepEqual(recorded[0].by, { kind: 'user', userId: 'default', session: 'aaaaaaaa' });
  assert.deepEqual(recorded[0].detail, { from: DEFAULT_PASSWORD_POLICY, to: want });
  assert.equal(JSON.stringify(recorded).includes(PASSWORD), false);

  // A Valkey writer lowers the rules: the MAC fails, the defaults apply, reported once.
  const stored = JSON.parse(await redis.get(PASSWORD_POLICY_KEY));
  await redis.set(PASSWORD_POLICY_KEY, JSON.stringify({ ...stored, minLength: 4, requiredClasses: 0 }));
  assert.deepEqual(await store.getPasswordPolicy(), DEFAULT_PASSWORD_POLICY);
  assert.deepEqual(await store.getPasswordPolicy(), DEFAULT_PASSWORD_POLICY);
  assert.equal(tampered.length, 1, 'reported once');
  await redis.set(PASSWORD_POLICY_KEY, 'not json');
  assert.deepEqual(await store.getPasswordPolicy(), DEFAULT_PASSWORD_POLICY);
  assert.equal(tampered.length, 2);
  await redis.del(PASSWORD_POLICY_KEY);
});

test('setPasswordPolicy: wrong password, out-of-range rules and the rate limit', async () => {
  const { store, recorded } = await withPolicyOwner();
  const policy = { minLength: 8, requiredClasses: 1, differFromUsername: true };
  assert.deepEqual(await store.setPasswordPolicy(policy, { userId: 'default', current: 'wrong password', rateLimitKey: 'p2' }), { ok: false, reason: 'invalid' });
  assert.deepEqual(await store.setPasswordPolicy(policy, { userId: 'someone', current: PASSWORD, rateLimitKey: 'p2' }), { ok: false, reason: 'invalid' });
  await assert.rejects(store.setPasswordPolicy({ ...policy, minLength: 3 }, { userId: 'default', current: PASSWORD }),
    (e) => e instanceof UserStoreError && e.code === 'invalid-policy');
  assert.equal(await redis.exists(PASSWORD_POLICY_KEY), 0);
  for (let i = 0; i < 10; i++) await store.setPasswordPolicy(policy, { userId: 'default', current: 'x', rateLimitKey: 'p3' });
  assert.deepEqual(await store.setPasswordPolicy(policy, { userId: 'default', current: PASSWORD, rateLimitKey: 'p3' }), { ok: false, reason: 'rate-limited' });
  assert.equal(recorded.length, 0);
});

test('the policy applies to setup, recovery and change, never to login', async () => {
  const { store, claimReset } = await withPolicyOwner();
  assert.ok((await store.setPasswordPolicy({ minLength: 5, requiredClasses: 2, differFromUsername: true },
    { userId: 'default', current: PASSWORD, rateLimitKey: 'p4' })).ok);
  assert.equal(await store.checkNewPassword('abcd'), 'length');
  assert.equal(await store.checkNewPassword('abcdef'), 'classes');
  assert.equal(await store.checkNewPassword('Lukas1', 'lukas1'), 'username');
  assert.equal(await store.checkNewPassword('abcde1', 'lukas'), null);
  // The owner's current password has one class and still works.
  assert.equal((await store.verifyPassword('lukas', PASSWORD, { rateLimitKey: 'p4' })).ok, true);

  await assert.rejects(store.recoverOwnerPassword(await claimReset('lukas'), 'abcd'), (e) => e.rule === 'length');
  await assert.rejects(store.recoverOwnerPassword(await claimReset('lukas'), 'Lukas'), (e) => e.rule === 'username');
  assert.equal((await store.recoverOwnerPassword(await claimReset('lukas'), 'abcde1')).ok, true);

  await redis.del(OWNER_RECORD_KEY);
  await assert.rejects(store.createOwner({ username: 'lukas', password: 'abcdef' }), (e) => e.code === 'invalid-password' && e.rule === 'classes');
  await assert.rejects(store.createOwner({ username: 'Lukas1', password: 'lukas1' }), (e) => e.rule === 'username');
  await redis.del(PASSWORD_POLICY_KEY);
});

test('changeOwnerPassword: checks the current password, moves the epoch and keeps only this session', async () => {
  const { loginSessions, store, recorded } = await withPolicyOwner();
  const mine = await loginSessions.issue({ method: 'password', userId: 'default' });
  const other = await loginSessions.issue({ method: 'password', userId: 'default' });
  const NEXT = 'changed password 2';

  assert.deepEqual(await store.changeOwnerPassword('default', 'wrong password', NEXT, mine.session.sessionId, { rateLimitKey: 'c1' }),
    { ok: false, reason: 'invalid' });
  await assert.rejects(store.changeOwnerPassword('default', PASSWORD, 'abc', mine.session.sessionId), (e) => e.rule === 'length');
  await assert.rejects(store.changeOwnerPassword('default', PASSWORD, 'LUKAS', mine.session.sessionId), (e) => e.rule === 'username');
  assert.ok(await loginSessions.verify(other.token), 'nothing changed yet');

  const listed = await loginSessions.listByUser('default');
  assert.ok(listed.some((s) => s.sessionId === mine.session.sessionId && s.method === 'password'));
  assert.equal(JSON.stringify(listed).includes(mine.token), false);

  const epoch = store.credentialEpoch();
  const out = await store.changeOwnerPassword('default', PASSWORD, NEXT, mine.session.sessionId, { rateLimitKey: 'c1' });
  assert.equal(out.ok, true);
  assert.ok(out.sessionsRevoked >= 1);
  assert.equal(store.credentialEpoch(), epoch + 1);
  assert.ok(await loginSessions.verify(mine.token), 'this session stays');
  assert.equal(await loginSessions.verify(other.token), null, 'the other one is signed out');
  assert.equal((await store.verifyPassword('lukas', PASSWORD, { rateLimitKey: 'c2' })).ok, false, 'old password fails');
  assert.equal((await store.verifyPassword('lukas', NEXT, { rateLimitKey: 'c2' })).ok, true);
  assert.deepEqual((await loginSessions.listByUser('default')).map((s) => s.sessionId), [mine.session.sessionId]);

  const entry = recorded.find((e) => e.action === IDENTITY_AUDIT_ACTIONS.passwordChanged);
  assert.deepEqual(entry.by, { kind: 'user', userId: 'default', session: mine.session.sessionId.slice(0, 8) });
  assert.equal(entry.detail.sessionsRevoked, out.sessionsRevoked);
  assert.equal(JSON.stringify(recorded).includes(NEXT), false);
});

test('changeOwnerPassword is rate limited and refuses a tampered record', async () => {
  const { store } = await withPolicyOwner();
  for (let i = 0; i < 10; i++) await store.changeOwnerPassword('default', 'wrong password', 'next password', 'a'.repeat(32), { rateLimitKey: 'c3' });
  assert.deepEqual(await store.changeOwnerPassword('default', PASSWORD, 'next password', 'a'.repeat(32), { rateLimitKey: 'c3' }),
    { ok: false, reason: 'rate-limited' });

  const o = JSON.parse(await redis.get(OWNER_RECORD_KEY));
  await redis.set(OWNER_RECORD_KEY, JSON.stringify({ ...o, username: 'mallory' }));
  assert.deepEqual(await store.changeOwnerPassword('default', PASSWORD, 'next password', 'a'.repeat(32), { rateLimitKey: 'c4' }),
    { ok: false, reason: 'invalid' });
});

test('revokeByUser keeps the excepted session', async () => {
  const a = await sessions.issue({ method: 'password', userId: 'user-x' });
  const b = await sessions.issue({ method: 'password', userId: 'user-x' });
  assert.equal(await sessions.revokeByUser('user-x', { except: a.session.sessionId }), 1);
  assert.ok(await sessions.verify(a.token));
  assert.equal(await sessions.verify(b.token), null);
  assert.equal(await sessions.revokeByUser('user-x'), 1);
});
