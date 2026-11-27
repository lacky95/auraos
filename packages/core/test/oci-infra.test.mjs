// OCI artifact retrieval is OS infrastructure (owner decision 2026-11-27):
// `oras` reaches the throwaway builder of a fresh Nexus install from the image,
// with no capability installed, and runtime-installed capabilities come back
// after the shell container is recreated (toolchain image layer lost, the
// volume mirror kept).
//
//   node tools/run-tests.mjs --only=core
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppManager } from '../dist/app-manager/AppManager.js';
import { BUILDER_TOOLS, provisionBuilderTools } from '../dist/app-manager/provisioning.js';
import { IMAGE_TOOLS, MY_TOOLS_PATH, healImageTools, toolchainMirrorBin } from '../dist/app-manager/tool-provision.js';

const TMP = mkdtempSync(join(tmpdir(), 'aura-oci-infra-'));
const ROOTFS = join(TMP, 'rootfs');
mkdirSync(ROOTFS);

const CAPS = { isolation: 'vm' };
const fakeRuntime = {
  descriptor: { id: 'fake', title: 'Fake', description: 'test', builtIn: false, settingsSchema: { type: 'object', properties: {} } },
  runner: { capabilities: () => CAPS }, capabilities: () => CAPS, unavailable: () => null,
};

/** A shell "container": a fresh image-layer toolchain dir over a persistent data volume. */
function shell(dataDir) {
  const toolchainDir = mkdtempSync(join(TMP, 'tc-'));
  mkdirSync(join(toolchainDir, 'bin'), { recursive: true });
  const mgr = new AppManager({ appsDir: join(dataDir, 'apps'), dataDir, baseRootfs: ROOTFS, toolchainDir, runtimes: [fakeRuntime] });
  return { toolchainDir, mgr };
}

function exe(path, body) {
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

test('oras is image infrastructure the builder gets', () => {
  assert.ok(IMAGE_TOOLS.includes('oras'));
  assert.deepEqual([...BUILDER_TOOLS], ['oras'], 'the builder gets the OCI retrieval tool and nothing an app was granted');
});

test('a fresh Nexus install: the builder finds oras with no capability installed (empty capabilities.json, oras only in the image)', () => {
  const dataDir = mkdtempSync(join(TMP, 'data-'));
  mkdirSync(join(dataDir, 'aura', 'state'), { recursive: true });
  writeFileSync(join(dataDir, 'aura', 'state', 'capabilities.json'), JSON.stringify({ capabilities: {}, services: {} }));
  const imageBin = mkdtempSync(join(TMP, 'image-bin-'));
  exe(join(imageBin, 'oras'), 'echo oras');
  exe(join(imageBin, 'docker'), 'echo docker');

  const { toolchainDir, mgr } = shell(dataDir);
  // What AppManager.init does, in its order: heal from the image, then mirror.
  assert.deepEqual(healImageTools(toolchainDir, imageBin).sort(), ['docker', 'oras']);
  mgr.syncToolchainMirror();
  assert.ok(existsSync(join(toolchainMirrorBin(dataDir), 'oras')), 'oras reached the volume mirror');

  const name = 'aura-provision-io.example.hello';
  const tools = provisionBuilderTools({ dataDir, appDataVolume: 'aura-app-data', name });
  assert.deepEqual(tools.linked, ['oras']);
  assert.deepEqual(tools.missing, []);
  assert.ok(existsSync(join(tools.dir, 'oras')));
  assert.ok(!existsSync(join(tools.dir, 'docker')), 'no other toolchain binary reaches the builder');
  assert.equal(statSync(join(tools.dir, 'oras')).ino, statSync(join(toolchainMirrorBin(dataDir), 'oras')).ino, 'hardlinked from the mirror');
  const args = tools.args.join(' ');
  assert.match(args, new RegExp(`target=${MY_TOOLS_PATH},volume-subpath=aura/runtime/${name}/tools,readonly`));
  assert.ok(tools.args.includes(`PATH=${MY_TOOLS_PATH}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`));
  assert.ok(!args.includes('/aura/all-tools'), 'hardlink mode: the whole store is not mounted');
  // The state file was never consulted or changed.
  assert.deepEqual(JSON.parse(readFileSync(join(dataDir, 'aura', 'state', 'capabilities.json'), 'utf-8')).capabilities, {});
  tools.release();
  assert.ok(!existsSync(join(dataDir, 'aura', 'runtime', name)), 'the builder tools dir goes with the run');
});

test('the heal never overwrites a toolchain entry and skips what the image lacks', () => {
  const tc = mkdtempSync(join(TMP, 'tc-heal-'));
  mkdirSync(join(tc, 'bin'));
  exe(join(tc, 'bin', 'oras'), 'echo newer');
  const imageBin = mkdtempSync(join(TMP, 'image-bin-'));
  exe(join(imageBin, 'oras'), 'echo image');
  assert.deepEqual(healImageTools(tc, imageBin), []);
  assert.match(readFileSync(join(tc, 'bin', 'oras'), 'utf-8'), /newer/);
});

test('cap persistence across shell recreation: the mirror on the volume restores the toolchain before any provisioning', () => {
  const dataDir = mkdtempSync(join(TMP, 'data-'));
  const imageBin = mkdtempSync(join(TMP, 'image-bin-'));
  exe(join(imageBin, 'oras'), 'echo oras');

  // Boot 1: an image toolchain, then a runtime `cap install` (both stores, as capabilityInstall.ts writes them).
  const one = shell(dataDir);
  healImageTools(one.toolchainDir, imageBin);
  one.mgr.syncToolchainMirror();
  exe(join(one.toolchainDir, 'bin', 'jq'), 'echo jq');
  exe(join(toolchainMirrorBin(dataDir), 'jq'), 'echo jq');

  // Recreate: a new container, its image-layer toolchain without jq (and, as in the development image, without oras).
  const two = shell(dataDir);
  assert.ok(!existsSync(join(two.toolchainDir, 'bin', 'jq')));
  healImageTools(two.toolchainDir, imageBin);
  two.mgr.syncToolchainMirror();
  assert.ok(existsSync(join(two.toolchainDir, 'bin', 'jq')), 'the installed cap is back in the toolchain');
  assert.ok(existsSync(join(two.toolchainDir, 'bin', 'oras')));
  const tools = provisionBuilderTools({ dataDir, appDataVolume: 'aura-app-data', name: 'aura-provision-io.example.b' });
  assert.deepEqual(tools.linked, ['oras']);
  tools.release();
});

test('a toolchain without oras anywhere: the builder reports it missing instead of an empty success', () => {
  const dataDir = mkdtempSync(join(TMP, 'data-'));
  const { toolchainDir, mgr } = shell(dataDir);
  exe(join(toolchainDir, 'bin', 'git'), 'echo git');
  healImageTools(toolchainDir, mkdtempSync(join(TMP, 'empty-image-')));
  mgr.syncToolchainMirror();
  const tools = provisionBuilderTools({ dataDir, appDataVolume: 'aura-app-data', name: 'aura-provision-io.example.c' });
  assert.deepEqual(tools.linked, []);
  assert.deepEqual(tools.missing, ['oras']);
  tools.release();
});
