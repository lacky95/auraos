// Preview instances (Track P, `aura dev patch preview`): a patch workspace runs
// as a separate instance of its app with its own App Host slot, on a copy of
// the app's data; the running app and its data are untouched; stop and the
// idle reaper clean up. AppManager's constructor wires real runners, so (as
// intent-dispatch.test.mjs does) the prototype methods run against a small
// fake `this`.
//
//   node tools/run-tests.mjs --only=core
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AppManager } from '../dist/app-manager/AppManager.js';
import { ROOT_IDENTITY_PROVIDER } from '../dist/identity/types.js';
import { PREVIEW_IDLE_MS, previewTitle } from '../dist/app-manager/preview.js';

const APP = 'io.shop.app';
const put = (p, text) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, text); };

function fakeManager() {
  const root = mkdtempSync(join(tmpdir(), 'aura-preview-'));
  const scope = { id: 'user', dataDir: join(root, 'user'), appsDir: join(root, 'user', 'apps') };
  const manifest = { id: APP, name: 'Shop', sandbox: 'container', instanceMode: 'single', provides: [], appDir: join(scope.appsDir, APP) };
  const spawned = [];
  const homeAsks = [];
  const registered = { interfaces: [], providers: [] };
  const slots = new Map();
  let nextPort = 4100;
  const fake = {
    root, scope, spawned, registered, slots, homeAsks,
    registry: { getById: (id) => (id === APP ? manifest : undefined) },
    scopeRegistry: { getById: () => scope },
    instances: new Map(),
    activities: new Map(),
    nextInstanceNum: new Map(),
    previewIdleSince: new Map(),
    stops: [],
    fsm: { transition() {}, get: () => 'resumed' },
    sidecarParking: { unpark: () => false },
    ports: { allocate: async () => nextPort++, release() {} },
    tokens: { mint: (id, _s, owner) => ({ token: `t-${id}`, nonce: `n-${id}`, owner }) },
    sourceModeOf: () => ({ mode: 'closed' }),
    mounts: { reapply: async () => ({}) },
    portExpose: { reapply: async () => ({}) },
    manifestExposeSpecs: () => [],
    savePoolIds() {},
    interfaces: { registerInstance: (i) => registered.interfaces.push(i.instanceId) },
    providers: { registerInstance: (i) => registered.providers.push(i.instanceId) },
    // Stream R: the resolved runtime (registry.ts); the preview path does not choose it.
    resolveRuntime: async () => ({
      runtime: 'container', source: 'manifest', installationId: null, capabilities: {}, settings: {},
      module: { runner: { spawn: async (id, appId, port, m, ctx) => { spawned.push({ id, ctx }); return 1000 + spawned.length; }, lifecycleStatus: () => null } },
    }),
    // The Phase 5 spawn seams: the resolver is asked (a preview gets its own App Home, never the installed app's).
    homes: { resolve: async (req) => { homeAsks.push(req); return { kind: 'app-global', hostPath: `/h/${req.preview ? 'preview' : 'app'}`, volumeSubpath: 'h', logicalPath: '/home/aura', uid: 0, gid: 0, mode: 0o700 }; } },
    homeRequest: AppManager.prototype.homeRequest,
    poolHomeUser: AppManager.prototype.poolHomeUser,
    instanceHomes: new Map(),
    poolHomes: new Map(),
    seedPrivateHome() {},
    identities: ROOT_IDENTITY_PROVIDER,
    runnerOf: () => ({ callLifecycle: async () => undefined, getHost: () => '127.0.0.1', onExit() {} }),
    // D19: every instance claims its own slot (lifecycle.claimSlot); the label is per slot.
    async claimHostSlot(appId, instanceId) { slots.set(instanceId, `shopx${slots.size + 1}`); },
    getInstancesByApp: (appId) => [...fake.instances.values()].filter((i) => i.appId === appId),
    getActivitiesByInstance: (id) => [...fake.activities.values()].filter((a) => a.parentInstanceId === id),
    async stop(id) { fake.stops.push(id); fake.instances.delete(id); slots.delete(id); },
    forceKill(id) { fake.instances.delete(id); },
    // Stream A: an installation record without runAs: the instances run as root (as before).
    async installationRunAs() { return { installationId: 'inst-shop' }; },
  };
  for (const name of ['spawnInstance', 'spawnContext', 'allocateInstanceId', 'transition', 'upsertInstance', 'defaultInstance',
    'startPreview', 'previewsOf', 'stopPreview', 'reapIdlePreviews', 'previewDataSource']) {
    fake[name] = AppManager.prototype[name].bind(fake);
  }
  // The running app: instance `<appId>` of the owner, with its data.
  fake.instances.set(APP, { instanceId: APP, appId: APP, state: 'resumed', owner: 'default', port: 4000, pid: 1 });
  slots.set(APP, 'shop');
  put(join(scope.dataDir, 'apps', APP, APP, 'orders.json'), '[42]');
  put(join(scope.dataDir, 'apps', APP, APP, '.mnt', 'other', 'x'), 'a mount root');
  // The user's workspace (a prepared tree).
  const workspace = 'aura/workspaces/default/inst-1/2';
  const tree = join(root, 'data', workspace);
  put(join(tree, 'app.manifest.json'), JSON.stringify({ id: APP }));
  return { fake, scope, tree, workspace };
}

test('a preview starts as a separate instance with its own slot and address, on a copy of the data; the real instance and data are unchanged', async () => {
  const { fake, scope, tree, workspace } = fakeManager();
  const id = await fake.startPreview(APP, { appDir: tree, workspace, owner: 'default' });
  assert.equal(id, `${APP}-1`, 'one more instance of the app, even for a single-instance app');
  const inst = fake.instances.get(id);
  assert.deepEqual([inst.preview.workspace, inst.owner], [workspace, 'default']);
  assert.notEqual(inst.port, fake.instances.get(APP).port, 'its own address');
  assert.equal(fake.slots.get(id), 'shopx2');
  assert.notEqual(fake.slots.get(id), fake.slots.get(APP), 'its own App Host slot');

  const { ctx } = fake.spawned[0];
  assert.equal(ctx.appDir, tree, 'it runs the workspace, not the installed tree');
  assert.equal(ctx.preview, workspace, 'labelled on the container');
  assert.equal(ctx.sourceMode, 'open');
  assert.equal(fake.homeAsks[0].preview, true, 'its own App Home, never the installed app\'s (D65)');
  assert.equal(ctx.home.hostPath, '/h/preview');
  const dataDir = join(scope.dataDir, 'apps', APP, id);
  assert.equal(ctx.instanceDataDir, dataDir);
  assert.equal(readFileSync(join(dataDir, 'orders.json'), 'utf-8'), '[42]', 'a copy of the user\'s data');
  assert.equal(existsSync(join(dataDir, '.mnt')), false, 'mount roots are not copied');
  writeFileSync(join(dataDir, 'orders.json'), '[]');
  assert.equal(readFileSync(join(scope.dataDir, 'apps', APP, APP, 'orders.json'), 'utf-8'), '[42]', 'the real data is untouched');
  assert.ok(fake.instances.has(APP), 'the running app is untouched');
  assert.deepEqual(fake.registered, { interfaces: [], providers: [] }, 'never a content provider or an interface');
  assert.deepEqual(fake.previewsOf(APP).map((i) => i.instanceId), [id]);
  assert.deepEqual(fake.previewsOf(APP, 'bob'), []);

  // A second preview of the same app by the same user replaces the first.
  const again = await fake.startPreview(APP, { appDir: tree, workspace, owner: 'default' });
  assert.deepEqual(fake.stops, [id]);
  assert.equal(existsSync(dataDir), false, 'the old copy is gone');
  assert.deepEqual(fake.previewsOf(APP).map((i) => i.instanceId), [again]);
});

test('stop removes the preview and its data copy; idle previews are reaped, ones with a window are not', async () => {
  const { fake, scope, tree, workspace } = fakeManager();
  const a = await fake.startPreview(APP, { appDir: tree, workspace, owner: 'default' });
  await fake.stopPreview(a);
  assert.equal(fake.instances.has(a), false);
  assert.equal(existsSync(join(scope.dataDir, 'apps', APP, a)), false);
  await assert.rejects(fake.stopPreview(APP), /is not a preview/, 'the real instance is never stopped as a preview');

  const idle = await fake.startPreview(APP, { appDir: tree, workspace, owner: 'default' });
  const shown = await fake.startPreview(APP, { appDir: tree, workspace: 'aura/workspaces/bob/inst-1/1', owner: 'bob' });
  fake.activities.set('w1', { activityId: 'w1', parentInstanceId: shown });
  const t0 = 1_000_000;
  assert.deepEqual(await fake.reapIdlePreviews(t0), [], 'idle from now on');
  assert.deepEqual(await fake.reapIdlePreviews(t0 + PREVIEW_IDLE_MS - 1), []);
  assert.deepEqual(await fake.reapIdlePreviews(t0 + PREVIEW_IDLE_MS), [idle]);
  assert.equal(existsSync(join(scope.dataDir, 'apps', APP, idle)), false);
  assert.ok(fake.instances.has(shown), 'a preview with a window stays');
  assert.ok(fake.instances.has(APP));
});

test('a preview\'s window title is marked "Preview"', () => {
  assert.equal(previewTitle(undefined, 'Shop'), 'Preview · Shop');
  assert.equal(previewTitle('Orders', 'Shop'), 'Preview · Orders');
  assert.equal(previewTitle('Preview · Orders', 'Shop'), 'Preview · Orders');
});
