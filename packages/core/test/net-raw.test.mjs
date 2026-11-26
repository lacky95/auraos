// D88 S1: every container the OS creates drops NET_RAW, so no container on a
// shell network can forge (ARP-spoof) another's address and be named by D28.
//
//   pnpm --filter @aura/core build && node --test test/net-raw.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rawSocketArgs, rawSocketsRequested } from '../dist/app-manager/spawn/networkArgs.js';
import { ContainerRunner } from '../dist/app-manager/ContainerRunner.js';

test('D88 S1: every OS container drops NET_RAW; only a privileged or NET_RAW template keeps it', () => {
  assert.deepEqual(rawSocketArgs(), ['--cap-drop', 'NET_RAW']);
  assert.deepEqual(rawSocketArgs({ capabilities: ['SYS_ADMIN'] }), ['--cap-drop', 'NET_RAW']);
  for (const spec of [{ privileged: true }, { capabilities: ['NET_RAW'] }, { capabilities: ['cap_net_raw'] }, { capabilities: ['ALL'] }]) {
    assert.equal(rawSocketsRequested(spec), true, JSON.stringify(spec));
    assert.deepEqual(rawSocketArgs(spec), [], JSON.stringify(spec));
  }
});

test('D88 S1: an app container (Terminal included) is run with --cap-drop NET_RAW on the shared network', () => {
  const root = mkdtempSync(join(tmpdir(), 'aura-netraw-'));
  try {
    const dataDir = join(root, 'data');
    const appDir = join(dataDir, 'scopes/users/default/apps/com.aura.terminal');
    const instDir = join(dataDir, 'scopes/users/default/apps/com.aura.terminal/com.aura.terminal-1');
    mkdirSync(instDir, { recursive: true });
    writeFileSync(join(appDir, 'server.mjs'), '');
    const runner = new ContainerRunner({ baseRootfs: root, toolchainDir: join(root, 'tc'), appsDir: join(root, 'apps'), dataDir, osApiBase: 'http://aura-shell:3000' });
    Object.assign(runner, { appDataVolume: 'aura_aura-app-data', nodeModulesVolume: 'aura_aura-node-modules' });
    const manifest = { id: 'com.aura.terminal', entrypoint: 'server.mjs', tools: ['*'], sandbox: 'container' };
    const args = runner.buildDockerArgs('com.aura.terminal-1', 'com.aura.terminal', 4000, manifest, 'aura-com.aura.terminal-1',
      { appDir, instanceDataDir: instDir, home: { kind: 'private', hostPath: '/x', volumeSubpath: 'aura/home/default', logicalPath: '/home/aura', uid: 1000, gid: 1000, mode: 0o700 } }, {}, []);
    assert.equal(args[0], 'run');
    const i = args.indexOf('--cap-drop');
    assert.ok(i > 0, 'has --cap-drop');
    assert.equal(args[i + 1], 'NET_RAW');
    assert.ok(i < args.indexOf('aura-base') || !args.includes('aura-base'), 'a docker flag, before the image');
    assert.equal(args.filter((a) => a === '--cap-add').length, 0, 'an app container never adds a capability back');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
