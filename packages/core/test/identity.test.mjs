// Owner account, login sessions, setup tickets and instance owner against a
// REAL valkey-server (KvServer on a tmp dataDir).
import { test, after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { kvServer, defaultRedis, createRedis } from '@aura/kv-store';
import {
  AdminAuth, AdminAudit, FileSetupTickets, IDENTITY_AUDIT_ACTIONS, IdentityKeyError, getAuthServices, resetAuthServices, LOGIN_ATTEMPTS_PER_KEY_PER_MINUTE,
  LOGIN_SESSION_PREFIX, LoginSessionStore, OWNER_RECORD_KEY, PASSWORD_MAX_BYTES, PASSWORD_SESSION_TTL_MS,
  SETUP_TICKET_TTL_MS, STAY_SIGNED_IN_TTL_MS, ValkeyUserStore, createSetupTicket, defaultIdentityKeyFile,
  defaultSetupTicketDir, operatorAttribution, rotateAdminCredential, readAdminCredential, userAttribution,
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
let users, admin, sessions, audit;

before(async () => {
  const uri = await server.start({ dataDir: join(DATA_DIR, 'kv') });
  redis = createRedis(uri);
  users = new ValkeyUserStore({ identityKeyFile: IDENTITY_KEY, redis: r, now });
  admin = new AdminAuth({ keyFile: join(SECRETS, 'admin.key'), redis: r, now });
  sessions = admin.sessions;
  audit = new AdminAudit(r, now);
  admin.ensure();
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
    const auth = new AdminAuth({ keyFile: join(dir, 'admin.key'), redis: () => flaky, now });
    auth.ensure();
    const unlocked = await auth.unlock(readAdminCredential(auth.keyFile));
    const password = await auth.sessions.issue({ method: 'password', userId: 'default' });
    down = true;
    await assert.rejects(auth.verifySession(unlocked.token), /valkey down/);
    await assert.rejects(auth.peekSession(unlocked.token), /valkey down/);
    await assert.rejects(auth.sessions.verify(password.token), /valkey down/);
    assert.equal(await auth.sessions.verify('aura-sess1.bad.sig'), null, 'a bad token needs no store');
    down = false;
    assert.ok(await auth.verifySession(unlocked.token), 'the session survives the blip');

    await redis.set(`usersess:${unlocked.sessionId}`, 'not json');
    assert.equal(await auth.verifySession(unlocked.token), null, 'a corrupt nonce is invalid');
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
  assert.equal(await sessions.verify(`aura-admin1.${payload}.${sig}`), null);
  assert.equal(await admin.verifySession(`aura-admin1.${payload}.${sig}`), null);
  assert.equal(await admin.verifySession(token), null, 'a password session is never admin');
  const forged = Buffer.from(JSON.stringify({ s: 'a'.repeat(32), e: clock + 1000, m: 'password', u: 'default' })).toString('base64url');
  assert.equal(await sessions.verify(`${LOGIN_SESSION_PREFIX}.${forged}.${sig}`), null);
  for (const bad of [null, undefined, '', 'garbage', 'a.b.c', `${LOGIN_SESSION_PREFIX}.x`, 'x'.repeat(5000)]) {
    assert.equal(await sessions.verify(bad), null);
  }
  // A session with a different key file cannot verify this token.
  const other = new LoginSessionStore({ identityKeyFile: join(DATA_DIR, 'other', 'identity.key'), redis: r, now });
  assert.equal(await other.verify(token), null);
});

test('rotation revokes shared-key sessions only', async () => {
  const cred = readAdminCredential(admin.keyFile);
  const shared = await admin.unlock(cred);
  assert.match(shared.token, /^aura-admin1\./);
  assert.equal(shared.expiresAt, clock + 15 * 60_000);
  assert.deepEqual(await admin.verifySession(shared.token), { sessionId: shared.sessionId, expiresAt: shared.expiresAt });
  const password = await sessions.issue({ method: 'password', userId: 'default' });

  const purged = new Promise((resolve) => {
    const watcher = new AdminAuth({ keyFile: admin.keyFile, redis: r, now, onRotated: resolve });
    watcher.ensure();
    const fresh = rotateAdminCredential(admin.keyFile);
    assert.equal(watcher.verifyCredential(fresh), true);
  });
  assert.ok(await purged >= 1);
  assert.equal(await admin.verifySession(shared.token), null);
  assert.equal((await sessions.verify(password.token)).userId, 'default', 'password user stays signed in');
  assert.equal((await admin.unlock(readAdminCredential(admin.keyFile))).ok, true, 'recovery still works');
  await sessions.revoke(password.session.sessionId);
});

test('rotation invalidates a shared-key token even if the purge never ran', async () => {
  const s = await admin.unlock(readAdminCredential(admin.keyFile));
  rotateAdminCredential(admin.keyFile);
  // The nonce is still present for a store that has not purged yet.
  const fresh = new AdminAuth({ keyFile: admin.keyFile, redis: r, now });
  fresh.ensure();
  assert.equal(await redis.exists(`usersess:${s.sessionId}`), 1);
  assert.equal(await fresh.verifySession(s.token), null);
  assert.equal(await admin.sessions.verify(s.token), null);
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
  const adminAuth = new AdminAuth({ keyFile: join(secrets, 'admin.key'), identityKeyFile, redis: r, now });
  adminAuth.ensure();
  const store = new ValkeyUserStore({ identityKeyFile, redis: r, now, sessions: adminAuth.sessions, ...extra });
  await redis.del(OWNER_RECORD_KEY);
  if (username) assert.ok(await store.createOwner({ username, password: PASSWORD }));
  const tickets = new FileSetupTickets({ dir: defaultSetupTicketDir(dataDir), now });
  const claimReset = (name = username) =>
    tickets.claim(createSetupTicket(dataDir, { purpose: 'reset', username: name }, now).code, 'reset');
  return { dataDir, identityKeyFile, adminAuth, store, tickets, claimReset };
}

test('shared-key unlock and verify work with a missing, malformed or replaced identity.key', async () => {
  const { identityKeyFile, adminAuth } = await isolated();
  const cred = readAdminCredential(adminAuth.keyFile);
  const before = await adminAuth.unlock(cred);
  assert.equal(before.ok, true);

  rmSync(identityKeyFile);
  assert.ok(await adminAuth.verifySession(before.token), 'missing: existing session');
  assert.equal((await adminAuth.unlock(cred)).ok, true, 'missing: unlock');

  rmSync(identityKeyFile, { force: true });
  writeFileSync(identityKeyFile, 'not a key', { mode: 0o600 });
  assert.ok(await adminAuth.verifySession(before.token), 'malformed: existing session');
  const during = await adminAuth.unlock(cred);
  assert.equal(during.ok, true, 'malformed: unlock');
  assert.ok(await adminAuth.verifySession(during.token));

  rmSync(identityKeyFile);
  writeFileSync(identityKeyFile, `aura_identity_${'A'.repeat(43)}\n`, { mode: 0o600 });
  assert.ok(await adminAuth.verifySession(before.token), 'replaced: existing session');
});

test('rotation invalidates shared sessions while identity.key is malformed', async () => {
  const { identityKeyFile, adminAuth } = await isolated();
  rmSync(identityKeyFile);
  writeFileSync(identityKeyFile, 'garbage', { mode: 0o600 });
  const old = readAdminCredential(adminAuth.keyFile);
  const s = await adminAuth.unlock(old);
  assert.equal(s.ok, true);
  const fresh = rotateAdminCredential(adminAuth.keyFile);
  assert.equal(await adminAuth.verifySession(s.token), null);
  assert.equal((await adminAuth.unlock(old)).ok, false);
  assert.equal((await adminAuth.unlock(fresh)).ok, true);
});

test('a malformed identity.key fails password login closed, with a clear error', async () => {
  const errors = [];
  const { identityKeyFile, adminAuth, store } = await isolated('lukas', { onIdentityKeyError: (e) => errors.push(e) });
  const live = await adminAuth.sessions.issue({ method: 'password', userId: 'default' });
  rmSync(identityKeyFile);
  writeFileSync(identityKeyFile, 'garbage', { mode: 0o600 });

  assert.equal(store.identityKeyStatus(), 'malformed');
  assert.deepEqual(await store.verifyPassword('lukas', PASSWORD, { rateLimitKey: 'k1' }), { ok: false, reason: 'invalid' });
  assert.equal(await store.getOwner(), null);
  assert.equal(await store.hasOwner(), true);
  assert.equal(await adminAuth.sessions.verify(live.token), null);
  await assert.rejects(adminAuth.sessions.issue({ method: 'password', userId: 'default' }), IdentityKeyError);
  assert.equal(errors.length, 1, 'reported once');
  assert.match(errors[0].message, /identity\.key is malformed.*reset-password/);
  assert.equal(errors[0].message.includes('garbage'), false);
  assert.equal(readFileSync(identityKeyFile, 'utf-8'), 'garbage', 'never overwritten');
});

test('cross-method relabelling is rejected in both directions', async () => {
  const { adminAuth } = await isolated();
  const sessionsStore = adminAuth.sessions;
  const pw = await sessionsStore.issue({ method: 'password', userId: 'default' });
  const shared = await adminAuth.unlock(readAdminCredential(adminAuth.keyFile));
  const swap = (token, prefix) => [prefix, ...token.split('.').slice(1)].join('.');

  const asAdmin = swap(pw.token, 'aura-admin1');
  assert.equal(await sessionsStore.verify(asAdmin), null);
  assert.equal(await adminAuth.verifySession(asAdmin), null);
  const asPassword = swap(shared.token, LOGIN_SESSION_PREFIX);
  assert.equal(await sessionsStore.verify(asPassword), null);

  // A correctly keyed payload claiming the other method is also refused.
  const [, payload, sig] = pw.token.split('.');
  const claim = JSON.parse(Buffer.from(payload, 'base64url').toString());
  const flipped = Buffer.from(JSON.stringify({ ...claim, m: 'shared-key' })).toString('base64url');
  assert.equal(await sessionsStore.verify(`${LOGIN_SESSION_PREFIX}.${flipped}.${sig}`), null);
  assert.equal(await sessionsStore.verify(`aura-admin1.${flipped}.${sig}`), null);
});

test('recovery after a replaced identity.key re-seals from the ticket and revokes password sessions', async () => {
  const recovered = [];
  const { identityKeyFile, adminAuth, store, claimReset } = await isolated('lukas', { onOwnerRecovered: (e) => { recovered.push(e); } });
  const pw = await adminAuth.sessions.issue({ method: 'password', userId: 'default' });
  const shared = await adminAuth.unlock(readAdminCredential(adminAuth.keyFile));
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
  assert.ok(await adminAuth.verifySession(shared.token), 'shared-key session unaffected');
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
    svc0.admin.ensure();
    await redis.del(OWNER_RECORD_KEY);
    assert.ok(await svc0.users.createOwner({ username: 'lukas', password: PASSWORD }));
    writeFileSync(keyFile, 'garbage', { mode: 0o600 });

    resetAuthServices();
    const svc = getAuthServices();
    assert.equal(svc.loginSessions, svc.admin.sessions);
    assert.equal((await svc.admin.unlock(readAdminCredential(svc.admin.keyFile))).ok, true);
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
