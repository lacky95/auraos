// Phase 5b G: the per-instance runtime gates of the shell (lib/runtimeCaps.ts)
// and the instance view. A route asks for a capability, never compares a
// runtime id: a renamed runtime with the capability passes, a `container`
// that lacks it is refused; the refusal is `capability-missing` with the
// category and the missing list; the instance view carries
// `runtime: {id, source, capabilities}` with the effective capabilities.
//
//   node tools/run-tests.mjs --only=shell
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as core from '@aura/core';
import type { RuntimeCapabilities } from '@aura/core';
import { capabilityRefusal, refusalResponse, runtimeCaps } from '../src/lib/runtimeCaps.ts';
import { publicInstance } from '../src/lib/appResponse.ts';

const CONTAINER: RuntimeCapabilities = {
  isolation: 'namespace', network: 'bridge', appHome: true, privateHomeSession: true, sessionExec: true, identity: 'enforced',
  readOnlyBinds: true, hostFilesystem: true, mounts: true, idmappedMounts: false, portExpose: true, sidecars: true,
  warmPool: true, survivesShellRestart: true, usage: true, gpu: false,
};
const PTRACE: RuntimeCapabilities = { ...CONTAINER, isolation: 'ptrace', network: 'shell-netns', mounts: false, portExpose: false, sidecars: false, sessionExec: false, privateHomeSession: false };

const mgr = (rows: Record<string, { sandbox?: string; caps: RuntimeCapabilities | null }>) => ({
  instanceCapabilities: (id: string) => rows[id]?.caps ?? null,
  getInstance: (id: string) => (rows[id] ? { instanceId: id, sandbox: rows[id]!.sandbox } : undefined) as never,
});

test('5b G: gates read capabilities, not ids: a renamed runtime with mounts passes, one without is refused', async () => {
  const m = mgr({
    'a-1': { sandbox: 'vmrun', caps: CONTAINER },
    'b-1': { sandbox: 'container', caps: { ...CONTAINER, mounts: false } },
    'c-1': { sandbox: 'proot', caps: PTRACE },
  });
  assert.equal(capabilityRefusal('a-1', core.requestNeeds('mount'), 'cross-app mounts', m), null);
  for (const id of ['b-1', 'c-1']) {
    const r = capabilityRefusal(id, core.requestNeeds('mount'), 'cross-app mounts', m)!;
    assert.equal(r.status, 409);
    const body = await r.json() as Record<string, unknown>;
    assert.equal(body['code'], 'capability-missing');
    assert.equal(body['category'], 'unsupported-feature');
    assert.deepEqual(body['missing'], ['mounts']);
    assert.match(String(body['error']), /can't do cross-app mounts \(missing: mounts\)/);
  }
  assert.ok(capabilityRefusal('c-1', core.requestNeeds('port-expose'), "'into' exposing", m));
  assert.ok(capabilityRefusal('c-1', core.requestNeeds('sidecars'), 'OS sidecars', m));
  // No runtime yet (not started): left to the operation, which reports it.
  assert.equal(capabilityRefusal('nope', core.requestNeeds('mount'), 'x', mgr({})), null);
  assert.equal(runtimeCaps('nope', mgr({})), null);
});

test('5b G: refusalResponse maps a runtime refusal (D80 idmappedMounts) to 409 and leaves other errors alone', async () => {
  const r = refusalResponse(new core.RuntimeCapabilityError('container', ['idmappedMounts'], 'refusing a writable mount: no idmapped mounts'))!;
  assert.equal(r.status, 409);
  assert.deepEqual(await r.json(), { error: 'refusing a writable mount: no idmapped mounts', code: 'capability-missing', category: 'unsupported-feature', runtime: 'container', missing: ['idmappedMounts'] });
  assert.equal(refusalResponse(new Error('already mounted')), null);
});

test('5b G: effective capabilities narrow a root instance (J.5) and never widen', () => {
  assert.equal(core.instanceCapabilities(CONTAINER, { runAs: 'app' }).identity, 'enforced');
  assert.equal(core.instanceCapabilities(CONTAINER, { runAs: 'user' }).privateHomeSession, true);
  const root = core.instanceCapabilities(CONTAINER, { runAs: 'root' });
  assert.equal(root.identity, 'none');
  assert.equal(root.privateHomeSession, false);
  assert.deepEqual(core.instanceCapabilities(CONTAINER, {}), root, 'absent runAs is root (a record from before 5-apps)');
  assert.equal(core.instanceCapabilities(PTRACE, { runAs: 'app' }).mounts, false);
});

test('5b G: the instance view carries runtime {id, source, capabilities}; owner stays server-side', () => {
  const inst = { instanceId: 'a-1', appId: 'io.a', state: 'resumed', sandbox: 'container', owner: 'default' } as never;
  const view = publicInstance(inst, { instanceRuntime: () => ({ id: 'container', source: 'manifest', capabilities: CONTAINER }) });
  assert.deepEqual(view.runtime, { id: 'container', source: 'manifest', capabilities: CONTAINER });
  assert.ok(!('owner' in view));
  assert.ok(!('runtime' in publicInstance(inst)), 'without the manager: as before');
});

test('5b G: no shell route or lib compares a runtime id any more (the replaced sites)', () => {
  const sites = [
    '../src/pages/api/instances/[instanceId]/mounts.ts', '../src/pages/api/instances/[instanceId]/ports.ts',
    '../src/lib/appSource.ts', '../src/lib/instanceAuth.ts', '../src/lib/appContract.ts',
  ];
  for (const rel of sites) {
    const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
    assert.doesNotMatch(src, /sandbox\s*(===|!==)\s*'(container|proot)'/, rel);
    assert.doesNotMatch(src, /`aura-\$\{/, rel);
  }
});
