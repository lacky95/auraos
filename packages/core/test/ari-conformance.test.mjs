// The ARI conformance kit (layer 1) against every runtime module this
// release has, in process: the built-in container and PRoot modules over
// recording runner stubs (no Docker, no processes) and a test-only fake that
// registers with no AppManager or shell edit (plan §4.2).
// Run via: node tools/run-tests.mjs --only=core

import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeRuntime } from './ari-conformance/kit.mjs';
import { HEALTHY, runnerEndpoint } from '../dist/index.js';
import { containerRuntime } from '../dist/runtimes/builtins/container.js';
import { prootRuntime } from '../dist/runtimes/builtins/proot.js';
import { ContainerRunner } from '../dist/app-manager/ContainerRunner.js';
import { ProotRunner } from '../dist/app-manager/ProotRunner.js';

const TMP = mkdtempSync(join(tmpdir(), 'aura-ari-kit-'));
const ROOTFS = join(TMP, 'rootfs');
mkdirSync(ROOTFS);

/** A runner stub: the real capability declaration, a recorded endpoint for `known-1`. */
const stub = (capabilities, host) => ({
  capabilities,
  getHost: (id) => (id === 'known-1' ? host : null),
  getPort: (id) => (id === 'known-1' ? 4123 : null),
});

describeRuntime('container', () => containerRuntime(stub((s) => ContainerRunner.prototype.capabilities.call({}, s), 'aura-known-1')),
  { instance: 'known-1' });
describeRuntime('proot', () => prootRuntime(stub((s) => ProotRunner.prototype.capabilities.call({}, s), '127.0.0.1'),
  { baseRootfs: ROOTFS, env: { AURA_USE_PROOT: 'true' } }),
{ instance: 'known-1', settings: [{ placement: 'master' }, { placement: 'pool' }] });

const FAKE_CAPS = Object.freeze({
  isolation: 'vm', network: 'remote', appHome: true, privateHomeSession: false, sessionExec: false, identity: 'emulated',
  readOnlyBinds: true, hostFilesystem: false, mounts: false, idmappedMounts: false, portExpose: false, sidecars: false,
  warmPool: false, survivesShellRestart: false, usage: false, gpu: false,
});
describeRuntime('fake', () => {
  const runner = stub(() => FAKE_CAPS, 'fake.example');
  return {
    descriptor: { id: 'fake', version: '0.1.0', ari: 1, title: 'Fake', description: 'test only', builtIn: false, settingsVersion: 1,
      settingsSchema: { type: 'object', properties: {} } },
    runner, capabilities: () => ({ ...FAKE_CAPS }), health: () => HEALTHY, endpoint: (id) => runnerEndpoint(runner, id),
  };
}, { instance: 'known-1' });
