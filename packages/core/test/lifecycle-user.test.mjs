// D46: lifecycle hooks carry the user; a warm-pool member is owned by the
// user it is claimed for and told so with `onAssign`.
// Like intent-dispatch.test.mjs, AppManager's prototype methods run against a
// small fake `this` that records lifecycle calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppManager } from '../dist/app-manager/AppManager.js';
import { IntentResolver } from '../dist/app-manager/IntentResolver.js';
import { DEFAULT_OWNER_ID } from '../dist/auth/identityContracts.js';

const VIEW = 'aura.intent.action.VIEW';
const filter = { action: VIEW, category: [], dataMime: [], dataScheme: [], priority: 0 };
const manifest = (id, over = {}) => ({
  id, componentType: 'app', activityMode: 'none', instanceMode: 'single', maxActivitiesPerInstance: 0,
  backgroundService: false, intentFilters: [filter], warmPool: 0, ...over,
});

function fake(manifests, instances = []) {
  const byId = new Map(manifests.map((m) => [m.id, m]));
  const intents = new IntentResolver();
  intents.reload(manifests);
  const calls = [];
  const f = {
    calls, intents, starts: [],
    registry: { getById: (id) => byId.get(id) },
    instances: new Map(instances.map((i) => [i.instanceId, { inPool: false, state: 'resumed', sandbox: 'proot', pid: process.pid, ...i }])),
    activities: new Map(),
    nextActivityNum: new Map(),
    isEnabled: () => true,
    savePoolIds() {},
    // D65: each member's home was recorded at its spawn ('' = a global App Home).
    poolHomes: new Map(instances.filter((i) => i.inPool).map((i) => [i.instanceId, ''])),
    recycling: new Set(),
    scheduleRefill() {},
    providers: { registerInstance() {} },
    interfaces: { registerInstance() {} },
    getInstancesByApp: (appId) => [...f.instances.values()].filter((i) => i.appId === appId),
    getActivitiesByInstance: () => [],
    async start(appId, opts) { f.starts.push([appId, opts]); return f.getInstancesByApp(appId)[0].instanceId; },
    // Stream R: liveness through the runtime's capability (PRoot: the shell's own pid).
    runtimeCapabilitiesOf: () => ({ survivesShellRestart: false }),
    runnerOf: () => ({
      isRunning: () => true,
      async callOptionalLifecycle(instanceId, hook, body) { calls.push({ instanceId, hook, body }); return { ok: true }; },
    }),
  };
  for (const name of ['startIntent', 'pickIntentInstance', 'openActivity', 'openActivityAndReport', 'claimFromPool', 'notifyAssigned', 'launch', 'instanceAlive']) {
    f[name] = AppManager.prototype[name].bind(f);
  }
  return f;
}

test('onIntent carries the verified caller\'s user', async () => {
  const m = fake([manifest('a.viewer')], [{ instanceId: 'a.viewer', appId: 'a.viewer', owner: 'u-owner' }]);
  await m.startIntent({ action: VIEW }, { userId: 'u-caller' });
  assert.equal(m.calls[0].hook, 'onIntent');
  assert.equal(m.calls[0].body.userId, 'u-caller');
});

test('without a caller user the hook gets the instance\'s owner', async () => {
  const m = fake([manifest('a.viewer')], [{ instanceId: 'a.viewer', appId: 'a.viewer', owner: 'u-owner' }]);
  await m.startIntent({ action: VIEW });
  assert.equal(m.calls[0].body.userId, 'u-owner');
});

test('a fresh start for an intent is the caller\'s', async () => {
  const m = fake([manifest('a.viewer')], [{ instanceId: 'a.viewer', appId: 'a.viewer', state: 'resumed', owner: 'u-owner' }]);
  m.instances.clear();
  m.start = async (appId, opts) => { m.starts.push([appId, opts]); m.instances.set(appId, { instanceId: appId, appId, state: 'resumed', owner: opts.userId }); return appId; };
  await m.startIntent({ action: VIEW }, { userId: 'u-caller' });
  assert.deepEqual(m.starts, [['a.viewer', { userId: 'u-caller' }]]);
});

test('onActivityCreate carries the user', async () => {
  const m = fake([manifest('a.multi', { activityMode: 'multi', instanceMode: 'multi' })],
    [{ instanceId: 'a.multi-1', appId: 'a.multi', owner: 'u-owner' }]);
  m.allocateActivityId = () => 'a.multi-1#a1';
  m.assertMayFly = () => {};
  m.activityNum = () => 1;
  try { await m.openActivity('a.multi-1', { x: 1 }, { userId: 'u-caller' }); } catch { /* the window bookkeeping is not faked */ }
  const call = m.calls.find((c) => c.hook === 'onActivityCreate');
  assert.ok(call, 'hook called');
  assert.equal(call.body.userId, 'u-caller');
});

test('a warm-pool claim makes the instance the user\'s and calls onAssign', async () => {
  const m = fake([manifest('a.pool', { instanceMode: 'multi', warmPool: 1 })],
    [{ instanceId: 'a.pool-1', appId: 'a.pool', inPool: true }]);
  const inst = m.claimFromPool('a.pool', 'u-caller');
  assert.equal(inst.instanceId, 'a.pool-1');
  assert.equal(inst.inPool, false);
  assert.equal(inst.owner, 'u-caller');
  await m.notifyAssigned(inst);
  assert.deepEqual(m.calls, [{ instanceId: 'a.pool-1', hook: 'onAssign', body: { userId: 'u-caller' } }]);
});

test('launch() claims from the pool for the user and assigns before returning', async () => {
  const m = fake([manifest('a.pool', { instanceMode: 'multi', warmPool: 1 })],
    [{ instanceId: 'a.pool-1', appId: 'a.pool', inPool: true }]);
  assert.equal(await m.launch('a.pool', 'u-caller'), 'a.pool-1');
  assert.equal(m.instances.get('a.pool-1').owner, 'u-caller');
  assert.deepEqual(m.calls.map((c) => [c.hook, c.body.userId]), [['onAssign', 'u-caller']]);
});

test('the OS itself (no user) claims a pool member for the local owner', () => {
  const m = fake([manifest('a.pool', { instanceMode: 'multi', warmPool: 1 })],
    [{ instanceId: 'a.pool-1', appId: 'a.pool', inPool: true, owner: undefined }]);
  assert.equal(m.claimFromPool('a.pool').owner, DEFAULT_OWNER_ID);
});

test('an activity opened on a pool member claims it for the user, with onAssign', async () => {
  const m = fake([manifest('a.multi', { activityMode: 'multi', instanceMode: 'multi', warmPool: 1 })],
    [{ instanceId: 'a.multi-1', appId: 'a.multi', inPool: true }]);
  m.allocateActivityId = () => 'a.multi-1#a1';
  try { await m.openActivity('a.multi-1', undefined, { userId: 'u-caller' }); } catch { /* window bookkeeping not faked */ }
  assert.equal(m.instances.get('a.multi-1').owner, 'u-caller');
  assert.deepEqual(m.calls.slice(0, 2).map((c) => [c.hook, c.body.userId]), [['onAssign', 'u-caller'], ['onActivityCreate', 'u-caller']]);
});
