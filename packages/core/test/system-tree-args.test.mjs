// Phase 6 L: the system tree of a workload (runtimes/spawn/systemTreeArgs.ts), the one place
// that knows the Developer layout (host checkout binds) and the Normal layout (the release
// inside the data volume, always read-only: D80).
//
//   node tools/run-tests.mjs --only=core
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  inReleaseTree, resolveSystemTree, runningRelease, systemTreeHostPath, systemTreeMount, systemTreeNodeModules,
  systemTreeRel, systemTreeSlice, WORKSPACE_ROOT_FILES,
} from '../dist/runtimes/spawn/systemTreeArgs.js';

const TMP = mkdtempSync(join(tmpdir(), 'aura-systree-'));
const ID = '0.1.0-0123456789ab-cafebabe';

function release(id, { complete = true } = {}) {
  const dir = join(TMP, 'data', 'releases', id);
  mkdirSync(dir, { recursive: true });
  if (complete) writeFileSync(join(dir, '.complete'), '');
  const link = join(TMP, `ws-${id}`);
  try { symlinkSync(dir, link); } catch { /* exists */ }
  return link;
}

const CHECKOUT = { kind: 'checkout', hostRoot: '/srv/aura', nodeModulesVolume: 'p_aura-node-modules' };
const RELEASE = { kind: 'release', releaseId: ID, dataVolume: 'p_aura-app-data' };

test('runningRelease: only a complete release dir named releases/<id> counts', () => {
  assert.deepEqual(runningRelease(release(ID)), { id: ID, root: join(TMP, 'data', 'releases', ID), commit: null }, 'no release.json: the id names it');
  writeFileSync(join(TMP, 'data', 'releases', ID, 'release.json'), JSON.stringify({ commit: 'c0ffee' }));
  assert.equal(runningRelease(release(ID)).commit, 'c0ffee');
  assert.equal(runningRelease(release('0.1.0-incomplete', { complete: false })), null, 'no .complete: never served');
  assert.equal(runningRelease(release('.staging-2026-11-27T10-00-00-000Z')), null, 'a staging dir is never a release');
  const checkout = join(TMP, 'checkout');
  mkdirSync(checkout);
  writeFileSync(join(checkout, '.complete'), '');
  assert.equal(runningRelease(checkout), null, 'a checkout (not under releases/) is the Developer layout');
  assert.equal(runningRelease(join(TMP, 'absent')), null);
});

test('resolveSystemTree: the layout decides, AURA_HOST_WORKSPACE only for the checkout', () => {
  const volumes = { dataVolume: 'dv', nodeModulesVolume: 'nm' };
  assert.deepEqual(resolveSystemTree(volumes, { AURA_WORKSPACE_DIR: join(TMP, 'absent'), AURA_HOST_WORKSPACE: '/srv/aura' }),
    { kind: 'checkout', hostRoot: '/srv/aura', nodeModulesVolume: 'nm', dataVolume: 'dv' });
  assert.deepEqual(resolveSystemTree(volumes, { AURA_WORKSPACE_DIR: join(TMP, 'absent') }),
    { kind: 'checkout', hostRoot: '/workspace', nodeModulesVolume: 'nm', dataVolume: 'dv' }, 'today\'s default');
  assert.deepEqual(resolveSystemTree(volumes, { AURA_WORKSPACE_DIR: release(ID), AURA_HOST_WORKSPACE: '/srv/aura' }),
    { kind: 'release', releaseId: ID, dataVolume: 'dv' });
});

test('systemTreeMount: the checkout keeps today\'s binds; a release is read-only whatever is asked (D80)', () => {
  assert.deepEqual(systemTreeMount(CHECKOUT, 'packages', '/workspace/packages'), ['-v', '/srv/aura/packages:/workspace/packages:ro']);
  assert.deepEqual(systemTreeMount(CHECKOUT, 'apps/a.b', '/workspace/apps/a.b', { ro: false }), ['-v', '/srv/aura/apps/a.b:/workspace/apps/a.b']);
  for (const ro of [true, false, undefined]) {
    assert.deepEqual(systemTreeMount(RELEASE, 'apps/a.b', '/workspace/apps/a.b', { ro }),
      ['--mount', `type=volume,source=p_aura-app-data,target=/workspace/apps/a.b,volume-subpath=releases/${ID}/apps/a.b,readonly`]);
  }
  for (const bad of ['', '/etc', '../x', 'apps/../../etc', 'a//b', './a']) {
    assert.throws(() => systemTreeMount(RELEASE, bad, '/x'), /not a path inside the system tree/, bad);
  }
});

test('node_modules and the slice', () => {
  assert.deepEqual(systemTreeNodeModules(CHECKOUT), ['--mount', 'type=volume,source=p_aura-node-modules,target=/workspace/node_modules,readonly']);
  assert.deepEqual(systemTreeNodeModules(RELEASE), ['--mount', `type=volume,source=p_aura-app-data,target=/workspace/node_modules,volume-subpath=releases/${ID}/node_modules,readonly`]);
  const slice = systemTreeSlice(RELEASE);
  assert.equal(slice.length, 2 * (1 + WORKSPACE_ROOT_FILES.length));
  assert.ok(slice.filter((a) => a !== '--mount').every((a) => a.endsWith(',readonly')));
});

test('systemTreeRel and systemTreeHostPath (the mount helper\'s daemon paths)', () => {
  assert.equal(systemTreeRel('/workspace'), '');
  assert.equal(systemTreeRel('/workspace/apps/a.b'), 'apps/a.b');
  assert.equal(systemTreeRel('/data/x'), null);
  assert.equal(systemTreeRel('/workspacex/y'), null);
  assert.throws(() => systemTreeRel('/workspace/../etc'));
  assert.equal(systemTreeHostPath(CHECKOUT, '/workspace', () => assert.fail()), '/srv/aura');
  assert.equal(systemTreeHostPath(CHECKOUT, '/workspace/apps/a.b', () => assert.fail()), '/srv/aura/apps/a.b');
  assert.equal(systemTreeHostPath(RELEASE, '/workspace/apps/a.b', () => '/var/lib/docker/volumes/v/_data'), `/var/lib/docker/volumes/v/_data/releases/${ID}/apps/a.b`);
  assert.equal(systemTreeHostPath(RELEASE, '/data/apps', () => assert.fail()), null);
});

test('inReleaseTree (D80): /releases, the data volume\'s releases/, and /workspace when it is a release', () => {
  const dataDir = join(TMP, 'data');
  assert.equal(inReleaseTree('/releases/x/apps/a', dataDir), true);
  assert.equal(inReleaseTree(join(dataDir, 'releases', ID, 'apps'), dataDir), true);
  assert.equal(inReleaseTree(join(release(ID), 'apps'), dataDir), true, 'through the /workspace symlink');
  assert.equal(inReleaseTree(join(dataDir, 'scopes', 'users', 'default', 'apps', 'a.b'), dataDir), false);
  assert.equal(inReleaseTree(join(dataDir, 'releasesX'), dataDir), false);
  assert.equal(inReleaseTree('/workspace/apps/x', '/nonexistent-data'), false, 'a checkout is not a release');
});

// The acceptance of 6B.L: the host checkout path is spelled in systemTreeArgs.ts only.
test('no AURA_HOST_WORKSPACE / workspaceRoot in the kernel or runtimes outside systemTreeArgs.ts', () => {
  const src = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const hits = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!p.endsWith('.ts') || p.endsWith('systemTreeArgs.ts')) continue;
      const text = readFileSync(p, 'utf8');
      // nexus/AppSource.ts `workspaceRoot()` is the patch workspaces' root (Track P), another concept: a call, never a field.
      if (/AURA_HOST_WORKSPACE|\.workspaceRoot\b|\bworkspaceRoot\s*[:=]/.test(text)) hits.push(p.slice(src.length + 1));
    }
  };
  walk(src);
  assert.deepEqual(hits, []);
});
