// Capability install state agrees with what the toolchain holds (owner
// decision 2026-11-27): persisted at once after a successful install, restored
// with the binaries after a shell recreate, and a record whose binary is gone
// is dropped instead of reported available.
//
//   node tools/run-tests.mjs --only=shell
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as core from '@aura/core';
import type { CapabilityDefinition } from '@aura/core';
import { getCapabilities, reconcileCapabilities, type CapabilityDeps } from '../src/lib/capabilities.ts';
import { reconcileCapabilityState, type State } from '../src/lib/capabilityInstall.ts';

const TMP = mkdtempSync(join(tmpdir(), 'aura-cap-state-'));
const exe = (path: string) => writeFileSync(path, '#!/bin/sh\n', { mode: 0o755 });

const REGISTRY: Record<string, CapabilityDefinition> = core.parseCapabilityRegistry({
  capabilities: {
    aura: { source: 'builtin', binary: 'aura' },
    rg: { source: 'apt', package: 'ripgrep', binary: 'rg' },
    jq: { source: 'apt', package: 'jq', binary: 'jq' },
    ghost: { source: 'apt', package: 'ghost', binary: 'ghost' },
    oras: { source: 'steps', binary: 'oras', binary_path: '/usr/local/bin/oras', steps: [{ mkdir: ['/usr/local/bin/oras-test'] }] },
  },
});

function dirs() {
  const tc = mkdtempSync(join(TMP, 'tc-'));
  const mirror = mkdtempSync(join(TMP, 'mirror-'));
  return { tc, mirror };
}

test('reconcile: a stale "installed" record with no binary anywhere is dropped; an available unrecorded cap is recorded', () => {
  const { tc, mirror } = dirs();
  exe(join(tc, 'rg'));      // installed, binary named differently from the cap
  exe(join(mirror, 'jq'));  // only in the mirror (the toolchain lost it)
  exe(join(tc, 'oras'));    // the image's infrastructure tool, never `cap install`ed
  exe(join(tc, 'aura'));
  const state: State = {
    capabilities: {
      rg: { installed: true, installedAt: 'then', version: '14' },
      jq: { installed: true, installedAt: 'then', version: '1.6' },
      ghost: { installed: true, installedAt: 'then', version: '1' },
    },
    services: { keep: { running: false } },
  };
  const now = new Date('2026-11-27T10:00:00Z');
  assert.equal(reconcileCapabilityState(state, REGISTRY, [tc, mirror], now), true);
  assert.deepEqual(Object.keys(state.capabilities).sort(), ['jq', 'oras', 'rg']);
  assert.equal(state.capabilities['rg']?.version, '14', 'a consistent record is kept as it was');
  assert.deepEqual(state.capabilities['oras'], { installed: true, installedAt: now.toISOString(), version: null });
  assert.equal(state.capabilities['aura'], undefined, 'builtins are reported installed without a record');
  assert.deepEqual(state.services, { keep: { running: false } }, 'services are not touched');
  assert.equal(reconcileCapabilityState(state, REGISTRY, [tc, mirror], now), false, 'idempotent');
});

test('cap persistence across shell recreation: after init the binary is back and the state agrees with it', () => {
  const dataDir = mkdtempSync(join(TMP, 'data-'));
  const mirror = core.toolchainMirrorBin(dataDir);
  mkdirSync(mirror, { recursive: true });
  exe(join(mirror, 'jq'));  // `cap install jq` wrote both stores before the recreate
  const state: State = {
    capabilities: {
      jq: { installed: true, installedAt: 'then', version: '1.6' },
      ghost: { installed: true, installedAt: 'then', version: '1' },
    },
    services: {},
  };
  // The recreated container: an image-layer toolchain without jq.
  const toolchainDir = mkdtempSync(join(TMP, 'tc-'));
  mkdirSync(join(toolchainDir, 'bin'));
  const baseRootfs = mkdtempSync(join(TMP, 'rootfs-'));
  const caps = { isolation: 'vm' };
  const fake = {
    descriptor: { id: 'fake', title: 'Fake', description: 'test', builtIn: false, settingsSchema: { type: 'object', properties: {} } },
    runner: { capabilities: () => caps }, capabilities: () => caps, unavailable: () => null,
  };
  const mgr = new core.AppManager({ appsDir: join(dataDir, 'apps'), dataDir, baseRootfs, toolchainDir, runtimes: [fake as never] });
  mgr.syncToolchainMirror();
  const bin = join(toolchainDir, 'bin');
  assert.ok(existsSync(join(bin, 'jq')), 'restored from the volume mirror');
  reconcileCapabilityState(state, REGISTRY, [bin, mirror]);
  assert.equal(state.capabilities['jq']?.installed, true);
  assert.equal(state.capabilities['ghost'], undefined, 'not reported available');
});

function deps(over: Partial<CapabilityDeps['installer']>, log: string[]): CapabilityDeps {
  return {
    ownerAction: async () => { throw new Error('not used'); },
    audit: async () => undefined,
    run: () => { throw new Error('not used'); },
    releaseRegistry: () => REGISTRY,
    store: { list: async () => ({}), put: async () => { throw new Error('not used'); }, remove: async () => { throw new Error('not used'); } },
    installer: {
      install: async () => { throw new Error('not used'); },
      remove: () => undefined,
      loadState: () => { log.push('load'); return { capabilities: {}, services: {} }; },
      saveState: () => { log.push('save'); },
      ...over,
    },
    refresh: () => [],
  } as CapabilityDeps;
}

test('GET reports the reconciled state; boot reconciles with the resolved registry', async () => {
  const log: string[] = [];
  let seen: string[] = [];
  const reconcile = (registry: Record<string, CapabilityDefinition>): State => {
    seen = Object.keys(registry).sort();
    log.push('reconcile');
    return { capabilities: { oras: { installed: true, installedAt: 'now', version: null } }, services: {} };
  };
  const r = await getCapabilities(deps({ reconcile }, log));
  const body = await r.json() as { state: State };
  assert.equal(body.state.capabilities['oras']?.installed, true);
  assert.deepEqual(seen, ['aura', 'ghost', 'jq', 'oras', 'rg']);
  assert.deepEqual(log, ['reconcile'], 'GET does not read the unreconciled file');

  log.length = 0;
  await reconcileCapabilities(deps({ reconcile }, log));
  assert.deepEqual(log, ['reconcile']);
  // Never throws at boot.
  await reconcileCapabilities(deps({ reconcile: () => { throw new Error('disk full'); } }, log));
});
