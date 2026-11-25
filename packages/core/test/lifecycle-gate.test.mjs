// The lifecycle token and the health identity check, kernel side (Phase 3b
// F0a): the shared identity classes and modes, the runtime check of the
// health guard, the PRoot destination binding (the listener belongs to the
// spawned process tree), the container address binding, and ProotRunner
// end to end against the REAL registry server (apps/com.aura.registry/server.js,
// copied to a temp dir so no command line names the app dir).
//
//   pnpm --filter @aura/core build && node --test test/lifecycle-gate.test.mjs
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  KNOWN_LEGACY_HEALTH_APPS, checkHealthGuard, classifyHealthIdentity, healthIdentityRefusal, lifecycleHeaders,
  lifecycleStatusRefusal, lifecycleStrictMode, newLifecycleToken, resetLifecycleStrictModeForTests,
} from '../dist/app-manager/lifecycleGate.js';
import { ProotRunner, listenerOwnership } from '../dist/app-manager/ProotRunner.js';
import { inspectSpawned } from '../dist/app-manager/ContainerRunner.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REGISTRY_SERVER = join(HERE, '../../../apps/com.aura.registry/server.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const savedMode = process.env.AURA_LIFECYCLE_STRICT;
afterEach(() => {
  if (savedMode === undefined) delete process.env.AURA_LIFECYCLE_STRICT; else process.env.AURA_LIFECYCLE_STRICT = savedMode;
  resetLifecycleStrictModeForTests();
});

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}
const close = (server) => new Promise((r) => server.close(r));
function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

// ── identity classes and modes ──────────────────────────────────────────────

test('classifyHealthIdentity: match, legacy, partial, mismatch', () => {
  const c = (body) => classifyHealthIdentity(typeof body === 'string' ? body : JSON.stringify(body), 'com.x', 'com.x-1').kind;
  assert.equal(c({ ok: true, appId: 'com.x', instanceId: 'com.x-1' }), 'match');
  assert.equal(c({ ok: true }), 'legacy');
  assert.equal(c('OK'), 'legacy', 'a body that is not JSON carries no identity');
  assert.equal(c('null'), 'legacy');
  assert.equal(c({ ok: true, appId: 'com.x' }), 'partial');
  assert.equal(c({ ok: true, instanceId: 'com.x-1' }), 'partial');
  assert.equal(c({ ok: true, appId: 'com.x', instanceId: 'com.x-2' }), 'mismatch');
  assert.equal(c({ ok: true, appId: 'com.y', instanceId: 'com.x-1' }), 'mismatch');
});

test('healthIdentityRefusal: partial and mismatch fail in every mode; legacy only for a known legacy app in warn', () => {
  const id = (kind, a = null, i = null) => ({ kind, claimedApp: a, claimedInstance: i });
  for (const mode of ['warn', 'strict']) {
    assert.equal(healthIdentityRefusal(id('match', 'com.x', 'com.x-1'), 'com.x', 'com.x-1', mode), null);
    assert.match(healthIdentityRefusal(id('partial', 'com.x'), 'com.x', 'com.x-1', mode), /mismatch/);
    assert.match(healthIdentityRefusal(id('mismatch', 'com.y', 'com.y'), 'com.x', 'com.x-1', mode), /mismatch/);
    assert.match(healthIdentityRefusal(id('legacy'), 'com.x', 'com.x-1', mode), /identity missing/);
  }
  // The verified list is empty: no installed app answers without identity.
  assert.equal(KNOWN_LEGACY_HEALTH_APPS.size, 0);
});

test('lifecycleStrictMode: warn by default, strict on request, anything else warns', () => {
  delete process.env.AURA_LIFECYCLE_STRICT; resetLifecycleStrictModeForTests();
  assert.equal(lifecycleStrictMode(), 'warn');
  process.env.AURA_LIFECYCLE_STRICT = 'strict'; resetLifecycleStrictModeForTests();
  assert.equal(lifecycleStrictMode(), 'strict');
  process.env.AURA_LIFECYCLE_STRICT = 'enforce'; resetLifecycleStrictModeForTests();
  assert.equal(lifecycleStrictMode(), 'warn');
});

test('lifecycleStatusRefusal: strict needs identity and a 401; warn admits and reports', () => {
  const good = { identity: 'match', guard: '401' };
  for (const mode of ['warn', 'strict']) assert.equal(lifecycleStatusRefusal('i', good, mode), null);
  for (const guard of ['accepted-wrong-token', 'inconclusive']) {
    assert.equal(lifecycleStatusRefusal('i', { identity: 'match', guard }, 'warn'), null);
    assert.match(lifecycleStatusRefusal('i', { identity: 'match', guard }, 'strict'), /strict/);
  }
  assert.match(lifecycleStatusRefusal('i', { identity: 'legacy', guard: '401' }, 'strict'), /no identity/);
});

test('newLifecycleToken / lifecycleHeaders', () => {
  const a = newLifecycleToken();
  assert.ok(a.length >= 40 && a !== newLifecycleToken());
  assert.deepEqual(lifecycleHeaders(a, { 'x-aura-stop-reason': 'user' }), { 'x-aura-lifecycle': a, 'x-aura-stop-reason': 'user' });
  assert.deepEqual(lifecycleHeaders(undefined), {}, 'no token, no header (adopted pre-token container)');
});

// ── runtime check of the health endpoint ────────────────────────────────────

test('checkHealthGuard: 401, accepted-wrong-token, inconclusive', async () => {
  const seen = [];
  const cases = [
    [(req, res) => { seen.push(req.headers['x-aura-lifecycle']); res.writeHead(401).end(); }, '401'],
    [(_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'), 'accepted-wrong-token'],
    [(_req, res) => res.writeHead(503).end(), 'inconclusive'],
    [(_req, res) => res.writeHead(404).end(), 'inconclusive'],
    [() => { /* never answers */ }, 'inconclusive'],
  ];
  for (const [handler, want] of cases) {
    const { server, port } = await listen(handler);
    try {
      assert.equal(await checkHealthGuard(`http://127.0.0.1:${port}/api/lifecycle/health`, 300), want);
    } finally { server.closeAllConnections(); await close(server); }
  }
  assert.match(seen[0], /^wrong-/, 'the check sends a token that cannot be right');
  assert.equal(await checkHealthGuard(`http://127.0.0.1:${await freePort()}/api/lifecycle/health`, 300), 'inconclusive');
});

// ── destination binding ─────────────────────────────────────────────────────

test('listenerOwnership: none, own (incl. a grandchild), foreign, unknown', async () => {
  const port = await freePort();
  // A detached child (like the runner's spawn) whose GRANDCHILD listens.
  const child = spawn('bash', ['-c', `node -e "require('http').createServer((q,s)=>s.end('x')).listen(${port},'127.0.0.1')" & wait`], { detached: true, stdio: 'ignore' });
  try {
    assert.equal(listenerOwnership(port, child.pid), 'none');
    for (let i = 0; i < 100 && listenerOwnership(port, child.pid) === 'none'; i++) await sleep(50);
    assert.equal(listenerOwnership(port, child.pid), 'own');
    // The same listener seen from an unrelated tree is foreign.
    const other = spawn('sleep', ['5'], { detached: true, stdio: 'ignore' });
    try { assert.equal(listenerOwnership(port, other.pid), 'foreign'); } finally { other.kill('SIGKILL'); }
    assert.equal(listenerOwnership(port, undefined), 'unknown');
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
  }
  // A listener of the test process, checked against an unrelated tree root.
  const { server, port: p2 } = await listen((_q, s) => s.end());
  const other = spawn('sleep', ['5'], { detached: true, stdio: 'ignore' });
  try {
    assert.equal(listenerOwnership(p2, other.pid), 'foreign');
    assert.equal(listenerOwnership(p2, process.pid), 'own');
  } finally { other.kill('SIGKILL'); await close(server); }
});

test('inspectSpawned binds to the created container: its pid and its own address on the shared network', () => {
  const calls = [];
  const ok = inspectSpawned('abc123', (args) => { calls.push(args); return '4242 {"aura-net":{"IPAddress":"172.18.0.9"},"other":{"IPAddress":"10.1.1.1"}}\n'; });
  assert.deepEqual(ok, { pid: 4242, address: '172.18.0.9' });
  assert.equal(calls[0].at(-1), 'abc123', 'inspected by the id docker run returned, not the name');
  assert.deepEqual(inspectSpawned('x', () => '7 {"bridge":{"IPAddress":"172.17.0.2"}}'), { pid: 7, address: null });
  assert.deepEqual(inspectSpawned('x', () => '7 {"aura-net":{"IPAddress":""}}'), { pid: 7, address: null });
  assert.deepEqual(inspectSpawned('x', () => { throw new Error('gone'); }), { pid: 0, address: null });
});

// ── ProotRunner end to end (not prooted: AURA_USE_PROOT is unset in tests) ──

function makeRunner() {
  const dataDir = mkdtempSync(join(tmpdir(), 'lc-data-'));
  const runner = new ProotRunner({ baseRootfs: '/nonexistent', toolchainDir: dataDir, appsDir: dataDir, dataDir, osApiBase: 'http://127.0.0.1:9' });
  // No Valkey in tests: an empty OS Context and no shared volumes.
  runner.contextStore = { ensureDir() {}, resolveEnv: async () => ({}) };
  runner.volumeStore = { ensureAll: async () => {}, resolveMounts: async () => [] };
  return { runner, dataDir };
}

/** An app dir whose entrypoint runs `server` (a file name in the dir). */
function appDir(files, entry) {
  const dir = mkdtempSync(join(tmpdir(), 'lc-app-'));
  for (const [name, src] of Object.entries(files)) {
    if (src.copyFrom) copyFileSync(src.copyFrom, join(dir, name)); else writeFileSync(join(dir, name), src);
  }
  writeFileSync(join(dir, 'entrypoint.sh'), `exec ${entry}\n`);
  return dir;
}

const manifestFor = (id) => ({ id, entrypoint: 'entrypoint.sh', runtime: 'astro', tools: [], instanceMode: 'single' });

async function spawnApp(runner, dir, appId, port) {
  return runner.spawn(appId, appId, port, manifestFor(appId), { appDir: dir, instanceDataDir: dir });
}

test('ProotRunner + the real registry server: token sent, guard proven, outsiders get 401', async () => {
  const { runner, dataDir } = makeRunner();
  const dir = appDir({ 'server.js': { copyFrom: REGISTRY_SERVER } }, 'node ./server.js');
  const port = await freePort();
  const id = 'com.aura.registry';
  try {
    await spawnApp(runner, dir, id, port);
    assert.deepEqual(runner.lifecycleStatus(id), { identity: 'match', guard: '401' });
    // The kernel's own calls carry the token (and the stop reason).
    await runner.callLifecycle(id, 'onStart');
    await runner.callLifecycle(id, 'onStop', { reason: 'user' });
    // Anyone else: no token or a wrong one → 401; health without token still answers.
    const base = `http://127.0.0.1:${port}/api/lifecycle`;
    assert.equal((await fetch(`${base}/onDestroy`, { method: 'POST' })).status, 401);
    assert.equal((await fetch(`${base}/onDestroy`, { method: 'POST', headers: { 'x-aura-lifecycle': 'nope' } })).status, 401);
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/health`, { headers: { 'x-aura-lifecycle': 'nope' } })).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${port}/API/Lifecycle/%6FnDestroy`, { method: 'POST' })).status, 401);
  } finally {
    runner.forceKill(id);
    rmSync(dir, { recursive: true, force: true }); rmSync(dataDir, { recursive: true, force: true });
  }
});

test('ProotRunner refuses to send the token to a port someone else listens on', async () => {
  const { runner, dataDir } = makeRunner();
  let reached = 0;
  const { server, port } = await listen((req, res) => { if (req.headers['x-aura-lifecycle']) reached++; res.end('{}'); });
  const dir = appDir({}, 'sleep 30');
  try {
    await assert.rejects(spawnApp(runner, dir, 'com.x.squat', port), /does not belong to the spawned process tree/);
    assert.equal(reached, 0, 'the squatter never saw a lifecycle token');
    assert.equal(runner.isRunning('com.x.squat'), false);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true }); rmSync(dataDir, { recursive: true, force: true });
  }
});

/** A health responder: `body` for health, 200 for any hook, no guard (an old SDK). */
const unguarded = (body) => `require('http').createServer((q,s)=>{s.setHeader('content-type','application/json');`
  + `s.end(q.url.startsWith('/api/lifecycle/health')?JSON.stringify(${JSON.stringify(body)}):'{"ok":true}')}).listen(+process.env.APP_PORT,'127.0.0.1')`;

test('ProotRunner modes: an unguarded app passes warn (reported) and fails strict', async () => {
  for (const mode of ['warn', 'strict']) {
    process.env.AURA_LIFECYCLE_STRICT = mode; resetLifecycleStrictModeForTests();
    const { runner, dataDir } = makeRunner();
    const id = `com.x.old-${mode}`;
    const dir = appDir({ 'server.js': unguarded({ ok: true, appId: id, instanceId: id }) }, 'node ./server.js');
    try {
      const p = spawnApp(runner, dir, id, await freePort());
      if (mode === 'warn') {
        await p;
        assert.deepEqual(runner.lifecycleStatus(id), { identity: 'match', guard: 'accepted-wrong-token' });
      } else {
        await assert.rejects(p, /does not check the lifecycle token/);
        assert.equal(runner.isRunning(id), false);
      }
    } finally {
      runner.forceKill(id);
      rmSync(dir, { recursive: true, force: true }); rmSync(dataDir, { recursive: true, force: true });
    }
  }
});

test('ProotRunner: legacy and partial health identity fail in warn mode too', async () => {
  for (const [what, body, want] of [
    ['legacy', { ok: true }, /identity missing/],
    ['partial', { ok: true, appId: 'com.x.part' }, /identity mismatch/],
  ]) {
    const { runner, dataDir } = makeRunner();
    const id = `com.x.${what}`;
    const dir = appDir({ 'server.js': unguarded(what === 'partial' ? { ok: true, appId: id } : body) }, 'node ./server.js');
    try {
      await assert.rejects(spawnApp(runner, dir, id, await freePort()), want);
    } finally {
      runner.forceKill(id);
      rmSync(dir, { recursive: true, force: true }); rmSync(dataDir, { recursive: true, force: true });
    }
  }
});
