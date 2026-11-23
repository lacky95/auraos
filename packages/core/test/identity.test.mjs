// Owner account, login sessions, setup tickets and instance owner against a
// REAL valkey-server (KvServer on a tmp dataDir).
import { test, after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KvServer, createRedis } from '@aura/kv-store';
import {
  AdminAuth, AdminAudit, FileSetupTickets, IDENTITY_AUDIT_ACTIONS, LOGIN_ATTEMPTS_PER_KEY_PER_MINUTE,
  LOGIN_SESSION_PREFIX, LoginSessionStore, OWNER_RECORD_KEY, PASSWORD_MAX_BYTES, PASSWORD_SESSION_TTL_MS,
  SETUP_TICKET_TTL_MS, STAY_SIGNED_IN_TTL_MS, ValkeyUserStore, createSetupTicket, defaultIdentityKeyFile,
  defaultSetupTicketDir, operatorAttribution, rotateAdminCredential, readAdminCredential, userAttribution,
} from '../dist/auth/index.js';
import { adoptedInstanceOwner } from '../dist/app-manager/instanceOwner.js';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'aura-identity-'));
const SECRETS = join(DATA_DIR, 'aura', 'secrets');
const IDENTITY_KEY = defaultIdentityKeyFile(DATA_DIR);
const PASSWORD = 'correct horse battery';
const server = new KvServer();
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
  assert.equal(await users.setPassword('default', 'attacker password'), false);
  await redis.set(OWNER_RECORD_KEY, original);
  assert.ok(await users.getOwner());
});

test('setPassword replaces the hash and rejects unknown users', async () => {
  const username = (await users.getOwner()).username;
  assert.equal(await users.setPassword('someone-else', 'new password 1'), false);
  assert.equal(await users.setPassword('default', 'new password 1'), true);
  assert.equal((await users.verifyPassword(username, PASSWORD, { rateLimitKey: 'c5' })).ok, false);
  assert.equal((await users.verifyPassword(username, 'new password 1', { rateLimitKey: 'c5' })).ok, true);
  assert.equal(await users.setPassword('default', PASSWORD), true);
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
  await audit.record({ by: operatorAttribution(), action: IDENTITY_AUDIT_ACTIONS.passwordReset, target: 'user:default' });
  const [reset, login] = await audit.list(2);
  assert.equal(reset.actor, 'operator');
  assert.equal(login.actor, 'user:default');
  assert.equal(login.session, 'abcdef01');
  assert.equal(login.detail.method, 'password');
  assert.equal(JSON.stringify(login).includes(secret), false);
});

test('instance owner: label wins, adoption falls back, pool members stay unowned', () => {
  assert.equal(adoptedInstanceOwner('default', false), 'default');
  assert.equal(adoptedInstanceOwner('user-2', true), 'user-2');
  assert.equal(adoptedInstanceOwner(undefined, false), 'default', 'pre-owner container');
  assert.equal(adoptedInstanceOwner('../bad owner', false), 'default', 'malformed label');
  assert.equal(adoptedInstanceOwner(undefined, true), undefined, 'unclaimed pool member');
});
