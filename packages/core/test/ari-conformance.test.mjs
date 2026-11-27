// The ARI conformance kit (layer 1) against every runtime module this
// release has, in process: the built-in container and PRoot modules over
// recording runner stubs (no Docker, no processes) and a test-only fake that
// registers with no AppManager or shell edit (plan §4.2), and a reference
// mock provider with every implemented group in memory and nothing of
// Docker (opaque refs, a remote network, no host filesystem): the proof that
// the contract carries no Docker semantics (D100 owner decision; the kernel
// side of it is ari-modules.test.mjs, which adopts from this mock).
// Run via: node tools/run-tests.mjs --only=core

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeRuntime } from './ari-conformance/kit.mjs';
import { mockProvider } from './ari-conformance/mock.mjs';
import { HEALTHY, moduleFeatures, runnerEndpoint } from '../dist/index.js';
import { containerRuntime } from '../dist/runtimes/container/index.js';
import { prootRuntime } from '../dist/runtimes/proot/index.js';
import { ContainerRunner } from '../dist/app-manager/ContainerRunner.js';
import { ProotRunner } from '../dist/app-manager/ProotRunner.js';

const TMP = mkdtempSync(join(tmpdir(), 'aura-ari-kit-'));
const ROOTFS = join(TMP, 'rootfs');
mkdirSync(ROOTFS);

/** A runner stub: the real capability declaration, a recorded endpoint for `known-1`. */
const stub = (capabilities, host) => ({
  capabilities,
  toolsDir: (id) => join(TMP, 'tools', id),
  getHost: (id) => (id === 'known-1' ? host : null),
  getPort: (id) => (id === 'known-1' ? 4123 : null),
});

/** The container stub with today's runner surface for the groups (a survivor, a session, usage as a Map). */
const containerStub = () => {
  const registered = [];
  return Object.assign(stub((s) => ContainerRunner.prototype.capabilities.call({}, s), 'aura-known-1'), {
    registered,
    listOrphanRecords: async () => [{ instanceId: 'org.k.app-2', appId: 'org.k.app', port: 4124, hostname: 'aura-org.k.app-2', pid: 4242,
      tokenNonce: 'n', ownerLabel: 'default', address: '172.18.0.9', addresses: ['172.18.0.9'], lifecycleToken: 'secret' }],
    registerAdopted: (rec) => { registered.push(rec); },
    openSessions: () => [{ sessionId: 's', instanceId: 'known-1', kind: 'user', home: 'private', uid: 100000, launcherPid: 99, startedAt: 'now' }],
    usage: async () => new Map([['known-1', { memBytes: 1, cpuPct: 1 }]]),
    provisionToolsDir: () => '/x',
  });
};
describeRuntime('container', () => containerRuntime(containerStub(), { toolsMode: () => 'hardlink' }), {
  instance: 'known-1',
  groups: async (m) => {
    const [s] = await m.adoption.list();
    // The runner gets back exactly what it listed (its own names and secrets); the kernel saw only the opaque ref.
    if (m.adoption.adopt(s.instanceId).pid !== 4242 || m.runner.registered[0].hostname !== s.ref) throw new Error('adopt round trip');
    const r = m.tools.apply('known-1', { tools: ['git'] });
    if (r.state !== 'applied' || r.detail.enforcement !== 'enforced') throw new Error('hardlink mode is enforced');
  },
});
describeRuntime('container (legacy symlink tool mode)', () => containerRuntime(containerStub(), { toolsMode: () => 'symlink' }), {
  instance: 'known-1',
  groups: async (m) => {
    const r = m.tools.apply('known-1', { tools: ['git'] });
    if (r.detail.enforcement !== 'advisory') throw new Error('symlink mode is advisory, never enforced');
    const f = moduleFeatures(m, {}).find((x) => x.id === 'tools.liveRevoke');
    if (f.support !== 'conditional' || f.constraints.enforcement !== 'advisory') throw new Error('reported conditional/advisory');
    if (m.health({}).status !== 'degraded') throw new Error('health degrades in symlink mode');
  },
});
describeRuntime('proot', () => prootRuntime(stub((s) => ProotRunner.prototype.capabilities.call({}, s), '127.0.0.1'),
  { baseRootfs: ROOTFS, env: { AURA_USE_PROOT: 'true' } }),
{ instance: 'known-1', settings: [{ placement: 'master' }, { placement: 'pool' }] });

const FAKE_CAPS = Object.freeze({
  isolation: 'vm', network: 'remote', appHome: true, privateHomeSession: false, sessionExec: false, identity: 'emulated',
  readOnlyBinds: true, hostFilesystem: false, mounts: false, idmappedMounts: false, portExpose: false, sidecars: false,
  warmPool: false, survivesShellRestart: false, usage: false, gpu: false, userNamespaces: false,
});
describeRuntime('fake', () => {
  const runner = stub(() => FAKE_CAPS, 'fake.example');
  return {
    descriptor: { id: 'fake', version: '0.1.0', ari: 1, title: 'Fake', description: 'test only', builtIn: false, settingsVersion: 1,
      settingsSchema: { type: 'object', properties: {} } },
    runner, capabilities: () => ({ ...FAKE_CAPS }), health: () => HEALTHY, endpoint: (id) => runnerEndpoint(runner, id),
  };
}, { instance: 'known-1' });

describeRuntime('mock', mockProvider, {
  instance: 'known-1',
  instanceOps: (m, id) => m._workloadEnv(id),
  groups: async (m) => {
    const [s] = await m.adoption.list();
    if (!s) throw new Error('the mock lists its survivor');
    m.adoption.adopt(s.instanceId);
    if (!m.runner.isRunning(s.instanceId)) throw new Error('adopt hands the survivor back to the provider');
    const u = await m.usage({ instanceIds: [s.instanceId], sidecarIds: [] });
    if (!u[s.instanceId]) throw new Error('usage is keyed by instance id');
  },
});

// D106: the reference mock with some limits it can't enforce (partial) and with none: the mandatory-limits contract.
describeRuntime('mock (partial limits: no pids)', () => mockProvider({ limits: { cpus: 'supported', memoryBytes: 'supported', pids: 'unsupported' } }), { instance: 'known-1' });
describeRuntime('mock (no limits)', () => mockProvider({ limits: { cpus: 'unsupported', memoryBytes: 'unsupported', pids: 'unsupported' } }), { instance: 'known-1' });
// D107: a reference provider that can't isolate workloads, and one without nested sandboxes.
describeRuntime('mock (no workload isolation, no userns)', () => mockProvider({ workloadIsolation: 'none', userNamespaces: false }), { instance: 'known-1' });

// ── Rows over the built-ins' sources and golden argv (5b E) ─────────────────

test('[ARI built-ins] D89: a start with a workload token injects AURA_INSTANCE_TOKEN in every runtime column (golden argv)', () => {
  const golden = JSON.parse(readFileSync(new URL('./golden/spawn-args.json', import.meta.url), 'utf8'));
  let checked = 0;
  for (const [fixture, cols] of Object.entries(golden)) {
    const spawns = Object.entries(cols).filter(([, v]) => v && typeof v === 'object' && !('refused' in v));
    if (!spawns.some(([, v]) => /AURA_INSTANCE_TOKEN/.test(JSON.stringify(v)))) continue;   // a fixture without a token in its context
    for (const [col, v] of spawns) { assert.match(JSON.stringify(v), /AURA_INSTANCE_TOKEN=tok-1|"AURA_INSTANCE_TOKEN":"tok-1"/, `${fixture}/${col}`); checked++; }
  }
  assert.ok(checked >= 2, 'the container and the PRoot column both inject it');
});

test('[ARI built-ins] G1: no runtime module or runner imports OsEventBus (the kernel emits app:*; runtimes report through onExit)', () => {
  const files = [];
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.ts')) files.push(p); } };
  walk(new URL('../src/runtimes/', import.meta.url).pathname);
  for (const f of ['ContainerRunner.ts', 'ProotRunner.ts', 'SessionBroker.ts']) files.push(new URL(`../src/app-manager/${f}`, import.meta.url).pathname);
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /^import\s+(?!type\b)[^;]*OsEventBus/m, f);
    assert.doesNotMatch(src, /getEventBus\(|osEvents\.emit\(/, f);
  }
});
