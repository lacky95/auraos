// LoginSessionStore.isLive: a session id is live for one user while its nonce
// exists (revocation deletes it) and has not expired. Backs the App Host
// `sessionLive` check (packages/shell/server/app-host-auth.mjs).
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { kvServer, createRedis } from '@aura/kv-store';
import { LoginSessionStore, defaultIdentityKeyFile, loginSessionKey } from '../dist/auth/index.js';
import { OsEventBus } from '../dist/ipc/OsEventBus.js';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'aura-session-live-'));
let clock = 1_800_000_000_000;
let redis;
let sessions;

before(async () => {
  const uri = await kvServer.start({ dataDir: join(DATA_DIR, 'kv') });
  redis = createRedis(uri);
  sessions = new LoginSessionStore({ identityKeyFile: defaultIdentityKeyFile(DATA_DIR), redis: () => redis, now: () => clock });
});

after(async () => {
  redis?.disconnect();
  await kvServer.stop();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

test('a password session is live for its own user only, until revoked or expired', async () => {
  const { session } = await sessions.issue({ method: 'password', userId: 'default', ttlMs: 60_000 });
  assert.equal(await sessions.isLive(session.sessionId, 'default'), true);
  assert.equal(await sessions.isLive(session.sessionId, 'someone-else'), false, 'another user');
  assert.equal(await sessions.isLive('not-a-session-id', 'default'), false);

  clock += 61_000;   // past expiresAt, even while the key is still in Valkey
  assert.equal(await sessions.isLive(session.sessionId, 'default'), false, 'expired');
  clock -= 61_000;

  await sessions.revoke(session.sessionId);
  assert.equal(await sessions.isLive(session.sessionId, 'default'), false, 'revoked');
});

test('a retired shared-key (admin) nonce never counts as a user session', async () => {
  // Left over from before D50; one planted with a user is still not a password session.
  const sid = 'b'.repeat(32);
  await redis.set(loginSessionKey(sid), JSON.stringify({ m: 'shared-key', u: 'default', createdAt: clock, expiresAt: clock + 60_000 }));
  assert.equal(await sessions.isLive(sid, 'default'), false);
});

test('every revocation tells session holders (open event streams) to check theirs again', async () => {
  const seen = [];
  const on = (ev) => seen.push(ev.count);
  OsEventBus.on('auth:sessionsRevoked', on);
  try {
    const a = await sessions.issue({ method: 'password', userId: 'default', ttlMs: 60_000 });
    const b = await sessions.issue({ method: 'password', userId: 'default', ttlMs: 60_000 });
    const c = await sessions.issue({ method: 'password', userId: 'default', ttlMs: 60_000 });
    assert.equal(await sessions.revoke(a.session.sessionId), true);
    assert.equal(await sessions.revoke(a.session.sessionId), false, 'already gone: nothing to tell');
    const n = await sessions.revokeByUser('default', { except: c.session.sessionId });
    assert.ok(n >= 1);
    assert.deepEqual(seen, [1, n], 'one event per revoke call that removed something');
    assert.equal(await sessions.isLive(b.session.sessionId, 'default'), false);
    assert.equal(await sessions.isLive(c.session.sessionId, 'default'), true);
  } finally {
    OsEventBus.off('auth:sessionsRevoked', on);
  }
});

test('listing sessions prunes nonces past their expiry and lists only live ones', async () => {
  const live = await sessions.issue({ method: 'password', userId: 'lister', ttlMs: 120_000 });
  const old = await sessions.issue({ method: 'password', userId: 'lister', ttlMs: 60_000 });
  const elsewhere = await sessions.issue({ method: 'password', userId: 'someone-else', ttlMs: 60_000 });
  clock += 61_000;   // both 60 s nonces are past expiresAt; Valkey's own TTL has not run (real clock)
  try {
    const listed = await sessions.listByUser('lister');
    assert.deepEqual(listed.map((s) => s.sessionId), [live.session.sessionId]);
    assert.equal(await redis.exists(loginSessionKey(old.session.sessionId)), 0, 'pruned');
    assert.equal(await redis.exists(loginSessionKey(elsewhere.session.sessionId)), 0, 'pruned for any user');
    assert.equal(await redis.exists(loginSessionKey(live.session.sessionId)), 1);
  } finally {
    clock -= 61_000;
  }
});
