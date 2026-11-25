// LoginSessionStore.isLive: a session id is live for one user while its nonce
// exists (revocation deletes it) and has not expired. Backs the App Host
// `sessionLive` check (packages/shell/server/app-host-auth.mjs).
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { kvServer, createRedis } from '@aura/kv-store';
import { AdminAuth, defaultIdentityKeyFile, loginSessionKey } from '../dist/auth/index.js';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'aura-session-live-'));
let clock = 1_800_000_000_000;
let redis;
let sessions;

before(async () => {
  const uri = await kvServer.start({ dataDir: join(DATA_DIR, 'kv') });
  redis = createRedis(uri);
  const admin = new AdminAuth({
    keyFile: join(DATA_DIR, 'aura', 'secrets', 'admin.key'),
    identityKeyFile: defaultIdentityKeyFile(DATA_DIR), redis: () => redis, now: () => clock,
  });
  admin.ensure();
  sessions = admin.sessions;
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

test('a shared-key (admin) session never counts as a user session', async () => {
  // The nonce of an admin session carries no user; one planted with a user is still not a password session.
  const sid = 'b'.repeat(32);
  await redis.set(loginSessionKey(sid), JSON.stringify({ m: 'shared-key', u: 'default', createdAt: clock, expiresAt: clock + 60_000 }));
  assert.equal(await sessions.isLive(sid, 'default'), false);
});
