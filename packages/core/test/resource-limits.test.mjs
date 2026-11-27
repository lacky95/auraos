// D106: `resources.limits` for build and check workloads, runtime-independent. The container module's one
// mapping (runtimes/container/limits.ts `limitArgs`: the Phase 6 builder's check mode keeps a twin and compares
// it on LIMIT_TABLE below), its validation with the stable code, the default build profile, the feature view
// (container supported for build workloads, PRoot unsupported, the reference mock supported) and the kernel's
// build path failing closed on a runtime that can't enforce limits.
//
// Run via: node tools/run-tests.mjs --only=core
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_BUILD_LIMITS, INVALID_RESOURCE_LIMITS, limitArgs, validateLimits } from '../dist/runtimes/container/limits.js';
import { containerRuntime } from '../dist/runtimes/container/index.js';
import { prootRuntime } from '../dist/runtimes/proot/index.js';
import { ContainerRunner } from '../dist/app-manager/ContainerRunner.js';
import { ProotRunner } from '../dist/app-manager/ProotRunner.js';
import { moduleFeatures } from '../dist/index.js';
import { AppManager } from '../dist/app-manager/AppManager.js';
import { mockProvider } from './ari-conformance/mock.mjs';

const GiB = 1024 * 1024 * 1024;
/** The one table (the release builder's twin compares against it). */
export const LIMIT_TABLE = [
  [{}, []],
  [{ cpus: 4 }, ['--cpus=4']],
  [{ cpus: 0.5 }, ['--cpus=0.5']],
  [{ memoryBytes: 6 * GiB }, [`--memory=${6 * GiB}`, `--memory-swap=${6 * GiB}`]],
  [{ pids: 2048 }, ['--pids-limit=2048']],
  [{ cpus: 2, memoryBytes: 3 * GiB, pids: 512 }, ['--cpus=2', `--memory=${3 * GiB}`, `--memory-swap=${3 * GiB}`, '--pids-limit=512']],
  [{ pids: 64, cpus: 1 }, ['--cpus=1', '--pids-limit=64']],
];

test('limitArgs: one flag set per field, memory without swap beyond it, fixed order', () => {
  for (const [l, args] of LIMIT_TABLE) assert.deepEqual(limitArgs(l), args, JSON.stringify(l));
});

test('limitArgs: positive, finite, integer bytes and pids, known keys only; refused with invalid-resource-limits', () => {
  for (const bad of [null, [], 'x', { cpus: 0 }, { cpus: -1 }, { cpus: NaN }, { cpus: Infinity }, { memoryBytes: 1.5 }, { memoryBytes: 0 },
    { pids: 2.5 }, { pids: '64' }, { swapBytes: 1 }]) {
    assert.throws(() => limitArgs(bad), (e) => e.code === INVALID_RESOURCE_LIMITS && e.code === 'invalid-resource-limits', JSON.stringify(bad));
  }
  validateLimits({ cpus: 1, memoryBytes: undefined });
});

test('the default build profile: the caps the builders always had (2 CPUs, 3 GiB, no swap beyond, 512 pids), frozen', () => {
  assert.deepEqual({ ...DEFAULT_BUILD_LIMITS }, { cpus: 2, memoryBytes: 3 * GiB, pids: 512 });
  assert.equal(Object.isFrozen(DEFAULT_BUILD_LIMITS), true);
});

test('feature view: container supported for build workloads (instances unsupported), PRoot unsupported, the mock supported', () => {
  const stub = { capabilities: (s) => ContainerRunner.prototype.capabilities.call({}, s), getHost: () => null, getPort: () => null };
  const c = moduleFeatures(containerRuntime(stub, {}), {}).find((f) => f.id === 'resources.limits');
  assert.deepEqual([c.support, c.constraints], ['supported', { workloads: 'build', instances: 'unsupported', cpus: 'supported', memoryBytes: 'supported', pids: 'supported' }]);
  const p = prootRuntime({ capabilities: (s) => ProotRunner.prototype.capabilities.call({}, s), getHost: () => null, getPort: () => null, provisionToolsDir: () => '/x' },
    { baseRootfs: '/nonexistent', env: {} });
  assert.deepEqual(moduleFeatures(p, {}).find((f) => f.id === 'resources.limits'),
    { id: 'resources.limits', support: 'unsupported', constraints: { cpus: 'unsupported', memoryBytes: 'unsupported', pids: 'unsupported' } }, 'each limit reported');
  assert.equal(p.build, undefined, 'PRoot builds nothing, so it is never handed limits');
  assert.equal(moduleFeatures(mockProvider(), {}).find((f) => f.id === 'resources.limits').support, 'supported');
});

test('the kernel build path: limits always passed (the default profile); a build runtime without enforced limits is refused (fail closed)', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'aura-limits-'));
  const mgr = new AppManager({ appsDir: join(dataDir, 'apps'), dataDir, baseRootfs: join(dataDir, 'rootfs'), toolchainDir: join(dataDir, 'tc') });
  assert.equal(typeof mgr.builder().build, 'function', 'the container module: supported');
  const container = mgr.runtimes.list().find((m) => m.descriptor.id === 'container');
  const without = { ...container, featureOverrides: () => ({ 'build.execute': { support: 'supported' } }) };
  mgr.runtimes.list = () => [without];
  assert.throws(() => mgr.builder(), (e) => e.code === 'feature-unsupported'
    && JSON.stringify(e.missing) === JSON.stringify(['resources.limits.cpus', 'resources.limits.memoryBytes', 'resources.limits.pids'])
    && typeof e.hint === 'string', 'mandatory: refused naming every limit it cannot enforce');
  // Partial enforcement is a refusal too, and another runtime that enforces them is suggested.
  const partial = { ...container, featureOverrides: () => ({ 'build.execute': { support: 'supported' },
    'resources.limits': { support: 'supported', constraints: { cpus: 'supported', memoryBytes: 'supported', pids: 'unsupported' } } }) };
  mgr.runtimes.list = () => [partial, { ...mockProvider(), descriptor: { ...mockProvider().descriptor } }];
  assert.throws(() => mgr.builder(), (e) => e.code === 'feature-unsupported' && JSON.stringify(e.missing) === '["resources.limits.pids"]'
    && JSON.stringify(e.suggest) === '["mock"]');
  const src = (await import('node:fs')).readFileSync(new URL('../src/app-manager/AppManager.ts', import.meta.url), 'utf8');
  assert.match(src, /builder\(DEFAULT_BUILD_LIMITS\)\.build\(\{[^}]*limits: DEFAULT_BUILD_LIMITS/, 'the build passes the profile');
  assert.match(src, /builder\(DEFAULT_BUILD_LIMITS\)\.provision\(\{[^}]*limits: DEFAULT_BUILD_LIMITS/, 'the install passes the profile');
});
