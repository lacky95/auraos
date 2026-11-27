// D108 P3: the setup engine's gate at AppManager's choke point (spawnContext, startIntent,
// the supervisor skip), with a fake engine. Simple apps never reach the engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../dist/index.js';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupGateBlock } from '../dist/contract/types.js';

const base = { name: 'Notes', version: '1.0.0', auraContract: 1 };
const DIGEST = `sha256:${'a'.repeat(64)}`;

/** A fake engine: answers `decision` for declaring apps and records every call. */
function fakeEngine(decision) {
  const calls = [];
  return {
    calls,
    async check(appId, manifest, opts) { calls.push(['check', appId, opts.installationId, opts.maintenance ?? null]); return decision(appId); },
    knownBlock: (appId) => { const d = decision(appId); return d.ok ? null : d.block; },
    manifestView: (appId, b, e) => (e ? { ...b, tools: [...b.tools, 'from-profile'] } : b),
    sidecarValues: async () => null,
    start() { calls.push(['start']); },
    stop() {},
  };
}

async function gateWorld(apps, engine) {
  const { AppManager } = await import('../dist/app-manager/AppManager.js');
  const root = mkdtempSync(join(tmpdir(), 'aura-setup-gate-'));
  for (const [id, extra] of Object.entries(apps)) {
    mkdirSync(join(root, 'apps', id), { recursive: true });
    writeFileSync(join(root, 'apps', id, 'app.manifest.json'), JSON.stringify({ ...base, id, ...extra }));
  }
  const dataDir = join(root, 'mgr');
  const rootfs = join(root, 'rootfs'); mkdirSync(rootfs);
  const mgr = new AppManager({ appsDir: join(root, 'apps'), dataDir, baseRootfs: rootfs, toolchainDir: join(dataDir, 'tc'), ...(engine ? { setup: () => engine } : {}) });
  const sys = mgr.scopeRegistry.getAll().find((s) => s.id === 'system');
  for (const id of Object.keys(apps)) mgr.registry.loadManifestFile(join(root, 'apps', id, 'app.manifest.json'), sys);
  mgr.installationIdOf = async (id) => `inst-${id}`;
  const spawnContext = (id, extra = {}) => mgr.spawnContext(id, `${id}-1`, {
    manifest: mgr.registry.getById(id), runtime: { runtime: 'container', module: { runner: {} }, settings: {} }, installation: { installationId: `inst-${id}` }, ...extra,
  });
  return { mgr, spawnContext };
}

const SETUP = { setup: { version: 1, fields: { url: { type: 'string', title: 'URL' } } }, instanceMode: 'multi', warmPool: 1 };

test('the engine is handed in by the composition (AppManager.setup) and asked only for declaring apps', async () => {
  const engine = fakeEngine(() => ({ ok: true, effective: null }));
  const w = await gateWorld({ 'io.plain.app': {}, 'io.setup.app': SETUP }, engine);
  assert.equal(w.mgr.setup, engine);
  const r = await w.spawnContext('io.plain.app').then(() => null, (e) => e);
  assert.ok(!r || r.name !== 'OperationalBlockError', 'a simple app passes as before');
  assert.equal(w.mgr.skipBlocked(w.mgr.registry.getById('io.plain.app'), 'test'), false);
  assert.deepEqual(engine.calls, [], 'a simple app never reaches the engine');
});

test('a refused setup: spawnContext throws the 409 needs-setup body; startIntent answers setup-required; nothing is spawned', async () => {
  const block = setupGateBlock('io.setup.app', 'setup-required', 'setup-required', 'not set up', 'aura app setup io.setup.app');
  const engine = fakeEngine((id) => (id === 'io.setup.app' ? { ok: false, block } : { ok: true, effective: null }));
  const w = await gateWorld({ 'io.setup.app': SETUP }, engine);
  await assert.rejects(w.spawnContext('io.setup.app'), (e) => e.name === 'OperationalBlockError' && e.code === 'setup-required' && e.body.category === 'needs-setup');
  assert.deepEqual(engine.calls.at(-1), ['check', 'io.setup.app', 'inst-io.setup.app', null]);
  const r = await w.mgr.startIntent({ action: 'VIEW', appId: 'io.setup.app' });
  assert.deepEqual([r.kind, r.state, r.error.error, r.error.category], ['setup-required', 'setup-required', 'setup-required', 'needs-setup']);
  assert.equal(w.mgr.getInstancesByApp('io.setup.app').length, 0);
  assert.equal(w.mgr.skipBlocked(w.mgr.registry.getById('io.setup.app'), 'test'), true, 'the loops skip a known refusal');
});

test('the engine\'s own maintenance start is passed on; a spawn built from a stale view is refused', async () => {
  const effective = { configDigest: DIGEST };
  const engine = fakeEngine(() => ({ ok: true, effective }));
  const w = await gateWorld({ 'io.setup.app': SETUP }, engine);
  const r = await w.spawnContext('io.setup.app', { maintenance: 'setup', setupDigest: DIGEST }).then(() => null, (e) => e);
  assert.ok(!r || r.name !== 'OperationalBlockError', `passes (${r?.message})`);
  assert.deepEqual(engine.calls.at(-1), ['check', 'io.setup.app', 'inst-io.setup.app', 'setup']);
  await assert.rejects(w.spawnContext('io.setup.app', { setupDigest: null }), (e) => e.name === 'OperationalBlockError' && e.code === 'setup-required',
    'a manifest view that is not the validated configuration never starts');
  const view = await w.mgr.setupView('io.setup.app', w.mgr.registry.getById('io.setup.app'));
  assert.deepEqual([view.declares, view.digest, view.manifest.tools.includes('from-profile')], [true, DIGEST, true], 'the spawn uses the effective view');
});

test('without an engine an app that declares setup never starts (setup-unsupported); a simple app is unchanged', async () => {
  const w = await gateWorld({ 'io.setup.app': SETUP, 'io.plain.app': {} });
  assert.equal(w.mgr.setup, null);
  await assert.rejects(w.spawnContext('io.setup.app'), (e) => e.code === 'setup-unsupported');
  const r = await w.spawnContext('io.plain.app').then(() => null, (e) => e);
  assert.ok(!r || r.name !== 'OperationalBlockError');
});
