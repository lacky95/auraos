// Phase 6 stream M (D108 A3; contract app-manager/maintenance.ts): the maintenance start and the instance update.
//   - runInstanceUpdate (instanceUpdate.ts) over fake ports: drain → switch → maintenance start → onUpdate → serve,
//     the hook skipped when the versions are equal, rollback and the old code back on every failure, live sessions
//     (keepRunningOnBuild, a session host) never drained (onUpdate at their next start), a stopped app only switched;
//   - the maintenance hook call (lifecycleClient.callMaintenanceHook): 404 → null, failure and timeout throw, the
//     token and `x-aura-maintenance` sent; through both runners: ProotRunner against a real process (its listener
//     proven), ContainerRunner over its bound address;
//   - AppManager.startMaintenance refusals (D105 bodies): reason `setup` until 7c P3, an unknown app.
//
// Run via: node tools/run-tests.mjs --only=core
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInstanceUpdate, UPDATE_HOOK_TIMEOUT_MS } from '../dist/app-manager/instanceUpdate.js';
import { callMaintenanceHook } from '../dist/app-manager/lifecycleClient.js';
import { newLifecycleToken } from '../dist/app-manager/lifecycleGate.js';
import { ProotRunner } from '../dist/app-manager/ProotRunner.js';
import { ContainerRunner } from '../dist/app-manager/ContainerRunner.js';
import { AppManager } from '../dist/app-manager/AppManager.js';

const TRAITS = { name: '[Test]', bootBudgetMs: 1_000, probeTimeoutMs: 500 };

/** Fake ports recording what happened, in order. */
function ports({ running = [{ instanceId: 'a-1', owner: 'u1' }], keeps = false, start = 'ok', hook = 'ok', serve = 'ok', switchFails = false } = {}) {
  const log = [];
  const deps = {
    running: () => running,
    keepsRunning: () => keeps,
    drain: async (id) => { log.push(`drain ${id}`); },
    startMaintenance: async (id, o) => {
      log.push(`maintenance ${id} ${o.reason} ${o.fromVersion}->${o.toVersion} ${o.userId ?? '-'}`);
      if (start !== 'ok') return { ok: false, error: { error: 'contract-unsupported', category: 'unsupported-operation', message: 'blocked' } };
      return { ok: true, session: {
        instanceId: 'a-2', appId: id, reason: 'update', startedAt: 0,
        callHook: async (h, b) => { log.push(`hook ${h} ${JSON.stringify(b)}`); if (hook !== 'ok') throw new Error('migration failed'); return null; },
        finish: async (outcome) => { log.push(`finish ${outcome}`); if (outcome === 'serve' && serve !== 'ok') throw new Error('onStart 500'); },
      } };
    },
    start: async (id, user) => { log.push(`start ${id} ${user ?? '-'}`); return 'a-3'; },
    markPending: (id, f, t) => log.push(`pending ${id} ${f}->${t}`),
  };
  const opts = (from = '1.0.0', to = '1.1.0') => ({
    fromVersion: from, toVersion: to,
    switchCode: async () => { log.push('switch'); if (switchFails) throw new Error('disk full'); },
    rollback: async () => { log.push('rollback'); },
  });
  return { deps, opts, log };
}

test('update: drain → switch → maintenance start → onUpdate {from,to} → serve; the default hook timeout is 120 s', async () => {
  const p = ports();
  const out = await runInstanceUpdate(p.deps, 'org.a', p.opts());
  assert.deepEqual(out, { ok: true, instanceId: 'a-2', hookCalled: true });
  assert.deepEqual(p.log, ['drain org.a', 'switch', 'maintenance org.a update 1.0.0->1.1.0 u1', 'hook onUpdate {"fromVersion":"1.0.0","toVersion":"1.1.0"}', 'finish serve']);
  assert.equal(UPDATE_HOOK_TIMEOUT_MS, 120_000);
});

test('update: equal versions start the new code without onUpdate', async () => {
  const p = ports();
  const out = await runInstanceUpdate(p.deps, 'org.a', p.opts('1.0.0', '1.0.0'));
  assert.deepEqual(out, { ok: true, instanceId: 'a-2', hookCalled: false });
  assert.ok(!p.log.some((l) => l.startsWith('hook')));
});

test('update: onUpdate fails → the new code stops, the previous tree is back, the old code starts again', async () => {
  const p = ports({ hook: 'fail' });
  const out = await runInstanceUpdate(p.deps, 'org.a', p.opts());
  assert.equal(out.ok, false);
  assert.equal(out.rolledBack, true);
  assert.equal(out.error.error, 'update-hook-failed');
  assert.match(out.error.message, /onUpdate \(1\.0\.0 → 1\.1\.0\) failed: migration failed/);
  assert.equal(typeof out.error.hint, 'string');
  assert.deepEqual(p.log.slice(-4), ['hook onUpdate {"fromVersion":"1.0.0","toVersion":"1.1.0"}', 'finish stop', 'rollback', 'start org.a u1']);
});

test('update: a refused maintenance start (the D108 gate) → rollback, the refusal body as the outcome', async () => {
  const p = ports({ start: 'refused' });
  const out = await runInstanceUpdate(p.deps, 'org.a', p.opts());
  assert.deepEqual([out.ok, out.rolledBack, out.error.error], [false, true, 'contract-unsupported']);
  assert.deepEqual(p.log.slice(-2), ['rollback', 'start org.a u1']);
});

test('update: the switch fails → nothing changed, the old code starts again (no rollback needed)', async () => {
  const p = ports({ switchFails: true });
  const out = await runInstanceUpdate(p.deps, 'org.a', p.opts());
  assert.deepEqual([out.ok, out.rolledBack], [false, true]);
  assert.deepEqual(p.log, ['drain org.a', 'switch', 'start org.a u1']);
});

test('update: without a rollback the outcome says the old code is not back', async () => {
  const p = ports({ hook: 'fail' });
  const { rollback: _r, ...noRollback } = p.opts();
  const out = await runInstanceUpdate(p.deps, 'org.a', noRollback);
  assert.deepEqual([out.ok, out.rolledBack], [false, false]);
  assert.ok(!p.log.includes('start org.a u1'), 'the old code is not started on the new tree');
});

test('update: live sessions (keepRunningOnBuild, a session host) are never drained: switched, onUpdate pending', async () => {
  const p = ports({ keeps: true });
  const out = await runInstanceUpdate(p.deps, 'org.term', p.opts());
  assert.deepEqual(out, { ok: true, instanceId: 'a-1', hookCalled: false });
  assert.deepEqual(p.log, ['switch', 'pending org.term 1.0.0->1.1.0']);
});

test('update: a stopped app is only switched; its next start runs onUpdate', async () => {
  const p = ports({ running: [] });
  const out = await runInstanceUpdate(p.deps, 'org.a', p.opts());
  assert.deepEqual(out, { ok: true, instanceId: null, hookCalled: false });
  assert.deepEqual(p.log, ['switch', 'pending org.a 1.0.0->1.1.0']);
});

test('update: every other user who ran it gets their instance back on the new code', async () => {
  const p = ports({ running: [{ instanceId: 'a-1', owner: 'u1' }, { instanceId: 'a-4', owner: 'u2' }] });
  await runInstanceUpdate(p.deps, 'org.a', p.opts());
  assert.deepEqual(p.log.slice(-2), ['finish serve', 'start org.a u2']);
});

// ── the hook call ────────────────────────────────────────────────────────────

async function server(handler) {
  const seen = [];
  const s = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => { seen.push({ url: req.url, headers: req.headers, body }); handler(req, res, body); });
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { port: s.address().port, seen, close: () => new Promise((r) => s.close(r)) };
}

test('callMaintenanceHook: JSON answer; 404 → null; non-2xx and timeout throw; token and x-aura-maintenance sent', async () => {
  const s = await server((req, res) => {
    if (req.url.endsWith('/onUpdate')) { res.end('{"migrated":2}'); return; }
    if (req.url.endsWith('/onSetup')) { res.statusCode = 404; res.end(); return; }
    if (req.url.endsWith('/onValidate')) { res.statusCode = 500; res.end('{"ok":false,"error":"bad"}'); return; }
    // onMigrateConfig: never answers in time
  });
  const dest = { host: '127.0.0.1', port: s.port, token: 'tok', unbound: () => null };
  try {
    assert.deepEqual(await callMaintenanceHook(TRAITS, 'a-1', dest, 'onUpdate', { fromVersion: '1', toVersion: '2' }, { timeoutMs: 2000, reason: 'update' }), { migrated: 2 });
    assert.equal(s.seen[0].headers['x-aura-lifecycle'], 'tok');
    assert.equal(s.seen[0].headers['x-aura-maintenance'], 'update');
    assert.equal(s.seen[0].body, '{"fromVersion":"1","toVersion":"2"}');
    assert.equal(await callMaintenanceHook(TRAITS, 'a-1', dest, 'onSetup', {}, { timeoutMs: 2000, reason: 'update' }), null, 'an absent hook is not an error');
    await assert.rejects(callMaintenanceHook(TRAITS, 'a-1', dest, 'onValidate', {}, { timeoutMs: 2000, reason: 'update' }), /onValidate returned 500/);
    await assert.rejects(callMaintenanceHook(TRAITS, 'a-1', dest, 'onMigrateConfig', {}, { timeoutMs: 300, reason: 'update' }));
    await assert.rejects(callMaintenanceHook(TRAITS, 'a-1', null, 'onUpdate', {}, { timeoutMs: 300, reason: 'update' }), /is not running; onUpdate not sent/);
    await assert.rejects(callMaintenanceHook(TRAITS, 'a-1', { ...dest, unbound: () => 'foreign listener' }, 'onUpdate', {}, { timeoutMs: 300, reason: 'update' }), /not sent/);
  } finally { await s.close(); }
});

const APP_SERVER = `
const http = require('http');
const port = Number(process.env.APP_PORT), token = process.env.AURA_LIFECYCLE_TOKEN;
http.createServer((req, res) => {
  if (req.url === '/api/lifecycle/health') { res.end(JSON.stringify({ ok: true, appId: process.env.APP_ID, instanceId: process.env.APP_INSTANCE_ID })); return; }
  if (req.headers['x-aura-lifecycle'] !== token) { res.statusCode = 401; res.end('{}'); return; }
  if (req.url === '/api/lifecycle/onUpdate') {
    let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => res.end(JSON.stringify({ got: JSON.parse(b), reason: req.headers['x-aura-maintenance'] })));
    return;
  }
  res.statusCode = 404; res.end();
}).listen(port, '127.0.0.1');
`;
const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

test('fixture, PRoot: the maintenance hook reaches the real process with its token (listener proven); an absent hook → null', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mt-data-'));
  const dir = mkdtempSync(join(tmpdir(), 'mt-app-'));
  writeFileSync(join(dir, 'server.js'), APP_SERVER);
  writeFileSync(join(dir, 'entrypoint.sh'), 'exec node ./server.js\n');
  const runner = new ProotRunner({ baseRootfs: '/nonexistent', toolchainDir: dataDir, appsDir: dataDir, dataDir, osApiBase: 'http://127.0.0.1:9' });
  runner.volumeStore = { ensureAll: async () => {}, resolveMounts: async () => [] };
  const id = 'org.mt.app';
  const port = await freePort();
  const env = { ...process.env, APP_ID: id, APP_INSTANCE_ID: id, APP_PORT: String(port), AURA_SERVE: 'dev', AURA_LIFECYCLE_TOKEN: newLifecycleToken() };
  try {
    await runner.startProcess(id, id, port, { command: 'bash', prefix: [], env, appDir: dir }, [join(dir, 'entrypoint.sh')]);
    assert.deepEqual(await runner.callMaintenanceHook(id, 'onUpdate', { fromVersion: '1', toVersion: '2' }, { timeoutMs: 5000, reason: 'update' }),
      { got: { fromVersion: '1', toVersion: '2' }, reason: 'update' });
    assert.equal(await runner.callMaintenanceHook(id, 'onSetup', {}, { timeoutMs: 5000, reason: 'update' }), null);
    await assert.rejects(runner.callMaintenanceHook('org.mt.gone', 'onUpdate', {}, { timeoutMs: 500, reason: 'update' }), /is not running/);
  } finally {
    runner.forceKill(id);
    rmSync(dir, { recursive: true, force: true }); rmSync(dataDir, { recursive: true, force: true });
  }
});

test('fixture, container: the maintenance hook goes to the address bound at spawn, with the token', async () => {
  const s = await server((req, res) => res.end(JSON.stringify({ reason: req.headers['x-aura-maintenance'] })));
  const dataDir = mkdtempSync(join(tmpdir(), 'mt-c-'));
  try {
    const runner = new ContainerRunner({ baseRootfs: '/nonexistent', toolchainDir: dataDir, appsDir: dataDir, dataDir, osApiBase: 'http://127.0.0.1:9' });
    await assert.rejects(runner.callMaintenanceHook('org.mt.none', 'onUpdate', {}, { timeoutMs: 500, reason: 'update' }), /is not running/);
    // A tracked container (what spawn records): only its bound address and this start's token are used.
    runner.containers.set('org.mt.c', { address: '127.0.0.1', hostname: 'aura-org.mt.c', port: s.port, lifecycleToken: 'ctok' });
    assert.deepEqual(await runner.callMaintenanceHook('org.mt.c', 'onUpdate', {}, { timeoutMs: 2000, reason: 'update' }), { reason: 'update' });
    assert.equal(s.seen[0].headers['x-aura-lifecycle'], 'ctok');
  } finally { await s.close(); rmSync(dataDir, { recursive: true, force: true }); }
});

// ── AppManager.startMaintenance refusals ─────────────────────────────────────

test('startMaintenance: reason setup is refused until the setup engine (7c P3); an unknown app is not-found (D105 bodies)', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mt-mgr-'));
  const mgr = new AppManager({ appsDir: join(dataDir, 'apps'), dataDir, baseRootfs: join(dataDir, 'rootfs'), toolchainDir: join(dataDir, 'tc') });
  const setup = await mgr.startMaintenance('org.mt.app', { reason: 'setup' });
  assert.deepEqual([setup.ok, setup.error.error, setup.error.category], [false, 'maintenance-unavailable', 'unsupported-operation']);
  const unknown = await mgr.startMaintenance('org.mt.none', { reason: 'update' });
  assert.deepEqual([unknown.ok, unknown.error.error, unknown.error.category], [false, 'not-found', 'not-found']);
});
