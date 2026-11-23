/**
 * Self-tests for the safety model. They use a stub fetch or a fake shell on
 * loopback and never contact a real AuraOS.
 *
 *   node --test tools/smoke/test/*.test.mjs
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { ALLOWED_LIVE_REQUESTS, createGuard } from '../lib/guard.mjs';
import { GuardViolation, createClient, normalizeTarget, startGuardProxy } from '../lib/http.mjs';
import { ALLOWED_CLI_COMMANDS, TEST_INSTANCE_WORKFLOWS, diffSnapshots, runSmoke } from '../lib/checks.mjs';

const CANARY = 'CANARY-SECRET-VALUE';

const appsFixture = () => [
  {
    manifest: { id: 'com.aura.terminal', permissions: ['apps.mount', 'apps.port'] },
    instances: [
      { instanceId: 'com.aura.terminal-2', appId: 'com.aura.terminal', state: 'resumed', inPool: false, sidecarCount: 1 },
      { instanceId: 'com.aura.terminal-3', appId: 'com.aura.terminal', state: 'resumed', inPool: true, sidecarCount: 0 },
    ],
    activities: [{ activityId: 'com.aura.terminal#a1', title: CANARY }],
  },
  {
    manifest: { id: 'io.lakner.terminalx', permissions: [] },
    instances: [{ instanceId: 'io.lakner.terminalx', appId: 'io.lakner.terminalx', state: 'resumed', sandbox: 'proot', sidecarCount: 0 }],
    activities: [],
  },
  { manifest: { id: 'io.lakner.trilium' }, instances: [{ instanceId: 'io.lakner.trilium-1', appId: 'io.lakner.trilium', state: 'stopped' }], activities: [] },
  // An instance whose id equals its app id must never be proxied.
  { manifest: { id: 'com.aura.settings' }, instances: [{ instanceId: 'com.aura.settings', appId: 'com.aura.settings', state: 'resumed' }], activities: [] },
];

const admittedGuard = () => {
  const guard = createGuard();
  guard.admit(appsFixture());
  return guard;
};

const FORBIDDEN_PATHS = [
  '/api/admin/self-update',
  '/api/admin/cap-doctor',
  '/api/nexus',
  '/api/nexus?refresh=1',
  '/api/nexus/status',
  '/api/nexus/search',
  '/api/nexus/search?q=x',
  '/api/sessions/screen',
  '/api/proxy/com.aura.terminal-2/api/sessions/screen',
  '/api/proxy/com.aura.terminal-2/ws',
  '/api/proxy/com.aura.terminal-2/mcp/terminal',
  '/api/proxy/com.aura.terminal/api/sessions',   // bare app id can cold-start
  '/api/proxy/com.aura.terminal-3/api/sessions', // pool member
  '/api/proxy/com.aura.settings/api/sessions',
  '/api/proxy/io.lakner.trilium/',
  '/api/proxy/io.lakner.trilium-1/api/sessions',
  '/api/proxy/io.lakner.improvementboard/',
  '/api/apps/events',
  '/api/apps/serve',
  '/api/instances/io.lakner.trilium-1/mounts',   // not running
  '/api/instances/com.aura.terminal-3/ports',    // pool member
  '/api/instances/com.aura.terminal-2/sidecars', // missing usage=0 runs docker stats
  '/api/instances/com.aura.terminal-2/sidecars?usage=1',
  '/api/apps?x=1',
  '/api/apps/',
  '/api/apps/../admin/self-update',
  '/api/%61dmin/self-update',
  '/api/proxy/com.aura.terminal-2%2Fws/api/sessions',
  '//evil.example/api/apps',
  'http://evil.example/api/apps',
  '/api/apps#x',
  '/api/apps\n',
];

test('forbidden paths are refused with no network call', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return new Response('{}'); };
  const client = createClient({ target: 'http://127.0.0.1:9', guard: admittedGuard(), fetchImpl });
  for (const path of FORBIDDEN_PATHS) {
    await assert.rejects(client.request('GET', path), GuardViolation, path);
  }
  assert.equal(calls, 0);
});

test('non-GET methods are refused with no network call, even on allowed paths', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return new Response('{}'); };
  const client = createClient({ target: 'http://127.0.0.1:9', guard: admittedGuard(), fetchImpl });
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'CONNECT', 'TRACE', 'get']) {
    await assert.rejects(client.request(method, '/api/apps'), GuardViolation, method);
  }
  assert.equal(calls, 0);
});

test('every allowlist entry is admitted once ids are discovered', () => {
  const guard = admittedGuard();
  for (const e of ALLOWED_LIVE_REQUESTS) {
    const path = e.path ?? e.template
      .replace('{runningTerminal}', 'com.aura.terminal-2')
      .replace('{runningInstance}', 'com.aura.terminal-2');
    assert.deepEqual(guard.check(e.method, path), { ok: true }, path);
  }
});

test('template paths are refused before discovery', () => {
  const guard = createGuard();
  assert.equal(guard.check('GET', '/api/proxy/com.aura.terminal-2/api/sessions').ok, false);
  assert.equal(guard.check('GET', '/api/instances/com.aura.terminal-2/mounts').ok, false);
});

test('the allowlist holds only GETs', () => {
  assert.ok(ALLOWED_LIVE_REQUESTS.every((e) => e.method === 'GET'));
});

test('the CLI allowlist holds only read-only verbs', () => {
  assert.ok(ALLOWED_CLI_COMMANDS.every((c) => c[0] === 'status' || c[0] === 'get'));
});

test('redirects are not followed', async () => {
  let seen;
  const fetchImpl = async (_url, init) => { seen = init; return new Response(null, { status: 307, headers: { location: '/api/admin/self-update' } }); };
  const client = createClient({ target: 'http://127.0.0.1:9', guard: admittedGuard(), fetchImpl });
  const res = await client.getJson('/api/apps');
  assert.equal(seen.redirect, 'manual');
  assert.equal(res.status, 307);
  assert.equal(res.json, undefined);
});

test('requests carry no credentials', async () => {
  let seen;
  const fetchImpl = async (_url, init) => { seen = init; return new Response('[]'); };
  const client = createClient({ target: 'http://127.0.0.1:9', guard: admittedGuard(), fetchImpl });
  await client.getJson('/api/apps');
  assert.deepEqual(Object.keys(seen.headers), ['accept']);
});

test('the target must be a plain origin', () => {
  assert.equal(normalizeTarget('http://127.0.0.1:3000/'), 'http://127.0.0.1:3000');
  for (const bad of ['ftp://x', 'http://u:p@x', 'http://x/api', 'http://x/?a=1']) {
    assert.throws(() => normalizeTarget(bad), undefined, bad);
  }
});

test('the state diff reports instance and session changes', () => {
  const base = { instances: [{ id: 'a', state: 'resumed', inPool: false }], sessions: { t: ['s1'] } };
  assert.deepEqual(diffSnapshots(base, structuredClone(base)), []);
  const changed = { instances: [{ id: 'a', state: 'paused', inPool: false }, { id: 'b', state: 'resumed', inPool: false }], sessions: { t: ['s2'] } };
  const out = diffSnapshots(base, changed);
  assert.equal(out.length, 4);
});

/** A fake shell that records every request and puts a canary in sensitive fields. */
async function fakeShell(overrides = {}) {
  const hits = [];
  const routes = {
    '/api/os/about': { version: '1.2.3', git: { commit: 'abc1234' }, host: { hostname: CANARY } },
    '/api/apps': appsFixture(),
    '/api/apps/com.aura.terminal/instances': appsFixture()[0].instances,
    '/api/proxy/com.aura.terminal-2/api/sessions': { sessions: [{ id: 'com.aura.terminal-2#1', title: CANARY }], reserved: [CANARY] },
    '/api/interfaces?consumers=0': { interfaces: [
      { appId: 'com.aura.terminal', name: 'terminal', kind: 'http/mcp', status: 'live', description: CANARY },
      { appId: 'io.lakner.excalidraw', name: 'mcp', kind: 'http/mcp', status: 'live' },
    ], consumers: [] },
    '/api/flights': [],
    '/api/instances/io.lakner.terminalx/status': { instance: { instanceId: 'io.lakner.terminalx', sandbox: 'proot' }, health: { error: CANARY } },
    '/api/nexus/installed': [{ manifest: { id: 'com.aura.terminal', description: CANARY } }],
    '/api/notifications': { items: [{ title: CANARY, text: CANARY }] },
    '/api/hosts': { hosts: [] },
    '/api/instances/com.aura.terminal-2/sidecars?usage=0': { sidecars: [{ env: CANARY }] },
    '/api/instances/com.aura.terminal-2/mounts': { capable: true, mounts: [] },
    '/api/instances/com.aura.terminal-2/ports': { ports: [] },
    ...overrides,
  };
  const server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    const body = routes[req.url];
    if (body === undefined) { res.writeHead(404).end(`{"error":"${CANARY}"}`); return; }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, hits, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}

const NO_CLI = { findCli: async () => null };

test('full run passes, stays on the allowlist, and leaks no secrets', async () => {
  const shell = await fakeShell();
  try {
    const guard = createGuard();
    const client = createClient({ target: shell.url, guard });
    const report = await runSmoke({ client, guard, env: {}, deps: NO_CLI });
    assert.equal(report.summary.fail, 0, JSON.stringify(report.results.filter((x) => x.status === 'fail')));
    assert.ok(!JSON.stringify(report).includes(CANARY), 'report contains a canary value');
    const check = admittedGuard();
    for (const hit of shell.hits) {
      const [method, path] = hit.split(' ');
      assert.ok(check.check(method, path).ok, hit);
    }
    const skipped = report.results.filter((x) => x.tier === 'test-instance');
    assert.equal(skipped.length, TEST_INSTANCE_WORKFLOWS.length);
    assert.ok(skipped.every((x) => x.status === 'skip'));
  } finally {
    await shell.close();
  }
});

test('a broken response fails the run without leaking its body', async () => {
  const shell = await fakeShell({ '/api/flights': { error: CANARY } });
  try {
    const guard = createGuard();
    const client = createClient({ target: shell.url, guard });
    const report = await runSmoke({ client, guard, env: {}, deps: NO_CLI });
    assert.ok(report.results.some((x) => x.id === 'flights' && x.status === 'fail'));
    assert.ok(!JSON.stringify(report).includes(CANARY));
  } finally {
    await shell.close();
  }
});

test('the state guard fails when a session appears during the run', async () => {
  let calls = 0;
  const base = createGuard();
  const shell = await fakeShell();
  try {
    const inner = createClient({ target: shell.url, guard: base });
    const client = {
      ...inner,
      getJson: async (path) => {
        const res = await inner.getJson(path);
        if (path.endsWith('/api/sessions') && ++calls >= 3) res.json.sessions.push({ id: 'com.aura.terminal-2#new' });
        return res;
      },
    };
    const report = await runSmoke({ client, guard: base, env: {}, deps: NO_CLI });
    const state = report.results.find((x) => x.id === 'state-guard');
    assert.equal(state.status, 'fail');
    assert.match(state.detail, /session added/);
  } finally {
    await shell.close();
  }
});

test('the CLI proxy forwards allowed GETs and refuses the rest upstream-free', async () => {
  const shell = await fakeShell();
  const guard = admittedGuard();
  const proxy = await startGuardProxy(createClient({ target: shell.url, guard }));
  try {
    assert.equal((await fetch(`${proxy.url}/api/apps`)).status, 200);
    assert.equal((await fetch(`${proxy.url}/api/apps/serve`)).status, 403);
    assert.equal((await fetch(`${proxy.url}/api/apps`, { method: 'POST', body: '{}' })).status, 403);
    assert.deepEqual(shell.hits, ['GET /api/apps']);
    assert.deepEqual(proxy.refused.map((x) => `${x.method} ${x.path}`), ['GET /api/apps/serve', 'POST /api/apps']);
  } finally {
    await proxy.close();
    await shell.close();
  }
});
