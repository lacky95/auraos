// D107 / owner confirmation D9: a Private Home only where network isolation is guaranteed. The start gate
// (AppManager.spawnContext → privateHomeNetwork.ts) refuses an instance with a Private Home when a sidecar would
// listen on the shared network or the runtime doesn't isolate workloads per instance; the sidecar spawn refuses a
// shared sidecar of such an instance. D105 shape, fail closed; the App Host / gateway routes are not counted.
//
// Run via: node tools/run-tests.mjs --only=core
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateHomeSidecarRefusal, requirePrivateHomeIsolation, templateNetwork } from '../dist/app-manager/privateHomeNetwork.js';
import { SidecarManager } from '../dist/app-manager/SidecarManager.js';
import { InstanceTokens } from '../dist/app-manager/InstanceTokens.js';
import { runtimeRefusal } from '../dist/index.js';
import { mockProvider } from './ari-conformance/mock.mjs';

test('templateNetwork: the sidecar-spec default (instance with inheritHome, else shared)', () => {
  assert.equal(templateNetwork({}), 'shared');
  assert.equal(templateNetwork({ inheritHome: true }), 'instance');
  assert.equal(templateNetwork({ inheritHome: true, network: 'shared' }), 'shared');
  assert.equal(templateNetwork({ network: 'instance' }), 'instance');
});

test('the gate: isolated sidecars on an isolating runtime pass; a shared sidecar or a runtime without isolation is refused (D105)', () => {
  const ok = mockProvider();
  const none = mockProvider({ workloadIsolation: 'none' });
  requirePrivateHomeIsolation('org.k.app', { services: [] }, ok);
  requirePrivateHomeIsolation('org.k.app', { services: [{ name: 'db', image: 'x', network: 'instance' }] }, ok);
  const check = (fn, missing, hint) => assert.throws(fn, (e) => {
    const r = runtimeRefusal(e);
    return e.code === 'feature-unsupported' && r.category === 'unsupported-feature' && JSON.stringify(r.missing) === JSON.stringify(missing) && hint.test(r.hint);
  });
  check(() => requirePrivateHomeIsolation('org.k.app', { services: [{ name: 'web', image: 'x' }, { name: 'db', image: 'x', network: 'instance' }] }, ok),
    ['services[web].network'], /"network": "instance" for services\[web\].*gateway routes stay/);
  // No sidecars at all, still: the runtime must isolate (the owner's rule: Private Home only where isolation is guaranteed).
  const iso = { ...ok, descriptor: { ...ok.descriptor, id: 'mock-iso' } };
  check(() => requirePrivateHomeIsolation('org.k.app', { services: [] }, none, [none, iso]), ['network.isolation.instance'], /mock-iso/);
});

test('the sidecar spawn: an instance with a Private Home gets no shared sidecar; an isolated one is created (mock, no Docker)', async () => {
  const mock = mockProvider();
  const dataDir = mkdtempSync(join(tmpdir(), 'aura-phn-'));
  const INST = 'org.mock.app-1';
  const services = [{ name: 'db', image: 'redis:7', command: [], volumes: [], network: 'instance' }, { name: 'web', image: 'nginx:1', command: [], volumes: [] }];
  const mgr = new SidecarManager({
    runner: {
      sidecarRuntime: () => ({ dataDir, appDataVolume: 'v', network: 'n', osApiBase: 'x', shellHostname: 'h', systemTree: { kind: 'checkout', hostRoot: '/w', nodeModulesVolume: 'nm' }, toolsMode: 'hardlink' }),
      mountRootDir: (k) => join(dataDir, 'm', k), mountRootSubpath: (k) => `m/${k}`, toolsDir: (k) => join(dataDir, 't', k), clearToolsDir: () => {},
    },
    workloads: mock.workloads,
    registry: { getById: (id) => (id === 'org.mock.app' ? { id, services, tools: [], permissions: [] } : undefined) },
    permissions: { hasPermission: () => false },
    tokens: new InstanceTokens(join(dataDir, 'k')),
    mounts: { reapplyConsumer: async () => ({}), removeAll: () => {}, forgetConsumer: () => {} },
    context: async () => ({ env: {}, known: new Set() }),
    instance: (id) => (id === INST ? { appId: 'org.mock.app', instanceDataDir: join(dataDir, 'apps', 'org.mock.app', INST), privateHome: true, runtime: 'mock' } : null),
    appHome: async () => null,
  });
  await assert.rejects(mgr.spawn(INST, { template: 'web' }, { instanceId: INST }),
    (e) => e.code === 'feature-unsupported' && JSON.stringify(e.missing) === '["services[web].network"]' && e.runtime === 'mock');
  assert.equal(mock._workloads.size, 0, 'nothing created');
  assert.equal((await mgr.spawn(INST, { template: 'db' }, { instanceId: INST })).sidecar.network, 'instance');
  assert.equal(privateHomeSidecarRefusal('mock', 'a', 'db', 'instance'), null);
});

test('the start gate calls it for every Private Home spawn (AppManager.spawnContext), after the home is resolved', () => {
  const src = readFileSync(new URL('../src/app-manager/AppManager.ts', import.meta.url), 'utf8');
  assert.match(src, /if \(home\?\.kind === 'private'\) requirePrivateHomeIsolation\(appId, opts\.manifest, opts\.runtime\.module, this\.runtimes\.list\(\)\);/);
});
