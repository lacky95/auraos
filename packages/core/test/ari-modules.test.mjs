// Phase 5b CR, PR, RS: the built-in runtime modules and the kernel parts that
// now go through them. Adoption, sessions, workloads, usage and tools reach a
// runtime through its capability groups (never the container runner); the
// PRoot module's actions; the kernel PRoot respawn record.
// Run via: node tools/run-tests.mjs --only=core

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OsEventBus, RuntimeRegistry, containerName, readRespawnRecord, writeRespawnRecord, respawnEntries, respawnFile,
  prootOwnerActions, PROOT_POOL_UNAVAILABLE, builtInRuntimeRecord,
} from '../dist/index.js';
import { prootRuntime } from '../dist/runtimes/proot/index.js';
import { AppManager } from '../dist/app-manager/AppManager.js';
import { ProotRunner } from '../dist/app-manager/ProotRunner.js';
import { mockProvider } from './ari-conformance/mock.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'aura-ari-mod-'));
const ROOTFS = join(TMP, 'rootfs');
mkdirSync(ROOTFS);
const mgrOf = (extra = {}) => {
  const dataDir = mkdtempSync(join(TMP, 'mgr-'));
  return new AppManager({ appsDir: join(dataDir, 'apps'), dataDir, baseRootfs: ROOTFS, toolchainDir: join(dataDir, 'tc'), ...extra });
};

// ── CR: names, the module boundary ─────────────────────────────────────────

test('CR: one containerName(); the runtime modules import no app-manager code at runtime (D97)', () => {
  assert.equal(containerName('com.aura.terminal-3'), 'aura-com.aura.terminal-3');
  assert.equal(containerName('a:b/c'), 'aura-a_b_c');
  for (const f of ['container/index.ts', 'container/diagnostics.ts', 'container/endpoints.ts', 'container/networks.ts', 'proot/index.ts', 'proot/actions.ts',
    'proot/diagnostics.ts', 'proot/host.ts', 'proot/orphans.ts', 'hostTools.ts', 'respawn.ts', 'spawnSpec.ts', 'builtins/index.ts',
    'container/sidecars.ts', 'container/mounts.ts', 'spawn/networkArgs.ts', 'spawn/identityArgs.ts', 'spawn/homeArgs.ts', 'spawn/contextArgs.ts', 'spawn/sessionArgs.ts',
    'spawn/socketArgs.ts', 'spawn/paths.ts']) {
    const src = readFileSync(new URL(`../src/runtimes/${f}`, import.meta.url), 'utf8');
    for (const line of src.split('\n').filter((l) => /^import .*app-manager\//.test(l))) {
      assert.match(line, /^import type /, `${f}: ${line}`);
    }
  }
});

test('CR: AppManager reaches adoption, sessions, workloads and usage only through the groups', () => {
  const src = readFileSync(new URL('../src/app-manager/AppManager.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /this\.container\.(listOrphanRecords|registerAdopted|measureAdopted|killAllForApp|reapSiblingsOf|listSidecars|removeSidecars|usage|openSessions|endSession|clearMountRoot|onExit)\b/);
  // What stays on the runner: the managers' wiring and the D80 idmap probe of the mount backend
  // (5b G; both move behind the `mounts` group with D-M). Builds go through the `build` group (5b-2 D-B).
  const left = [...src.matchAll(/this\.container\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(left)].sort(), ['probeIdmappedMounts', 'survivorsUnknown']);
});

test('CR (D77): the kernel adopts survivors from any provider with the adoption group: the reference mock, no Docker', async () => {
  const mock = mockProvider();
  const mgr = mgrOf({ runtimes: [mock] });
  // The container runtime's own scan is not reachable in a unit test (no engine): its survivors are unknown.
  const complete = await mgr['adoptOrphans']();
  assert.equal(complete, false, 'a failed scan of one runtime keeps adoption pending (nothing reaped)');
  const inst = mgr.getInstance('org.mock.app-1');
  assert.ok(inst, 'the mock survivor is a kernel instance');
  assert.equal(inst.sandbox, 'mock');
  assert.equal(inst.owner, 'default');
  assert.equal(inst.pid, null);
  // No manifest for it here: never handed to the provider's bookkeeping (as before).
  assert.equal(mock._running.has('org.mock.app-1'), false);
});

test('CR: sessions of every runtime with the group; ended through the runtime that holds them', async () => {
  const mock = mockProvider();
  const mgr = mgrOf({ runtimes: [mock] });
  const ids = mgr.openSessions().map((s) => s.sessionId);
  assert.ok(ids.includes('s-1'));
  assert.ok(mgr.openSessions().every((s) => !('launcherPid' in s)));
});

test('CR: a tokenless survivor (D89) is never kept as an adopted instance: stopped through its lifecycle', async () => {
  const mock = mockProvider();
  const list = mock.adoption.list;
  mock.adoption.list = async () => (await list()).map(({ tokenNonce: _n, ...s }) => s);
  const mgr = mgrOf({ runtimes: [mock] });
  mgr.registry.getById = (id) => (id === 'org.mock.app' ? { id, componentType: 'activity', hosts: [], services: [] } : undefined);
  mgr.providers.registerInstance = () => {};
  mgr.interfaces.registerInstance = () => {};
  const stopped = [];
  mgr.stop = async (id) => { stopped.push(id); };
  await mgr['adoptOrphans']();
  assert.equal(mgr.getInstance('org.mock.app-1')?.sandbox, 'mock');
  await mgr['stopTokenlessSurvivors']();
  assert.deepEqual(stopped, ['org.mock.app-1']);
});

test('CR: cap status: tools applied per instance by its runtime; unsupported where a runtime has no tools group', () => {
  const mock = mockProvider();
  const mgr = mgrOf({ runtimes: [mock] });
  mgr.registry.getById = (id) => ({ id, tools: ['git'] });
  mgr.getInstancesByApp = () => [{ instanceId: 'org.mock.app-1', appId: 'org.mock.app', sandbox: 'mock' }];
  mgr.instances.set('org.mock.app-1', { instanceId: 'org.mock.app-1', appId: 'org.mock.app', sandbox: 'mock', state: 'resumed' });
  const [r] = mgr.applyInstanceTools('org.mock.app');
  assert.equal(r.state, 'unsupported');
  assert.equal(r.error.category, 'unsupported-feature');
  assert.deepEqual(mgr.refreshInstanceTools('org.mock.app'), []);
});

// ── PR: the PRoot module ───────────────────────────────────────────────────

const PROOT_CAPS = (s) => ProotRunner.prototype.capabilities.call({}, s);
const prootStub = () => ({ capabilities: PROOT_CAPS, getHost: () => null, getPort: () => null, provisionToolsDir: () => '/t' });

test('PR: placement-aware capabilities; pool refused clearly (no fallback to master); only the tools group', () => {
  const m = prootRuntime(prootStub(), { baseRootfs: ROOTFS, env: { AURA_USE_PROOT: 'true' }, exists: () => true });
  assert.equal(m.capabilities({ placement: 'master' }).network, 'shell-netns');
  assert.equal(m.capabilities({ placement: 'pool' }).network, 'bridge');
  assert.deepEqual(m.health({ placement: 'pool' }), { status: 'unavailable', checks: [{ id: 'placement', ok: false, detail: PROOT_POOL_UNAVAILABLE }] });
  assert.equal(m.health({ placement: 'master' }).status, 'ok');
  assert.equal(prootRuntime(prootStub(), { baseRootfs: ROOTFS, env: { AURA_USE_PROOT: 'true' }, exists: () => false }).health({}).status, 'degraded');
  for (const g of ['adoption', 'sessions', 'workloads', 'usage']) assert.equal(m[g], undefined, g);
  assert.ok(m.tools);
  assert.deepEqual(Object.keys(m.actions).sort(), ['baseInstall', 'bench', 'info', 'inspectRootfs', 'upgrade', 'version']);
  const reg = new RuntimeRegistry();
  reg.register(m);
  const rec = { ...builtInRuntimeRecord(reg), settings: { proot: { placement: 'pool' } } };
  assert.throws(() => reg.resolve({ manifest: { id: 'org.p.app', sandbox: 'proot' }, installationId: 'i', sourceMode: 'open', record: rec }),
    (e) => /pool placement is not available/.test(e.message));
});

test('PR: baseInstall runs argv on the host it is handed: chroot, verified apt, never a shell', async () => {
  const runs = [];
  const host = { run: (file, args) => { runs.push([file, ...args]); return 'ok'; }, stageResolvConf: () => false, ensureDevices: () => [] };
  const out = await prootOwnerActions('/os/base-rootfs').baseInstall.run({ packages: ['nano'] }, host);
  assert.deepEqual(out.packages, ['nano']);
  assert.ok(runs.every(([f]) => f === 'chroot'));
  assert.ok(runs[1].includes('APT::Get::AllowUnauthenticated=false'));
  assert.deepEqual(runs[1].slice(-2), ['--', 'nano']);
  const failing = { ...host, run: () => { throw new Error('E: NO_PUBKEY'); } };
  await assert.rejects(prootOwnerActions('/r').baseInstall.run({ packages: ['nano'] }, failing), (e) => /NO_PUBKEY/.test(e.message) && Array.isArray(e.log));
  await assert.rejects(prootOwnerActions('/r').baseInstall.run({ packages: 'nano' }, host), /packages must be a list/);
});

// ── RS: the kernel respawn ─────────────────────────────────────────────────

test('RS: the record keeps running non-surviving instances only (no pool, preview, service/autoStart, crashed or stopped)', () => {
  const c = (id, extra = {}) => ({ instanceId: id, appId: id.replace(/-\d+$/, ''), state: 'resumed', survives: false, startedByKernel: false, ...extra });
  const entries = respawnEntries([
    c('io.p.a-1', { owner: 'u2' }), c('io.p.a-2', { state: 'paused' }), c('io.c.b-1', { survives: true }), c('io.p.pool-1', { inPool: true }),
    c('io.p.prev-1', { preview: { workspace: 'w' } }), c('io.p.svc-1', { startedByKernel: true }), c('io.p.err-1', { state: 'error' }),
    c('io.p.stop-1', { state: 'destroyed' }),
  ], (appId) => `inst-${appId}`);
  assert.deepEqual(entries, [
    { installationId: 'inst-io.p.a', appId: 'io.p.a', formerInstanceId: 'io.p.a-1', state: 'resumed', owner: 'u2' },
    { installationId: 'inst-io.p.a', appId: 'io.p.a', formerInstanceId: 'io.p.a-2', state: 'paused' },
  ]);
});

test('RS: the record round-trips; a missing or malformed one means nothing to respawn', () => {
  const dir = mkdtempSync(join(TMP, 'rec-'));
  assert.deepEqual(readRespawnRecord(dir), { v: 1, entries: [] });
  const rec = { v: 1, entries: [{ installationId: 'i', appId: 'a', formerInstanceId: 'a-1', state: 'resumed' }] };
  assert.equal(writeRespawnRecord(dir, rec), true);
  assert.deepEqual(readRespawnRecord(dir), rec);
  writeFileSync(respawnFile(dir), '{"v":1,"entries":[{"appId":1}]}');
  assert.deepEqual(readRespawnRecord(dir).entries, []);
});

test('RS: init respawns through the normal start, emits app:respawned once, maps the former id; skips reinstalled and kernel-started apps', async () => {
  const mgr = mgrOf();
  const manifests = { 'io.p.a': { id: 'io.p.a' }, 'io.p.svc': { id: 'io.p.svc', componentType: 'service' }, 'io.p.re': { id: 'io.p.re' } };
  mgr.registry.getById = (id) => manifests[id];
  mgr.isEnabled = () => true;
  mgr.installationIdOf = async (appId) => (appId === 'io.p.re' ? 'inst-new' : `inst-${appId}`);
  const starts = [];
  mgr.start = async (appId, as) => { starts.push([appId, as]); return `${appId}-7`; };
  const events = [];
  const on = (e) => events.push(e);
  OsEventBus.on('app:respawned', on);
  try {
    mgr['respawnFromRecord']([
      { installationId: 'inst-io.p.a', appId: 'io.p.a', formerInstanceId: 'io.p.a-1', state: 'resumed', owner: 'u2' },
      { installationId: 'inst-io.p.svc', appId: 'io.p.svc', formerInstanceId: 'io.p.svc', state: 'resumed' },
      { installationId: 'inst-old', appId: 'io.p.re', formerInstanceId: 'io.p.re', state: 'resumed' },
    ]);
    assert.equal(await mgr.respawnedInstance('io.p.a-1'), 'io.p.a-7');
    assert.equal(await mgr.respawnedInstance('io.p.svc'), null);
    assert.equal(await mgr.respawnedInstance('io.p.re'), null);
    assert.equal(await mgr.respawnedInstance('never-known'), null);
  } finally { OsEventBus.off?.('app:respawned', on); }
  assert.deepEqual(starts, [['io.p.a', { userId: 'u2' }]], 'only the plain app, as its owner (C8)');
  assert.deepEqual(events, [{ from: 'io.p.a-1', to: 'io.p.a-7', appId: 'io.p.a' }]);
});

// ── 5b-2 D: the moved groups, driven by the kernel over the reference mock (no Docker) ─────────────

test('D-X: the exec bridge reads logs through the runtime\'s `logs` and refuses a sidecar session without `workloads` (mock, no engine)', async () => {
  const { ExecBridge } = await import('../dist/app-manager/ExecBridge.js');
  const mock = mockProvider();
  await mock.runner.spawn('org.mock.app-2', 'org.mock.app', 4701, { id: 'org.mock.app' }, { instanceToken: { token: 't', nonce: 'n' } });
  const bridge = new ExecBridge({
    instance: (id) => ({ appId: 'org.mock.app', instanceId: id, state: 'resumed' }),
    runner: () => mock.runner,
    logs: () => mock.logs,
    workloads: () => undefined,
    sidecars: () => [{ id: 'w-1', service: 'db', backend: 'container', state: 'running' }],
    sessionContext: async () => { throw new Error('not reached'); },
  });
  const got = [];
  await (await bridge.logs('org.mock.app-2', {}, (s, d) => got.push([s, d.toString()]))).done;
  assert.deepEqual(got, [['out', 'org.mock.app-2 started\n']]);
  await assert.rejects(bridge.run('org.mock.app-2', { cmd: ['true'] }, { sidecar: 'db' }), (e) => e.status === 409 && e.code === 'runtime-unsupported');
  // A provider refusal by code maps to the bridge's answer (not-running → 409), never by message.
  await assert.rejects(bridge.logs('org.mock.gone', {}, () => {}), (e) => e.status === 409 && e.code === 'not-running');
});

test('D-B, D-P: builds and port exposure go through the groups; the container module declares both, PRoot and the mock neither', () => {
  const mgr = mgrOf({ runtimes: [mockProvider()] });
  const withBuild = mgr.runtimes.list().filter((m) => m.build).map((m) => m.descriptor.id);
  const withEndpoints = mgr.runtimes.list().filter((m) => m.endpoints).map((m) => m.descriptor.id);
  assert.deepEqual([withBuild, withEndpoints], [['container'], ['container']]);
  const src = readFileSync(new URL('../src/app-manager/AppManager.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /this\.container\.(buildApp|provisionApp)\b/, 'builds never call the concrete runner (D-B)');
  const pm = readFileSync(new URL('../src/app-manager/PortManager.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(pm, /execFile|['"]docker['"]/, 'PortManager holds no Docker mechanism (D-P)');
});

// ── Phase 6 D-S: OS sidecars through the workloads group ──────────────────────

test('D-S: SidecarManager spawns, lists, adopts, removes and reconciles OS sidecars through any workloads group: the reference mock, no Docker', async () => {
  const { SidecarManager } = await import('../dist/app-manager/SidecarManager.js');
  const { InstanceTokens } = await import('../dist/app-manager/InstanceTokens.js');
  const mock = mockProvider();
  const dataDir = mkdtempSync(join(TMP, 'sc-'));
  const INST = 'org.mock.app-1';
  const services = [{ name: 'box', image: 'alpine:3', command: ['sleep', 'infinity'], volumes: [], inheritIdentity: true }];
  const tokens = new InstanceTokens(join(dataDir, 'k'));
  const mgr = new SidecarManager({
    runner: {
      sidecarRuntime: () => ({ dataDir, appDataVolume: 'v', nodeModulesVolume: 'nm', network: 'n', osApiBase: 'x', shellHostname: 'h', workspaceRoot: '/w', toolsMode: 'hardlink' }),
      mountRootDir: (k) => join(dataDir, 'm', k), mountRootSubpath: (k) => `m/${k}`, toolsDir: (k) => join(dataDir, 't', k), clearToolsDir: () => {},
    },
    workloads: mock.workloads,
    registry: { getById: (id) => (id === 'org.mock.app' ? { id, services, tools: [], permissions: [] } : undefined) },
    permissions: { hasPermission: () => false },
    tokens,
    mounts: { reapplyConsumer: async () => ({}), removeAll: () => {}, forgetConsumer: () => {} },
    context: async () => ({ env: {}, known: new Set() }),
    instance: (id) => (id === INST ? { appId: 'org.mock.app', instanceDataDir: join(dataDir, 'apps', 'org.mock.app', INST) } : null),
    appHome: async () => null,
  });
  const res = await mgr.spawn(INST, { template: 'box' }, { instanceId: INST });
  assert.equal(res.created, true);
  assert.equal(res.sidecar.containerName, `urn:mock:wl/${INST}/box`, 'the runtime\'s opaque ref');
  const w = mock._workloads.get(res.sidecar.containerName);
  assert.equal(w.state, 'running');
  assert.match(w.env.AURA_INSTANCE_TOKEN ?? '', /./, 'D89: its own workload token');
  assert.deepEqual((await mgr.list(INST)).map((s) => s.name), ['box']);
  assert.equal((await mgr.spawn(INST, { template: 'box' }, { instanceId: INST })).created, false, 'same spec: adopted');
  assert.deepEqual(await mgr.reconcile(new Set([INST])), { adopted: 1, reaped: 0 });
  await mgr.remove(INST, 'box');
  assert.equal(mock._workloads.size, 0);
  // Without a runtime that runs OS sidecars: refused explicitly, never a silent no-op.
  const none = new SidecarManager({ ...mgr.opts, workloads: undefined });
  await assert.rejects(none.list(INST), /capability-missing: sidecars/);
});
