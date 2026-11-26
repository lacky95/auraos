// `osClient.user.get/onChange` and `osClient.storage` (D46): which route,
// which credential, and that the app never names the user.
//
//   pnpm --filter @aura/app-sdk test
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { UserApi, UserError } from '../dist/user.js';
import { StorageApi, StorageError } from '../dist/storage.js';

const KEYS = ['OS_API_BASE', 'AURA_OS_URL', 'AURA_INSTANCE_TOKEN', 'APP_ID', 'AURA_APP_ID'];
let saved;
let realFetch;
let calls;
function serve(handler) {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body });
    const [status, body] = handler(String(url), init);
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  };
}
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  realFetch = globalThis.fetch;
});
afterEach(() => {
  delete globalThis.window;
  globalThis.fetch = realFetch;
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const ME = {
  userId: 'u1', username: 'lu', role: 'owner', isOwner: true, verified: true,
  systemId: 'sys-1', ref: 'u1@sys-1', profile: { displayName: 'Lu' },
};

/** A page on an App Host: the runtime bootstrap the SDK checks. */
function onAppHost(appId = 'com.ex.notes') {
  const listeners = [];
  globalThis.window = {
    location: { origin: 'https://notes.app.test' },
    AuraRuntimeBootstrap: {
      channelVersion: 1, gatewayBase: '/_aura/os/', appOrigin: 'https://notes.app.test', shellOrigin: 'https://desk.test', appId,
    },
    addEventListener(t, f) { listeners.push([t, f]); },
    removeEventListener() {},
  };
}

test('user.get() on the server: OS_API_BASE with the instance token, nothing app-chosen', async () => {
  process.env.OS_API_BASE = 'http://aura-shell:3000';
  process.env.AURA_INSTANCE_TOKEN = 'aura1.tok';
  serve(() => [200, ME]);
  const me = await new UserApi().get();
  assert.deepEqual(me, ME);
  assert.equal(calls[0].url, 'http://aura-shell:3000/api/user/me');
  assert.equal(calls[0].headers.Authorization, 'Bearer aura1.tok');
  assert.equal(calls[0].method, 'GET');
});

test('user.get(): every profile field optional; a missing profile is {}', async () => {
  process.env.OS_API_BASE = 'http://aura-shell:3000';
  serve(() => [200, { ...ME, profile: undefined }]);
  assert.deepEqual((await new UserApi().get()).profile, {});
});

test('user.get() rejects with UserError on 401', async () => {
  process.env.OS_API_BASE = 'http://aura-shell:3000';
  serve(() => [401, { error: 'login-required' }]);
  await assert.rejects(new UserApi().get(), (e) => e instanceof UserError && e.status === 401 && e.code === 'login-required');
});

test('user.onChange() re-reads on user:changed and delivers only the newest read', async () => {
  onAppHost();
  serve(() => [200, ME]);
  let handler;
  const off = () => { handler = null; };
  const events = { subscribeOsEvents(topics, h) { assert.deepEqual(topics, ['user:changed']); handler = h; return off; } };
  const got = [];
  const unsub = new UserApi(events).onChange((u) => got.push(u));
  handler({ type: 'user:changed', userId: 'u1' });
  handler({ type: 'user:changed', userId: 'u1' });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(got.length, 1);
  assert.deepEqual(got[0], ME);
  assert.equal(calls[0].url, '/_aura/os/api/user/me', 'through the gateway, no token');
  assert.equal(calls[0].headers.Authorization, undefined);
  unsub();
  assert.equal(handler, null);
});

test('user.onChange() is a no-op on the server', () => {
  const unsub = new UserApi({ subscribeOsEvents() { throw new Error('not on the server'); } }).onChange(() => {});
  unsub();
});

test('storage: per user by default, `.shared` for every user; the URL never names a user', async () => {
  onAppHost('com.ex.notes');
  serve((url, init) => {
    if ((init.method ?? 'GET') === 'GET') return url.includes('missing') ? [404, { error: 'none' }] : [200, { value: { n: 1 }, updatedAt: 1 }];
    if (init.method === 'DELETE') return [200, { removed: true }];
    return [200, { value: JSON.parse(init.body).value, updatedAt: 2 }];
  });
  const s = new StorageApi();
  assert.deepEqual(await s.get('draft'), { n: 1 });
  assert.equal(await s.get('missing'), null);
  await s.set('dir/x', [1]);
  assert.equal(await s.delete('draft'), true);
  await s.shared.set('board', 'b');
  assert.deepEqual(calls.map((c) => [c.method, c.url]), [
    ['GET', '/_aura/os/api/kv/app/com.ex.notes/draft'],
    ['GET', '/_aura/os/api/kv/app/com.ex.notes/missing'],
    ['PUT', '/_aura/os/api/kv/app/com.ex.notes/dir/x'],
    ['DELETE', '/_aura/os/api/kv/app/com.ex.notes/draft'],
    ['PUT', '/_aura/os/api/kv/app/com.ex.notes/board?shared=1'],
  ]);
  assert.equal(calls[2].body, JSON.stringify({ value: [1] }));
  assert.ok(calls.every((c) => !/\/u\/|userId|default/.test(c.url)));
  assert.equal(s.shared.shared, undefined);
});

test('storage on the server: APP_ID and the instance token', async () => {
  process.env.OS_API_BASE = 'http://aura-shell:3000';
  process.env.AURA_INSTANCE_TOKEN = 'aura1.tok';
  process.env.APP_ID = 'com.ex.notes';
  serve(() => [403, { error: 'forbidden' }]);
  const s = new StorageApi();
  await assert.rejects(s.get('k'), (e) => e instanceof StorageError && e.status === 403 && e.code === 'forbidden');
  assert.equal(calls[0].url, 'http://aura-shell:3000/api/kv/app/com.ex.notes/k');
  assert.equal(calls[0].headers.Authorization, 'Bearer aura1.tok');
});

test('storage refuses bad keys before any request', async () => {
  process.env.APP_ID = 'com.ex.notes';
  serve(() => [200, {}]);
  for (const k of ['', 'a:b', '../x', ' x', 'x'.repeat(129)]) {
    await assert.rejects(new StorageApi().get(k), (e) => e instanceof StorageError && e.code === 'invalid-key', k);
  }
  assert.equal(calls.length, 0);
});
