// ARI negative rows, layer 1 (Phase 5b E; D100 §15, §18; ari-gap-review.md
// §5.5): the kernel never turns an unsupported feature into a silent no-op,
// never authorizes by feasibility alone, and never widens what a runtime or an
// installation allows. Against a real AppManager with the reference mock
// provider (no Docker): its instances have no `tools` group, no mounts and no
// host filesystem. (Layer 2, the VM rows, is auraos-e2e `hardening/ari/*`.)
// Run via: node tools/run-tests.mjs --only=core

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CATEGORY_OF_CODE, instanceCapabilities, missingCapabilities, requestNeeds, requirementsOf, moduleFeatures } from '../dist/index.js';
import { AppManager } from '../dist/app-manager/AppManager.js';
import { mockProvider } from './ari-conformance/mock.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'aura-ari-neg-'));
const ROOTFS = join(TMP, 'rootfs');
mkdirSync(ROOTFS);

/** A kernel with the mock registered and one mock instance of `org.mock.app` (as a start would latch it). */
function kernel({ runAs = 'app' } = {}) {
  const dataDir = mkdtempSync(join(TMP, 'mgr-'));
  const mock = mockProvider();
  const mgr = new AppManager({ appsDir: join(dataDir, 'apps'), dataDir, baseRootfs: ROOTFS, toolchainDir: join(dataDir, 'tc'), runtimes: [mock] });
  const id = 'org.mock.app-2';
  mgr['instances'].set(id, { instanceId: id, appId: 'org.mock.app', state: 'resumed', sandbox: 'mock', runtimeSource: 'manifest', port: 4702, pid: null, runAs, ...(runAs === 'app' ? { uid: 200011, gid: 200011 } : {}) });
  const realGet = mgr.registry.getById.bind(mgr.registry);
  mgr.registry.getById = (appId) => (appId === 'org.mock.app' ? { id: appId, name: 'Mock app', version: '1.0.0', tools: ['git'], permissions: ['apps.mount'], scopeId: 'global', appDir: '/x' } : realGet(appId));
  return { mgr, mock, id };
}

test('negative (D100 §15): a tool grant on a runtime without the tools group is `unsupported`, never a silent success', () => {
  const { mgr, id } = kernel();
  const [r] = mgr.applyInstanceTools('org.mock.app');
  assert.equal(r.target.instanceId, id);
  assert.equal(r.state, 'unsupported');
  assert.equal(r.error.code, 'feature-unsupported');
  assert.equal(r.error.category, CATEGORY_OF_CODE['feature-unsupported']);
  assert.deepEqual(mgr.refreshInstanceTools('org.mock.app'), [], 'nothing is reported refreshed');
});

test('negative: a mount, a port expose or host-bound sidecar features on a runtime without them fail closed, by capability', () => {
  const { mgr, id } = kernel();
  const caps = mgr.instanceCapabilities(id);
  assert.deepEqual(missingCapabilities(caps, requestNeeds('mount')), ['mounts']);
  assert.deepEqual(missingCapabilities(caps, requestNeeds('idmap-mount')), ['mounts', 'idmappedMounts']);
  assert.deepEqual(missingCapabilities(caps, requestNeeds('port-expose')), ['portExpose']);
  assert.deepEqual(missingCapabilities(caps, requirementsOf({ id: 'org.mock.app', tools: ['docker'] }).needs), ['hostFilesystem']);
});

test('negative (owner decision 4): features are feasibility only: a supported feature never authorizes; the installation narrows', () => {
  const app = kernel({ runAs: 'app' });
  const root = kernel({ runAs: 'root' });
  const feasible = moduleFeatures(app.mock, {}).find((f) => f.id === 'storage.privateHome');
  assert.equal(feasible.support, 'supported', 'the runtime can do private homes');
  // …but a root instance gets no Private Home boundary and no enforced identity (J.5), whatever the runtime declares.
  assert.equal(app.mgr.instanceCapabilities(app.id).privateHomeSession, true);
  assert.equal(root.mgr.instanceCapabilities(root.id).privateHomeSession, false);
  assert.equal(root.mgr.instanceCapabilities(root.id).identity, 'none');
  assert.deepEqual(missingCapabilities(root.mgr.instanceCapabilities(root.id), requestNeeds('home-private')), ['privateHomeSession']);
  // Narrowing never widens: every capability of the effective set is at most the runtime's.
  const rt = app.mock.capabilities({});
  for (const facts of [{}, { runAs: 'root' }, { runAs: 'app' }, { runAs: 'user' }]) {
    const eff = instanceCapabilities(rt, facts);
    for (const [k, v] of Object.entries(eff)) if (typeof v === 'boolean' && v) assert.equal(rt[k], true, `${k} widened under ${JSON.stringify(facts)}`);
  }
});

test('negative: the instance view reports the runtime as is, its effective capabilities, and nothing for an instance without a runtime', () => {
  const { mgr, id } = kernel();
  const view = mgr.instanceRuntime(id);
  assert.equal(view.id, 'mock');
  assert.equal(view.source, 'manifest');
  assert.equal(view.capabilities.isolation, 'remote');
  assert.equal(mgr.instanceRuntime('no-such-instance'), null);
  assert.equal(mgr.instanceCapabilities('no-such-instance'), null);
});
