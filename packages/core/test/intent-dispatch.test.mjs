// Tests for AppManager.startIntent delivery: explicit vs implicit intents,
// and that EVERY handler shape (multi-activity app, activityMode 'none' app,
// service) receives the whole intent object.
// Run via:
//   pnpm --filter @aura/core build
//   node --test packages/core/test/intent-dispatch.test.mjs
//
// AppManager's constructor wires real runners/registries, so these tests call
// the prototype methods against a small fake `this` that records lifecycle
// calls instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AppManager } from '../dist/app-manager/AppManager.js';
import { IntentResolver, intentPayload } from '../dist/app-manager/IntentResolver.js';

const VIEW = 'aura.intent.action.VIEW';
const filter = (over = {}) => ({ action: VIEW, category: [], dataMime: [], dataScheme: [], priority: 0, ...over });

function manifest(id, over = {}) {
  return {
    id, componentType: 'app', activityMode: 'none', instanceMode: 'single',
    maxActivitiesPerInstance: 0, backgroundService: false, intentFilters: [], ...over,
  };
}

/**
 * Fake AppManager. `running` = app ids that already have a live instance
 * (instance id = app id, like single-instance apps). `hookReplies` maps a
 * lifecycle hook to what the app answers (default `{ ok: true }`; null = 404).
 */
function fakeManager(manifests, { running = [], hookReplies = {} } = {}) {
  const byId = new Map(manifests.map((m) => [m.id, m]));
  const intents = new IntentResolver();
  intents.reload(manifests);
  const live = new Set(running);
  const calls = [];
  const fake = {
    calls,
    starts: [],
    intents,
    registry: { getById: (id) => byId.get(id) },
    instances: new Map(),
    activities: new Map(),
    nextActivityNum: new Map(),
    getInstancesByApp: (appId) => (live.has(appId) ? [{ instanceId: appId, appId, state: 'resumed' }] : []),
    getActivitiesByInstance: () => [],
    async start(appId) {
      fake.starts.push(['start', appId]);
      live.add(appId);
      fake.instances.set(appId, { instanceId: appId, appId, inPool: false, state: 'resumed' });
      return appId;
    },
    async startService(appId) {
      fake.starts.push(['startService', appId]);
      live.add(appId);
      fake.instances.set(appId, { instanceId: appId, appId, inPool: false, state: 'resumed' });
      return appId;
    },
    runnerOf: () => ({
      async callOptionalLifecycle(instanceId, hook, body) {
        calls.push({ instanceId, hook, body });
        return hook in hookReplies ? hookReplies[hook] : { ok: true };
      },
    }),
  };
  for (const name of ['startIntent', 'openActivity', 'openActivityAndReport']) {
    fake[name] = AppManager.prototype[name].bind(fake);
  }
  return fake;
}

test('intentPayload: keeps set fields only, never null/undefined keys', () => {
  assert.deepEqual(intentPayload({ action: VIEW }), { action: VIEW });
  assert.deepEqual(
    intentPayload({ action: VIEW, appId: 'a', category: [], type: 'text/plain', uri: 'x:y', extras: { k: 1 } }),
    { action: VIEW, appId: 'a', type: 'text/plain', uri: 'x:y', extras: { k: 1 } },
  );
});

test("implicit intent → activityMode 'none' app gets onIntent with the whole intent", async () => {
  const m = fakeManager([manifest('a.viewer', { intentFilters: [filter()] })]);
  const intent = { action: VIEW, uri: 'https://x.test', category: ['aura.intent.category.DEFAULT'], extras: { url: 'https://x.test' } };
  const res = await m.startIntent(intent);
  assert.deepEqual(res, { kind: 'started', appId: 'a.viewer', instanceId: 'a.viewer', intentDelivered: true });
  assert.deepEqual(m.calls, [{
    instanceId: 'a.viewer', hook: 'onIntent',
    body: { intent: { action: VIEW, category: ['aura.intent.category.DEFAULT'], uri: 'https://x.test', extras: { url: 'https://x.test' } }, newInstance: true },
  }]);
});

test('already-running single instance still receives the intent (onNewIntent), newInstance=false', async () => {
  const m = fakeManager([manifest('a.viewer', { intentFilters: [filter()] })], { running: ['a.viewer'] });
  await m.startIntent({ action: VIEW, extras: { n: 2 } });
  assert.equal(m.calls.length, 1);
  assert.equal(m.calls[0].hook, 'onIntent');
  assert.equal(m.calls[0].body.newInstance, false);
  assert.deepEqual(m.calls[0].body.intent.extras, { n: 2 });
});

test('service handler is started via startService and gets onIntent', async () => {
  const m = fakeManager([manifest('a.svc', { componentType: 'service', intentFilters: [filter()] })]);
  const res = await m.startIntent({ action: VIEW, extras: { job: 1 } });
  assert.equal(res.kind, 'started');
  assert.deepEqual(m.starts, [['startService', 'a.svc']]);
  assert.equal(m.calls[0].hook, 'onIntent');
  assert.deepEqual(m.calls[0].body.intent, { action: VIEW, extras: { job: 1 } });
});

test("multi-activity app: onActivityCreate keeps data=extras and adds the whole intent", async () => {
  const m = fakeManager([manifest('a.multi', { activityMode: 'multi', instanceMode: 'multi', intentFilters: [filter()] })]);
  const res = await m.startIntent({ action: VIEW, uri: 'aura://doc/1', extras: { doc: 1 } });
  assert.equal(res.kind, 'started');
  assert.equal(res.activityId, 'a.multi#a1');
  assert.equal(res.intentDelivered, true);
  assert.equal(m.calls.length, 1);
  assert.equal(m.calls[0].hook, 'onActivityCreate');
  assert.deepEqual(m.calls[0].body, {
    activityId: 'a.multi#a1', data: { doc: 1 },
    intent: { action: VIEW, uri: 'aura://doc/1', extras: { doc: 1 } },
  });
});

test('plain openActivity (no intent) sends no intent field — old contract intact', async () => {
  const m = fakeManager([manifest('a.multi', { activityMode: 'multi', instanceMode: 'multi' })]);
  await m.start('a.multi');
  const act = await m.openActivity('a.multi', { x: 1 });
  assert.equal(act.activityId, 'a.multi#a1');
  assert.equal('hookAnswered' in act, false);
  assert.deepEqual(m.calls[0].body, { activityId: 'a.multi#a1', data: { x: 1 } });
});

test('handler without onIntent hook (404) → still started, intentDelivered=false', async () => {
  const m = fakeManager([manifest('a.viewer', { intentFilters: [filter()] })], { hookReplies: { onIntent: null } });
  const res = await m.startIntent({ action: VIEW });
  assert.deepEqual(res, { kind: 'started', appId: 'a.viewer', instanceId: 'a.viewer', intentDelivered: false });
});

test('explicit intent: targets appId directly, skips the chooser, needs no filter', async () => {
  const m = fakeManager([
    manifest('a.one', { intentFilters: [filter()] }),
    manifest('a.two', { intentFilters: [filter()] }),
    manifest('a.nofilter'),
  ]);
  // Implicit: two tied handlers → disambiguation, nothing started.
  const implicit = await m.startIntent({ action: VIEW });
  assert.equal(implicit.kind, 'disambiguation');
  assert.equal(m.starts.length, 0);
  // Explicit: picks the named app even with tied candidates…
  const picked = await m.startIntent({ action: VIEW, appId: 'a.two' });
  assert.equal(picked.appId, 'a.two');
  // …and an app that declares no filter at all.
  const direct = await m.startIntent({ action: 'x.custom.ACTION', appId: 'a.nofilter', extras: { k: 'v' } });
  assert.equal(direct.kind, 'started');
  assert.equal(direct.appId, 'a.nofilter');
  assert.deepEqual(m.calls.at(-1).body.intent, { action: 'x.custom.ACTION', appId: 'a.nofilter', extras: { k: 'v' } });
});

test('explicit intent for an uninstalled app → noHandler', async () => {
  const m = fakeManager([manifest('a.one', { intentFilters: [filter()] })]);
  assert.deepEqual(await m.startIntent({ action: VIEW, appId: 'a.missing' }), { kind: 'noHandler' });
  assert.equal(m.starts.length, 0);
});
