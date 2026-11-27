// D48: the app contract — manifest declarations, the contract version, and
// the dataDir report helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// The composition root (Phase 6 K) wires the service accessors when the barrel loads.
import '../dist/index.js';
import { existsSync, mkdtempSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppManifestSchema } from '../dist/types/manifest.js';
import {
  AURA_CONTRACT, contractDeclarations, contractFindings, contractStatus,
} from '../dist/contract/appContract.js';
import { dataDirReport, layerWrites, scanInstallWrites } from '../dist/contract/dataDirReport.js';

const base = { id: 'com.example.notes', name: 'Notes', version: '1.0.0' };
const parse = (over = {}) => AppManifestSchema.parse({ ...base, ...over });
const codes = (m) => contractFindings(m).map((f) => f.code);

test('the manifest declares auraContract and context keys; old manifests still parse', () => {
  const m = parse({ auraContract: 1, context: ['OPENAI_API_KEY'] });
  assert.equal(m.auraContract, 1);
  assert.deepEqual(m.context, ['OPENAI_API_KEY']);
  const old = parse();
  assert.equal(old.auraContract, undefined);
  assert.deepEqual(old.context, []);
  assert.equal(AppManifestSchema.safeParse({ ...base, context: ['lower-case'] }).success, false);
  assert.equal(AppManifestSchema.safeParse({ ...base, auraContract: 0 }).success, false);
});

test('contract status: none, current, incompatible major', () => {
  assert.equal(AURA_CONTRACT, 1);
  assert.deepEqual(contractStatus({}), { version: null, status: 'none' });
  assert.deepEqual(contractStatus({ auraContract: 1 }), { version: 1, status: 'current' });
  assert.deepEqual(contractStatus({ auraContract: 2 }), { version: 2, status: 'incompatible' });
});

test('declarations: permissions, context, sidecars with images, consumes, docker, privileged', () => {
  const m = parse({
    auraContract: 1, permissions: ['sidecars.spawn', 'sidecars.privileged'], tools: ['git', 'docker'], context: ['A_KEY'],
    services: [{ name: 'db', image: 'postgres:16' }],
    consumes: [{ name: 'search', kind: 'http/mcp', appId: 'com.aura.docs' }, { name: 'tts', kind: 'http/rest' }],
  });
  assert.deepEqual(contractDeclarations(m), {
    auraContract: 1, permissions: ['sidecars.spawn', 'sidecars.privileged'], context: ['A_KEY'],
    sidecars: [{ name: 'db', image: 'postgres:16' }], consumes: ['com.aura.docs/search', 'tts'], docker: true, privileged: true,
  });
  assert.equal(contractDeclarations(parse({ tools: ['*'] })).docker, false, 'J.7: `*` never grants docker');
  assert.equal(contractDeclarations(parse({ tools: ['git'] })).docker, false);
});

test('findings: what the manifest uses but does not declare', () => {
  assert.deepEqual(codes(parse()), ['contract-missing']);
  assert.deepEqual(codes(parse({ auraContract: 9 })), ['contract-unsupported']);
  const [refused] = contractFindings(parse({ auraContract: 9 }));
  assert.equal(refused.severity, 'error', 'aura dev validate fails on it');
  assert.equal(refused.message, 'com.example.notes is built for Aura contract 9; this AuraOS implements 1. Update AuraOS or install a version built for contract 1.');
  assert.deepEqual(codes(parse({ auraContract: 1, services: [{ name: 'db', image: 'x' }] })), ['sidecars-undeclared']);
  assert.deepEqual(codes(parse({ auraContract: 1, permissions: ['sidecars.spawn'], services: [{ name: 'db', image: 'x', privileged: true }] })), ['privileged-undeclared']);
  assert.deepEqual(codes(parse({ auraContract: 1, permissions: ['sidecars.spawn'], services: [{ name: 'db', image: 'x', inheritDockerSocket: true }] })), ['docker-socket-removed']);
  assert.deepEqual(codes(parse({ auraContract: 1, permissions: ['sidecars.spawn', 'sidecars.privileged'], services: [{ name: 'db', image: 'x', devices: ['/dev/x'] }] })), []);
  assert.deepEqual(codes(parse({ auraContract: 1, tools: ['docker'], services: [{ name: 'db', image: 'x', publish: [{ host: 1, container: 2 }] }] })), ['docker-socket-removed'], 'J.7: a docker entry gets no socket, only a warning');
});

test('layerWrites keeps written leaves outside scratch paths', () => {
  const r = layerWrites(['C /root', 'A /root/.npm', 'A /root/.npm/x.json', 'C /tmp', 'A /tmp/a', 'D /etc/old', 'C /etc', 'C /etc/hosts', 'A /var/run/x']);
  assert.deepEqual(r, { writes: ['/etc/hosts', '/root/.npm/x.json'], truncated: false });
  const many = layerWrites(Array.from({ length: 30 }, (_, i) => `A /f${i}`), 5);
  assert.equal(many.writes.length, 5);
  assert.equal(many.truncated, true);
});

test('scanInstallWrites lists files changed after the manifest, skipping build output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'datadir-'));
  const old = Date.now() / 1000 - 3600;
  writeFileSync(join(dir, 'app.manifest.json'), '{}');
  utimesSync(join(dir, 'app.manifest.json'), old, old);
  writeFileSync(join(dir, 'src.ts'), '');
  utimesSync(join(dir, 'src.ts'), old, old);
  mkdirSync(join(dir, 'state'));
  writeFileSync(join(dir, 'state', 'db.json'), '{}');
  mkdirSync(join(dir, 'node_modules'));
  writeFileSync(join(dir, 'node_modules', 'x.js'), '');
  mkdirSync(join(dir, 'dist'));
  writeFileSync(join(dir, 'dist', 'index.js'), '');
  assert.deepEqual(scanInstallWrites(dir), { writes: ['state/db.json'], truncated: false });
  assert.deepEqual(scanInstallWrites(join(dir, 'missing')), { writes: [], truncated: false });
});

test('dataDirReport combines install folder, container layer and the home mount', async () => {
  const deps = {
    homePath: '/home/aura',
    installWrites: (dir) => ({ writes: dir === '/a' ? ['notes.db'] : [], truncated: false }),
    inspectWrites: async (id) => (id === 'b-1' ? ['C /root', 'A /root/.cache-x'] : null),
    workloadMounts: async () => [{ destination: '/home/aura', rw: true }, { destination: '/data', rw: true }],
  };
  const r = await dataDirReport([
    { appId: 'a', scope: 'user', dir: '/a', sandbox: 'proot', ownNamespace: false, instances: [{ instanceId: 'a' }] },
    { appId: 'b', scope: 'user', dir: '/b', sandbox: 'container', ownNamespace: true, instances: [{ instanceId: 'b-1', inspect: true }] },
    { appId: 'c', scope: 'user', dir: '/c', sandbox: 'container', ownNamespace: true, instances: [{ instanceId: 'c-1', inspect: true }] },
  ], deps);
  assert.deepEqual(r.map((x) => [x.appId, x.outside, x.home]), [['a', true, 'rw'], ['b', true, 'rw'], ['c', false, 'rw']]);
  assert.deepEqual(r[1].containerLayer, [{ instanceId: 'b-1', writes: ['/root/.cache-x'], truncated: false }]);
  assert.deepEqual(r[2].containerLayer, [{ instanceId: 'c-1', error: 'docker diff unavailable' }]);
});

test('source scan: undeclared context keys, raw Context reads, permissions, docker, interfaces', async () => {
  const { scanContractText, scanContractSources } = await import('../dist/contract/sourceScan.js');
  const m = parse({ auraContract: 1, context: ['GOOD_KEY'], permissions: ['user.confirm'], consumes: [{ name: 'search', kind: 'http/mcp' }] });
  const text = [
    "const a = await osClient.context.get('GOOD_KEY');",
    "const b = await osClient.context.get('BAD_KEY');",
    "// const c = await osClient.context.get('COMMENTED');",
    "const raw = readFileSync('/run/context/OPENAI_API_KEY', 'utf8');",
    "const env = process.env.OPENAI_API_KEY;",
    "await osClient.user.confirm({ action: 'x' });",
    "await osClient.storage.set('k', 1);",
    "execFile('docker', ['ps']);",
    "await osClient.interfaces.resolve('com.aura.docs/search');",
    "await osClient.interfaces.resolve('tts');",
  ].join('\n');
  const f = scanContractText('src/x.ts', text, m, ['OPENAI_API_KEY']);
  assert.deepEqual(f.map((x) => [x.line, x.code]), [
    [2, 'context-undeclared'], [4, 'context-raw'], [5, 'context-raw'], [7, 'permission-undeclared'], [8, 'docker-undeclared'], [10, 'interface-undeclared'],
  ]);
  assert.match(f[3].message, /storage\.read/);
  assert.equal(scanContractText('a.ts', "execFile('docker', ['ps']);", parse({ tools: ['docker'] })).length, 0);
  // Stream C: a declared key is in the env once granted, so its env read is not a finding.
  assert.equal(scanContractText('a.ts', 'const k = process.env.GOOD_KEY;', m, ['GOOD_KEY']).length, 0);
  const dir = mkdtempSync(join(tmpdir(), 'scan-'));
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'node_modules'));
  writeFileSync(join(dir, 'src', 'a.ts'), "cat('/run/context/X')\n");
  writeFileSync(join(dir, 'node_modules', 'b.js'), "cat('/run/context/X')\n");
  assert.deepEqual(scanContractSources(dir, parse()).map((x) => [x.file, x.code]), [['src/a.ts', 'context-raw']]);
});

// ── Phase 6 G: the unknown-major refusal (D48), one helper with the ARI ──────

test('refuseUnknownMajor: one comparison and message for auraContract and ARI; none and current pass', async () => {
  const { refuseUnknownMajor, contractRefusal, CONTRACT_UNSUPPORTED, CONTRACT_AUDIT_ACTIONS } = await import('../dist/contract/types.js');
  const { ariRefusal, ARI_VERSION } = await import('../dist/runtimes/ari.js');
  assert.equal(refuseUnknownMajor('auraContract', 'io.x', 1, 1), null);
  assert.equal(refuseUnknownMajor('auraContract', 'io.x', 0, 1), null);
  assert.deepEqual(refuseUnknownMajor('auraContract', 'io.x', 2, 1), {
    kind: 'auraContract', code: 'contract-unsupported', subject: 'io.x', declared: 2, implemented: 1,
    message: 'io.x is built for Aura contract 2; this AuraOS implements 1. Update AuraOS or install a version built for contract 1.',
  });
  assert.equal(CONTRACT_UNSUPPORTED, 'contract-unsupported');
  assert.equal(CONTRACT_AUDIT_ACTIONS.refused, 'app.contract-refused');
  assert.equal(contractRefusal({ id: 'io.x' }), null, 'none (before the contract) stays allowed');
  assert.equal(contractRefusal({ id: 'io.x', auraContract: AURA_CONTRACT }), null);
  assert.equal(contractRefusal({ id: 'io.x', auraContract: AURA_CONTRACT + 1 })?.code, 'contract-unsupported');
  // The ARI refusal is the same helper: same code and message as before 5b's own copy.
  const ari = refuseUnknownMajor('ari', 'future', ARI_VERSION + 1, ARI_VERSION);
  const err = ariRefusal({ id: 'future', version: '1.0.0', ari: ARI_VERSION + 1, settingsVersion: 1 });
  assert.equal(err.code, ari.code);
  assert.equal(err.message, ari.message);
});

test('install and patch activation refuse an app built for a newer contract: error event, nobody asked, nothing installed', async () => {
  const { NexusManager } = await import('../dist/nexus/NexusManager.js');
  const root = mkdtempSync(join(tmpdir(), 'aura-contract-install-'));
  const scope = (id, priority, immutable) => ({ id, appsDir: join(root, id, 'apps'), dataDir: join(root, id, 'data'), immutable, priority });
  const scopes = [scope('system', 0, true), scope('global', 1, false), scope('user', 2, false)];
  // Phase 7a: installs need the atomic exchange helper (the image ships it; tests build it).
  const mgr = new NexusManager({ exchangeHelper: (await import('./rename-exchange-helper.mjs')).exchangeHelper(), scopes, rootDataDir: join(root, 'root') });
  const tree = (name, auraContract) => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'app.manifest.json'), JSON.stringify({ ...base, id: 'io.shop.app', ...(auraContract ? { auraContract } : {}) }));
    return dir;
  };
  for (const action of [undefined, 'app.patch.activate']) {
    const asked = [];
    const events = [];
    const it = mgr.install({ ref: tree(`t-${action ?? 'install'}`, AURA_CONTRACT + 1), scope: 'user', ...(action ? { action } : {}), approval: async (b) => { asked.push(b); return true; } });
    let error = null;
    try { for (let c = await it.next(); !c.done; c = await it.next()) events.push(c.value); }
    catch (e) { error = e.message; }
    const ev = events.find((e) => e.type === 'error');
    assert.equal(ev?.code, 'contract-unsupported', action ?? 'install');
    assert.equal(ev.message, `io.shop.app is built for Aura contract ${AURA_CONTRACT + 1}; this AuraOS implements ${AURA_CONTRACT}. Update AuraOS or install a version built for contract ${AURA_CONTRACT}.`);
    assert.equal(error, ev.message);
    assert.deepEqual(asked, [], 'refused before the owner is asked');
    assert.equal(existsSync(join(scopes[2].appsDir, 'io.shop.app')), false);
  }
  // `none` (no auraContract) installs as before.
  const it = mgr.install({ ref: tree('t-none'), scope: 'user', approval: async () => true });
  let c; for (c = await it.next(); !c.done; c = await it.next()) assert.notEqual(c.value.type, 'error');
  assert.equal(c.value.id, 'io.shop.app');
});

// ── D108 A1/A2: the one start gate (newer contract, reserved setup/profiles) ─

const gateWorld = async (apps) => {
  const { AppManager } = await import('../dist/app-manager/AppManager.js');
  const root = mkdtempSync(join(tmpdir(), 'aura-gate-'));
  for (const [id, extra] of Object.entries(apps)) {
    mkdirSync(join(root, 'apps', id), { recursive: true });
    writeFileSync(join(root, 'apps', id, 'app.manifest.json'), JSON.stringify({ ...base, id, ...extra }));
  }
  const dataDir = join(root, 'mgr');
  const rootfs = join(root, 'rootfs'); mkdirSync(rootfs);
  const mgr = new AppManager({ appsDir: join(root, 'apps'), dataDir, baseRootfs: rootfs, toolchainDir: join(dataDir, 'tc') });
  const sys = mgr.scopeRegistry.getAll().find((s) => s.id === 'system');
  for (const id of Object.keys(apps)) mgr.registry.loadManifestFile(join(root, 'apps', id, 'app.manifest.json'), sys);
  /** The spawn choke point with a resolved installation: the gate sits right after the run-as migration block. */
  const spawnContext = (id) => mgr.spawnContext(id, `${id}-1`, {
    manifest: mgr.registry.getById(id), runtime: { runtime: 'container', module: { runner: {} }, settings: {} }, installation: { installationId: `inst-${id}` },
  });
  return { root, mgr, spawnContext };
};

test('D108 A1: setup and profiles are reserved in the schema (kept, never dropped) and refused with a D105 body', async () => {
  const { operationalBlock, declaredSetupKeys, operationalBlockOf, OperationalBlockError, RESERVED_SETUP_KEYS } = await import('../dist/contract/types.js');
  assert.deepEqual([...RESERVED_SETUP_KEYS], ['setup', 'profiles']);
  const m = parse({ setup: { fields: [{ id: 'url' }] }, profiles: [{ id: 'personal' }] });
  assert.deepEqual(m.setup, { fields: [{ id: 'url' }] }, 'kept as declared');
  assert.deepEqual(m.profiles, [{ id: 'personal' }]);
  assert.deepEqual(declaredSetupKeys(m), ['setup', 'profiles']);
  const b = operationalBlock(m);
  // The D105 error body (errors/contracts.ts AuraErrorBody): only its fields, the state under details.
  assert.deepEqual({ ...b, message: undefined, hint: undefined }, {
    error: 'setup-unsupported', category: 'unsupported-feature', manifestField: 'setup', target: 'com.example.notes', docs: 'app-contract',
    details: { state: 'blocked' }, message: undefined, hint: undefined,
  });
  const D105_FIELDS = ['error', 'message', 'reason', 'category', 'hint', 'docs', 'permission', 'holder', 'capability', 'missing', 'suggest', 'manifestField', 'policy', 'target', 'approvalId', 'details'];
  for (const body of [b, operationalBlock(parse({ auraContract: 2 }))]) {
    assert.deepEqual(Object.keys(body).filter((k) => !D105_FIELDS.includes(k)), [], 'no field outside the D105 body');
  }
  assert.match(b.message, /declares setup and profiles .*D108.*does not start the app unconfigured/);
  assert.match(b.hint, /without setup\/profiles, or update AuraOS/);
  assert.equal(operationalBlock(parse({ profiles: [] }))?.manifestField, 'profiles', 'an empty list is still a declaration');
  // A newer contract wins (it says more), with the same body shape.
  assert.deepEqual([operationalBlock(parse({ auraContract: 2, setup: {} }))?.error, operationalBlock(parse({ auraContract: 2 }))?.category], ['contract-unsupported', 'unsupported-operation']);
  const err = new OperationalBlockError(b);
  assert.equal(err.code, 'setup-unsupported');
  assert.deepEqual(operationalBlockOf(err), b);
  assert.equal(operationalBlockOf(new Error('x')), null);
  assert.deepEqual(codes(parse({ auraContract: 1, setup: {} })), ['setup-unsupported'], 'aura dev validate: an error');
  assert.equal(contractFindings(parse({ auraContract: 1, setup: {} }))[0].severity, 'error');
});

test('binding (D108): an app without setup, profiles or a newer contract passes the gate exactly as before', async () => {
  const { operationalBlock } = await import('../dist/contract/types.js');
  for (const over of [{}, { auraContract: 1 }, { auraContract: 1, metadata: { setup: 'x' } }]) assert.equal(operationalBlock(parse(over)), null, JSON.stringify(over));
  const w = await gateWorld({ 'io.plain.app': { auraContract: 1, instanceMode: 'multi', warmPool: 1 } });
  assert.equal(w.mgr.skipBlocked(w.mgr.registry.getById('io.plain.app'), 'test'), false, 'no loop skips it');
  // Past the gate: whatever the start needs next (identities, homes) is the old path, never a gate refusal.
  const r = await w.spawnContext('io.plain.app').then(() => null, (e) => e);
  assert.ok(!r || r.name !== 'OperationalBlockError', `the gate let it through (${r?.name}: ${r?.message})`);
  // startIntent goes on to pick (start) an instance as before; a fake stands in for the spawn.
  const { AppManager } = await import('../dist/app-manager/AppManager.js');
  const picked = [];
  const fake = { registry: w.mgr.registry, getInstancesByApp: () => [], pickIntentInstance: async (m) => { picked.push(m.id); throw new Error('spawn stand-in'); } };
  await assert.rejects(AppManager.prototype.startIntent.call(fake, { action: 'VIEW', appId: 'io.plain.app' }), /spawn stand-in/);
  assert.deepEqual(picked, ['io.plain.app'], 'startIntent tries to start it as before');
});

test('D108 A2: the gate in spawnContext refuses every spawn; registry lists and audits it; loops skip; startIntent answers setup-required', async () => {
  const { AppRegistry } = await import('../dist/app-manager/AppRegistry.js');
  const w = await gateWorld({
    'io.future.app': { auraContract: AURA_CONTRACT + 1, instanceMode: 'multi', warmPool: 1 },
    'io.setup.app': { setup: { fields: [] }, componentType: 'service', instanceMode: 'single' },
  });
  // Registry: listed, the hook (the kernel's audit row) gets the body.
  const blocked = [];
  const scopeDef = { id: 'system', appsDir: join(w.root, 'apps'), dataDir: join(w.root, 'data'), immutable: true, priority: 0 };
  const reg = new AppRegistry([scopeDef], { onBlocked: (b) => blocked.push(b) });
  for (const id of ['io.future.app', 'io.setup.app']) reg.loadManifestFile(join(w.root, 'apps', id, 'app.manifest.json'), scopeDef);
  assert.equal(reg.getById('io.setup.app')?.setup !== undefined, true, 'still listed, with its block');
  assert.deepEqual(blocked.map((b) => [b.target, b.error]), [['io.future.app', 'contract-unsupported'], ['io.setup.app', 'setup-unsupported']]);
  // The one gate: every spawn passes spawnContext.
  for (const [id, code] of [['io.future.app', 'contract-unsupported'], ['io.setup.app', 'setup-unsupported']]) {
    await assert.rejects(w.spawnContext(id), (e) => e.name === 'OperationalBlockError' && e.code === code && e.body.target === id);
  }
  // The loops skip instead of spawning to fail.
  assert.equal(w.mgr.skipBlocked(w.mgr.registry.getById('io.setup.app'), 'test'), true);
  w.mgr.scheduleRefill('io.future.app');
  assert.equal(w.mgr.getInstancesByApp('io.future.app').length, 0, 'no pool member');
  // startIntent: an additive answer, nothing spawned.
  const r = await w.mgr.startIntent({ action: 'VIEW', appId: 'io.setup.app' });
  assert.deepEqual([r.kind, r.appId, r.state, r.error.error, r.error.category], ['setup-required', 'io.setup.app', 'blocked', 'setup-unsupported', 'unsupported-feature']);
  assert.equal(w.mgr.getInstancesByApp('io.setup.app').length, 0);
});

test('install, update and patch activation refuse setup/profiles before anyone is asked: the error event carries the D105 body', async () => {
  const { NexusManager } = await import('../dist/nexus/NexusManager.js');
  const root = mkdtempSync(join(tmpdir(), 'aura-setup-install-'));
  const scope = (id, priority, immutable) => ({ id, appsDir: join(root, id, 'apps'), dataDir: join(root, id, 'data'), immutable, priority });
  const scopes = [scope('system', 0, true), scope('global', 1, false), scope('user', 2, false)];
  const mgr = new NexusManager({ scopes, rootDataDir: join(root, 'root') });
  const dir = join(root, 'tree');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'app.manifest.json'), JSON.stringify({ ...base, id: 'io.shop.app', auraContract: 1, profiles: [{ id: 'team' }] }));
  const asked = [];
  const events = [];
  const it = mgr.install({ ref: dir, scope: 'user', approval: async (b) => { asked.push(b); return true; } });
  let error = null;
  try { for (let c = await it.next(); !c.done; c = await it.next()) events.push(c.value); }
  catch (e) { error = e; }
  const ev = events.find((e) => e.type === 'error');
  assert.deepEqual([ev?.code, ev?.body?.error, ev?.body?.manifestField, ev?.body?.category], ['setup-unsupported', 'setup-unsupported', 'profiles', 'unsupported-feature']);
  assert.equal(error?.code, 'setup-unsupported');
  assert.deepEqual(asked, []);
  assert.equal(existsSync(join(scopes[2].appsDir, 'io.shop.app')), false);
});
