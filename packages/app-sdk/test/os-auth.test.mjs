// The SDK's shared base and auth helper: browser and server bases, no token
// in a browser or on a proxied URL, and the OS sidecar behavior it replaced.
//
//   pnpm --filter @aura/app-sdk test
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { isBrowser, osAuthHeaders, osBase } from '../dist/os-auth.js';
import { osSidecars, OsSidecarError } from '../dist/os-sidecars.js';
import { NotificationsApi } from '../dist/notifications.js';
import { OsClient } from '../dist/OsClient.js';

const KEYS = ['OS_API_BASE', 'AURA_OS_URL', 'AURA_INSTANCE_TOKEN'];
let saved;
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});
afterEach(() => {
  delete globalThis.window;
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});
const inBrowser = () => { globalThis.window = { location: { origin: 'https://desk.test' }, addEventListener() {}, removeEventListener() {} }; };

test('osBase keeps each caller’s Node and browser default', () => {
  assert.equal(osBase(), 'http://localhost:3000');
  assert.equal(osBase({ fallback: 'http://127.0.0.1:3000' }), 'http://127.0.0.1:3000');
  assert.equal(osBase({ mode: 'origin' }), 'http://localhost:3000');
  assert.equal(osBase({ mode: 'server' }), '');
  process.env.AURA_OS_URL = 'http://sidecar-os:3000';
  assert.equal(osBase({ mode: 'server' }), 'http://sidecar-os:3000');
  assert.equal(osBase(), 'http://localhost:3000', 'only the sidecar mode reads AURA_OS_URL');
  process.env.OS_API_BASE = 'http://aura-shell:3000';
  assert.equal(osBase(), 'http://aura-shell:3000');
  assert.equal(osBase({ mode: 'server' }), 'http://aura-shell:3000');

  inBrowser();
  assert.equal(isBrowser(), true);
  assert.equal(osBase(), '', 'relative wins over env in a browser');
  assert.equal(osBase({ mode: 'origin' }), 'http://aura-shell:3000', 'OsClient has always honoured a defined env first');
  delete process.env.OS_API_BASE;
  assert.equal(osBase({ mode: 'origin' }), 'https://desk.test');
  assert.equal(new OsClient().base, 'https://desk.test');
});

test('a browser never gets a token, explicit or from the env', () => {
  process.env.OS_API_BASE = 'http://os';
  process.env.AURA_INSTANCE_TOKEN = 'env-token';
  assert.deepEqual(osAuthHeaders('http://os/api/notifications'), { Authorization: 'Bearer env-token' });
  inBrowser();
  assert.deepEqual(osAuthHeaders('http://os/api/notifications'), {});
  assert.deepEqual(osAuthHeaders('/api/notifications', { token: 'explicit' }), {});
});

test('proxied URLs stay tokenless in every spelling', () => {
  process.env.OS_API_BASE = 'http://os';
  process.env.AURA_INSTANCE_TOKEN = 'env-token';
  for (const u of ['http://os/api/proxy/a/b', 'http://os/api/proxy', 'http://os//api/proxy/a', 'http://os/API/Proxy/a',
    'http://os/api/x/../proxy/a', 'http://os/api/%70roxy/a', 'http://os/api/%2570roxy/a', '/api/proxy/a', 'http://os/%zz']) {
    assert.deepEqual(osAuthHeaders(u, { token: 'explicit' }), {}, u);
  }
  assert.deepEqual(osAuthHeaders('http://os/api/proxyish'), { Authorization: 'Bearer env-token' });
});

test('a page render forwards the owner SSR claim with the token, to the shell only (D45)', () => {
  process.env.OS_API_BASE = 'http://os';
  const page = new Request('http://settings--desk.test/apps', { headers: { 'x-aura-owner-ssr': 'agw1.claim.mac' } });
  assert.deepEqual(osAuthHeaders('http://os/api/apps', { request: page }), {});
  process.env.AURA_INSTANCE_TOKEN = 'env-token';
  assert.deepEqual(osAuthHeaders('http://os/api/apps', { request: page }),
    { Authorization: 'Bearer env-token', 'x-aura-owner-ssr': 'agw1.claim.mac' });
  assert.deepEqual(osAuthHeaders('http://os/api/apps', { request: new Request('http://settings--desk.test/apps') }),
    { Authorization: 'Bearer env-token' });
  assert.deepEqual(osAuthHeaders('http://os/api/proxy/com.example.counter/x', { request: page }), {}, 'never to another app');
  inBrowser();
  assert.deepEqual(osAuthHeaders('http://os/api/apps', { request: page }), {});
});

test('L2: the token and the owner SSR claim go to the OS base only, never another origin', () => {
  process.env.OS_API_BASE = 'http://aura-shell:3000';
  process.env.AURA_INSTANCE_TOKEN = 'env-token';
  const page = new Request('http://settings--desk.test/apps', { headers: { 'x-aura-owner-ssr': 'agw1.claim.mac' } });
  assert.deepEqual(osAuthHeaders('https://example.com/x', { request: page }), {});
  assert.deepEqual(osAuthHeaders('http://aura-shell:3001/api/apps', { request: page }), {}, 'another port is another origin');
  assert.deepEqual(osAuthHeaders('http://aura-shell.evil.test:3000/api/apps', { request: page }), {});
  assert.deepEqual(osAuthHeaders('//example.com/x', { request: page }), {});
  assert.deepEqual(osAuthHeaders('file:///etc/passwd'), {});
  assert.deepEqual(osAuthHeaders('http://aura-shell:3000/api/apps', { request: page }),
    { Authorization: 'Bearer env-token', 'x-aura-owner-ssr': 'agw1.claim.mac' });
  assert.deepEqual(osAuthHeaders('/api/apps'), { Authorization: 'Bearer env-token' }, 'a path the caller resolves against the OS base');
  delete process.env.OS_API_BASE;
  assert.deepEqual(osAuthHeaders('http://localhost:3000/api/apps'), { Authorization: 'Bearer env-token' }, 'the default base');
  process.env.AURA_OS_URL = 'http://sidecar-os:3000';
  assert.deepEqual(osAuthHeaders('http://sidecar-os:3000/api/x'), { Authorization: 'Bearer env-token' }, 'a sidecar\'s OS URL');
});

test('notifications send no token from a browser', async () => {
  process.env.AURA_INSTANCE_TOKEN = 'env-token';
  inBrowser();
  const calls = [];
  const fetchStub = async (url, init) => {
    calls.push({ url, headers: init.headers });
    return new Response(JSON.stringify({ items: [] }), { status: 200 });
  };
  await new NotificationsApi({ token: 'explicit', fetch: fetchStub }).list();
  assert.equal(calls[0].url, '/api/notifications');
  assert.equal(calls[0].headers.Authorization, undefined);
});

test('osSidecars: same base errors, refuses in a browser, sends nothing there', async () => {
  assert.throws(() => osSidecars({ instanceId: 'a.b' }), /no OS API base/);
  process.env.OS_API_BASE = 'http://os';
  assert.throws(() => osSidecars(), /no instance id/);
  const none = osSidecars({ instanceId: 'a.b', fetch: async () => { throw new Error('must not fetch'); } });
  await assert.rejects(none.list(), /no AURA_INSTANCE_TOKEN/);

  const calls = [];
  const fetchStub = async (url, init) => {
    calls.push({ url, headers: init.headers });
    return new Response(JSON.stringify({ sidecars: [] }), { status: 200 });
  };
  const sc = osSidecars({ instanceId: 'a.b', token: 'tok', fetch: fetchStub });
  await sc.list();
  assert.equal(calls[0].url, 'http://os/api/instances/a.b/sidecars?view=managed');
  assert.equal(calls[0].headers.Authorization, 'Bearer tok');

  inBrowser();
  await assert.rejects(sc.list(), (e) => e instanceof OsSidecarError && e.status === 401);
  assert.equal(calls.length, 1, 'no request left the browser');
});
