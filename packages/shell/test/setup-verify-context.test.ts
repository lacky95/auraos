// D108 P3v item 1 (shell side): the granted-Context declarations (`liveContextReadDeps`)
// and the composition root's Authorizer (`declared`) read AppManager.effectiveManifest,
// so a profile's Context key and permission count exactly while the engine's view has them
// (a ready setup), and not before or once blocked. The engine is a fake here; the real
// engine's view is verified in core test/setup-verify-runtime.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as core from '@aura/core';
import { liveContextReadDeps } from '../src/lib/appContract.ts';

test('liveContextReadDeps.declared and the Authorizer follow the setup\'s effective view', async () => {
  const appId = 'com.example.power';
  const root = mkdtempSync(join(tmpdir(), 'aura-setup-verify-ctx-'));
  mkdirSync(join(root, 'apps', appId), { recursive: true });
  writeFileSync(join(root, 'apps', appId, 'app.manifest.json'), JSON.stringify({
    id: appId, name: 'Power', version: '1.0.0', auraContract: 1,
    profiles: [{ id: 'power', title: 'Power', overlay: { permissions: ['apps.mount'], context: ['API_KEY'] } }],
  }));
  let ready = false;
  const engine = {
    // The engine's view: the profile's requests only while its setup is ready.
    manifestView: (_id: string, b: { permissions: string[]; context: string[] }) => (ready ? { ...b, permissions: [...b.permissions, 'apps.mount'], context: [...b.context, 'API_KEY'] } : b),
    check: async () => ({ ok: true, effective: null }), knownBlock: () => null, sidecarValues: async () => null, start() {}, stop() {},
  };
  const dataDir = join(root, 'mgr');
  const rootfs = join(root, 'rootfs'); mkdirSync(rootfs);
  const mgr = core.initAppManager({
    appsDir: join(root, 'apps'), dataDir, baseRootfs: rootfs, toolchainDir: join(dataDir, 'tc'),
    setup: () => engine as never,
  });
  const sys = mgr.scopeRegistry.getAll().find((s) => s.id === 'system')!;
  mgr.registry.loadManifestFile(join(root, 'apps', appId, 'app.manifest.json'), sys);

  const deps = liveContextReadDeps({ get: async () => null, resolveEnv: async () => ({}) } as never, () => undefined);
  const principal = { kind: 'instance', appId, instanceId: `${appId}-1` } as unknown as core.Principal;
  const allowed = async () => (await core.getAuthServices().authorizer.authorize(principal, 'apps.mount')).allow;

  assert.equal(deps.declared(appId)?.includes('API_KEY') ?? false, false, 'not ready: the Context key is not declared');
  assert.equal(await allowed(), false, 'not ready: the permission is not declared');
  ready = true;
  assert.equal(deps.declared(appId)?.includes('API_KEY'), true, 'ready: declared');
  assert.equal(await allowed(), true, 'ready: allowed');
  ready = false;   // blocked
  assert.equal(deps.declared(appId)?.includes('API_KEY') ?? false, false);
  assert.equal(await allowed(), false);
});
