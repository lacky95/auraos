// D108 P4: osClient.setup.config() reads GET /api/setup/self with the
// instance token (server side only) and returns the SetupConfig; anything
// else is an OsError carrying the D105 code.
//
//   pnpm --filter @aura/app-sdk test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SetupApi } from '../dist/setup.js';
import { OsClient } from '../dist/OsClient.js';
import { OsError } from '../dist/errors.js';

const BASE = 'http://aura-shell.test:3000';
const CONFIG = {
  appId: 'com.example.mailer', installationId: 'i-1', profile: null, values: { host: 'mail.example', tls: true },
  secrets: { password: 'cred_' + 'A'.repeat(22) }, degraded: [], configDigest: 'sha256:c',
};

function stub(t, answer) {
  const seen = [];
  const env = { OS_API_BASE: process.env.OS_API_BASE, AURA_INSTANCE_TOKEN: process.env.AURA_INSTANCE_TOKEN };
  process.env.OS_API_BASE = BASE;
  process.env.AURA_INSTANCE_TOKEN = 'tok-1';
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    seen.push({ url: String(url), auth: init.headers?.Authorization, method: init.method ?? 'GET' });
    const [status, body] = answer(String(url));
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  });
  t.after(() => {
    t.mock.restoreAll();
    for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  return seen;
}

test('config(): GET /api/setup/self with the instance bearer; returns the configuration', async (t) => {
  const seen = stub(t, () => [200, CONFIG]);
  assert.deepEqual(await new SetupApi().config(), CONFIG);
  assert.deepEqual(seen, [{ url: `${BASE}/api/setup/self`, auth: 'Bearer tok-1', method: 'GET' }]);
  await new SetupApi().config({ token: 'tok-2' });
  assert.equal(seen[1].auth, 'Bearer tok-2');
  assert.ok(new OsClient().setup instanceof SetupApi, 'osClient.setup');
});

test('config(): a D105 refusal or 503 is an OsError with its code; a malformed answer is invalid-response', async (t) => {
  let answer = [409, { error: 'setup-required', category: 'needs-setup', message: 'complete the setup first' }];
  stub(t, () => answer);
  await assert.rejects(new SetupApi().config(), (e) => e instanceof OsError && e.status === 409 && e.code === 'setup-required');
  answer = [503, { error: 'unavailable', category: 'unavailable', message: 'no engine' }];
  await assert.rejects(new SetupApi().config(), (e) => e instanceof OsError && e.status === 503 && e.code === 'unavailable');
  answer = [200, { appId: 'x' }];
  await assert.rejects(new SetupApi().config(), (e) => e instanceof OsError && e.code === 'invalid-response');
});

test('config(): outside AuraOS (no OS_API_BASE) refuses before any request', async (t) => {
  const seen = stub(t, () => [200, CONFIG]);
  delete process.env.OS_API_BASE;
  const saved = process.env.AURA_OS_URL;
  delete process.env.AURA_OS_URL;
  t.after(() => { if (saved !== undefined) process.env.AURA_OS_URL = saved; });
  await assert.rejects(new SetupApi().config(), (e) => e instanceof OsError && e.code === 'no-os');
  assert.equal(seen.length, 0);
});
