// osSidecars(): the SDK client for OS-managed sidecars, against a fake OS
// (local HTTP server). Pins the routes and bodies it sends, the Bearer
// token, the env fallbacks (also the ones an OS sidecar gets), error mapping,
// and createSidecars({ mode: 'os' }) delegating to it.
//
//   pnpm --filter @aura/app-sdk test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { osSidecars, OsSidecarError } from '../dist/os-sidecars.js';
import { createSidecars } from '../dist/sidecars.js';

async function fakeOs(t, handler) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const rec = { method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : undefined };
    seen.push(rec);
    const [status, data] = handler(rec);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return { base: `http://127.0.0.1:${server.address().port}`, seen };
}

const sidecar = (name) => ({ name, template: 'box', image: 'alpine:3', containerName: `aura-a.b-2--${name}`, host: `aura-a.b-2--${name}`, state: 'running', createdAt: '', managedBy: 'os', mounts: { own: true, inherit: false, exclude: [], forceRo: false }, specHash: 'h' });

test('every call carries the bearer and hits the instance route', async (t) => {
  const os = await fakeOs(t, ({ method, url }) => {
    if (method === 'POST' && url.endsWith('/sidecars')) return [201, { ok: true, created: true, sidecar: sidecar('box-1') }];
    if (url.includes('view=managed')) return [200, { sidecars: [sidecar('box-1')] }];
    if (url.endsWith('/exec')) return [200, { exitCode: 0, stdout: 'hi\n', stderr: '', truncated: false, timedOut: false }];
    if (url.includes('/logs')) return [200, { stdout: 'l\n', stderr: '' }];
    if (method === 'GET' && url.endsWith('/mounts')) return [200, { capable: true, mounts: [] }];
    if (method === 'POST' && url.endsWith('/mounts')) return [200, { ok: true, mount: { id: 'com.x' } }];
    if (method === 'GET' && url.endsWith('/sidecars/box-1')) return [200, { sidecar: sidecar('box-1') }];
    return [200, { ok: true }];
  });
  const sc = osSidecars({ base: os.base, instanceId: 'a.b-2', token: 'tok' });
  const spawned = await sc.spawn({ template: 'box', suffix: '1', mounts: { own: true } });
  assert.equal(spawned.created, true);
  assert.equal(spawned.sidecar.host, 'aura-a.b-2--box-1');
  assert.equal((await sc.list()).length, 1);
  assert.equal((await sc.get('box-1')).name, 'box-1');
  assert.equal((await sc.exec('box-1', ['echo', 'hi'], { timeoutMs: 5000 })).stdout, 'hi\n');
  assert.equal((await sc.logs('box-1', { tail: 5, timestamps: true })).stdout, 'l\n');
  await sc.mounts('box-1').list();
  await sc.mounts('box-1').add('com.x', { mode: 'rw' });
  await sc.mounts('box-1').remove('com.x:data');
  await sc.remove('box-1');

  assert.ok(os.seen.every((r) => r.auth === 'Bearer tok'));
  assert.deepEqual(os.seen.map((r) => `${r.method} ${r.url}`), [
    'POST /api/instances/a.b-2/sidecars',
    'GET /api/instances/a.b-2/sidecars?view=managed',
    'GET /api/instances/a.b-2/sidecars/box-1',
    'POST /api/instances/a.b-2/sidecars/box-1/exec',
    'GET /api/instances/a.b-2/sidecars/box-1/logs?tail=5&timestamps=1',
    'GET /api/instances/a.b-2/sidecars/box-1/mounts',
    'POST /api/instances/a.b-2/sidecars/box-1/mounts',
    'DELETE /api/instances/a.b-2/sidecars/box-1/mounts/com.x%3Adata',
    'DELETE /api/instances/a.b-2/sidecars/box-1',
  ]);
  assert.deepEqual(os.seen[0].body, { template: 'box', suffix: '1', mounts: { own: true } });
  assert.deepEqual(os.seen[3].body, { cmd: ['echo', 'hi'], timeoutMs: 5000 });
  assert.deepEqual(os.seen[6].body, { targetAppId: 'com.x', mode: 'rw' });
});

test('errors carry the HTTP status and the OS message; get() maps 404 to null', async (t) => {
  const os = await fakeOs(t, ({ url }) => (url.endsWith('/nope') ? [404, { error: "no OS sidecar 'nope' in a.b-2" }]
    : url.includes('/gone.app/') ? [404, { error: 'Instance not found: gone.app' }]
    : [403, { error: "io.x is not granted 'sidecars.spawn'" }]));
  const sc = osSidecars({ base: os.base, instanceId: 'a.b-2', token: 'tok' });
  assert.equal(await sc.get('nope'), null);
  await assert.rejects(osSidecars({ base: os.base, instanceId: 'gone.app', token: 'tok' }).get('x'), /Instance not found/, 'a missing instance is an error, not absence');
  await assert.rejects(sc.spawn({ template: 'box' }), (e) => e instanceof OsSidecarError && e.status === 403 && /sidecars\.spawn/.test(e.message));
});

test('env fallbacks: app vars first, then the ones an OS sidecar receives', async (t) => {
  const os = await fakeOs(t, () => [200, { sidecars: [] }]);
  const saved = { ...process.env };
  t.after(() => { process.env = saved; });
  delete process.env.OS_API_BASE; delete process.env.APP_INSTANCE_ID;
  process.env.AURA_OS_URL = os.base;
  process.env.AURA_INSTANCE_ID = 'parent.app';
  process.env.AURA_INSTANCE_TOKEN = 'sidecar-token';
  const sc = osSidecars();
  assert.equal(sc.instanceId, 'parent.app');
  await sc.list();
  assert.equal(os.seen[0].url, '/api/instances/parent.app/sidecars?view=managed');
  assert.equal(os.seen[0].auth, 'Bearer sidecar-token');

  delete process.env.AURA_INSTANCE_TOKEN;
  await assert.rejects(osSidecars().list(), /no AURA_INSTANCE_TOKEN/);
  delete process.env.AURA_OS_URL;
  assert.throws(() => osSidecars(), /no OS API base/);
});

test("createSidecars({ mode: 'os' }) spawns templates through the OS, never docker", async (t) => {
  const os = await fakeOs(t, ({ method, url }) => {
    if (method === 'POST') return [201, { ok: true, created: true, sidecar: sidecar('db') }];
    if (method === 'GET' && url.endsWith('/sidecars/db')) return [200, { sidecar: sidecar('db') }];
    return [200, { ok: true }];
  });
  const saved = { ...process.env };
  t.after(() => { process.env = saved; });
  process.env.OS_API_BASE = os.base;
  process.env.AURA_INSTANCE_TOKEN = 'tok';
  const host = createSidecars({ appId: 'a.b', instanceId: 'a.b-2', appPort: 4001, mode: 'os',
    services: [{ name: 'db', image: 'postgres:17' }], log: () => {} });
  assert.equal(host.mode, 'os');
  await host.ensureAll();
  assert.equal(await host.isRunning('db'), true);
  await host.teardownAll();
  assert.deepEqual(os.seen.map((r) => `${r.method} ${r.url}`), [
    'POST /api/instances/a.b-2/sidecars',
    'GET /api/instances/a.b-2/sidecars/db',
    'DELETE /api/instances/a.b-2/sidecars/db',
  ]);
  assert.deepEqual(os.seen[0].body, { template: 'db', takeover: true }, 'takes over its own docker-mode container');
  assert.throws(() => createSidecars({ appId: 'a.b', instanceId: 'a.b-2', appPort: 1, mode: 'os', services: [], onSeed() {} }), /onSeed is not available/);
});

test("mode 'auto' picks os only without a docker socket and with a token", (t) => {
  const saved = { ...process.env };
  t.after(() => { process.env = saved; });
  process.env.AURA_INSTANCE_TOKEN = 'tok';
  const host = createSidecars({ appId: 'a.b', instanceId: 'a.b-2', appPort: 1, mode: 'auto', services: [] });
  // The test runs where /var/run/docker.sock may or may not exist — assert the rule, not the host.
  const fs = process.getBuiltinModule('node:fs');
  assert.equal(host.mode, fs.existsSync('/var/run/docker.sock') ? 'docker' : 'os');
  delete process.env.AURA_INSTANCE_TOKEN;
  assert.equal(createSidecars({ appId: 'a.b', instanceId: 'a.b-2', appPort: 1, mode: 'auto', services: [] }).mode, 'docker');
  assert.equal(createSidecars({ appId: 'a.b', instanceId: 'a.b-2', appPort: 1, services: [] }).mode, 'docker', 'default stays docker');
});

test("mode 'os' waits for a template's readiness", async (t) => {
  const os = await fakeOs(t, () => [201, { ok: true, created: true, sidecar: sidecar('web') }]);
  const saved = { ...process.env };
  t.after(() => { process.env = saved; });
  process.env.OS_API_BASE = os.base;
  process.env.AURA_INSTANCE_TOKEN = 'tok';
  const host = createSidecars({ appId: 'a.b', instanceId: 'a.b-2', appPort: 1, mode: 'os', log: () => {},
    services: [{ name: 'web', image: 'nginx', port: 80, readiness: { path: '/health' } }] });
  await host.ensureAll();
  assert.deepEqual(os.seen[0].body, { template: 'web', takeover: true, wait: { ready: true } });
  assert.equal(host.phase, 'ready');
});
