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
import { IntentError, IntentResolver, intentPayload, parseIntentRejection } from '../dist/app-manager/IntentResolver.js';

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
 * (instance id = app id, like single-instance apps); `instances` seeds extra
 * ones verbatim ({ instanceId, appId, state, inPool }). `hookReplies` maps a
 * lifecycle hook to what the app answers (default `{ ok: true }`; null =
 * 404). A later start() of an app that already has instance `<appId>` mints
 * `<appId>-2`, `-3`, … like multi-instance apps do.
 */
function fakeManager(manifests, { running = [], instances = [], hookReplies = {} } = {}) {
  const byId = new Map(manifests.map((m) => [m.id, m]));
  const intents = new IntentResolver();
  intents.reload(manifests);
  const calls = [];
  const spawn = (appId) => {
    let id = appId;
    for (let n = 2; fake.instances.has(id); n++) id = `${appId}-${n}`;
    fake.instances.set(id, { instanceId: id, appId, inPool: false, state: 'resumed' });
    return id;
  };
  const fake = {
    calls,
    starts: [],
    stops: [],
    resumes: [],
    intents,
    registry: { getById: (id) => byId.get(id) },
    instances: new Map(),
    activities: new Map(),
    nextActivityNum: new Map(),
    isEnabled: () => true,
    getInstancesByApp: (appId) => [...fake.instances.values()].filter((i) => i.appId === appId),
    getActivitiesByInstance: (id) => [...fake.activities.values()].filter((a) => a.parentInstanceId === id),
    async start(appId) {
      fake.starts.push(['start', appId]);
      const m = byId.get(appId);
      if (m?.instanceMode === 'single') {
        const live = fake.getInstancesByApp(appId)[0];
        if (live) return live.instanceId;
      }
      return spawn(appId);
    },
    async startService(appId) {
      fake.starts.push(['startService', appId]);
      return fake.getInstancesByApp(appId)[0]?.instanceId ?? spawn(appId);
    },
    async stop(id) { fake.stops.push(id); fake.instances.delete(id); },
    async resume(id) { fake.resumes.push(id); fake.instances.get(id).state = 'resumed'; },
    runnerOf: () => ({
      async callOptionalLifecycle(instanceId, hook, body) {
        calls.push({ instanceId, hook, body });
        const reply = hook in hookReplies ? hookReplies[hook] : { ok: true };
        return typeof reply === 'function' ? reply(body) : reply;
      },
    }),
  };
  for (const id of running) fake.instances.set(id, { instanceId: id, appId: id, inPool: false, state: 'resumed' });
  for (const i of instances) fake.instances.set(i.instanceId, { inPool: false, state: 'resumed', ...i });
  for (const name of ['startIntent', 'pickIntentInstance', 'openActivity', 'openActivityAndReport']) {
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

// ── Instance targeting + launch flags ────────────────────────────────────────

const OPEN = 'x.action.OPEN';
const multiApp = (over = {}) => manifest('a.term', {
  activityMode: 'multi', instanceMode: 'multi', defaultLaunch: 'new-activity', ...over,
});

test('intentPayload carries instanceId and flags when set', () => {
  assert.deepEqual(
    intentPayload({ action: OPEN, instanceId: 'a.term-2', flags: ['NEW_INSTANCE'] }),
    { action: OPEN, instanceId: 'a.term-2', flags: ['NEW_INSTANCE'] },
  );
  assert.deepEqual(intentPayload({ action: OPEN, flags: [] }), { action: OPEN });
});

test("default launch mirrors the launcher: defaultLaunch 'new-activity' reuses the first user-owned instance", async () => {
  const m = fakeManager([multiApp()], { instances: [
    { instanceId: 'a.term-9', appId: 'a.term', inPool: true },     // warm-pool member: never reused
    { instanceId: 'a.term-3', appId: 'a.term' },
  ] });
  const res = await m.startIntent({ action: OPEN, appId: 'a.term' });
  assert.equal(res.instanceId, 'a.term-3');
  assert.equal(res.activityId, 'a.term-3#a1');
  assert.deepEqual(m.starts, []);
});

test("default launch with no user-owned instance → start() (pool claim / spawn)", async () => {
  const m = fakeManager([multiApp()]);
  const res = await m.startIntent({ action: OPEN, appId: 'a.term' });
  assert.equal(res.kind, 'started');
  assert.deepEqual(m.starts, [['start', 'a.term']]);
});

test("defaultLaunch 'new-instance' keeps start() semantics (a fresh instance each time)", async () => {
  const m = fakeManager([multiApp({ defaultLaunch: 'new-instance' })], { running: ['a.term'] });
  const res = await m.startIntent({ action: OPEN, appId: 'a.term' });
  assert.equal(res.instanceId, 'a.term-2');
});

test('instanceId targets exactly that instance and resumes it when paused', async () => {
  const m = fakeManager([multiApp()], { instances: [
    { instanceId: 'a.term', appId: 'a.term' },
    { instanceId: 'a.term-2', appId: 'a.term', state: 'paused' },
  ] });
  const res = await m.startIntent({ action: OPEN, appId: 'a.term', instanceId: 'a.term-2' });
  assert.equal(res.instanceId, 'a.term-2');
  assert.deepEqual(m.resumes, ['a.term-2']);
  assert.deepEqual(m.starts, []);
  assert.equal(m.calls[0].body.intent.instanceId, 'a.term-2');
});

test('unknown / foreign / dead instanceId → IntentError, nothing started', async () => {
  const m = fakeManager([multiApp(), manifest('a.other')], { instances: [
    { instanceId: 'a.other', appId: 'a.other' },
    { instanceId: 'a.term-4', appId: 'a.term', state: 'error' },
  ] });
  for (const [instanceId, status, code] of [['a.term-77', 404, 'no-such-instance'], ['a.other', 404, 'no-such-instance'], ['a.term-4', 409, 'instance-not-running']]) {
    await assert.rejects(m.startIntent({ action: OPEN, appId: 'a.term', instanceId }), (err) => {
      assert.ok(err instanceof IntentError);
      assert.equal(err.status, status);
      assert.equal(err.code, code);
      return true;
    });
  }
  assert.deepEqual(m.starts, []);
  assert.equal(m.calls.length, 0);
});

test('NEW_INSTANCE starts a fresh instance even when one could be reused', async () => {
  const m = fakeManager([multiApp()], { running: ['a.term'] });
  const res = await m.startIntent({ action: OPEN, appId: 'a.term', flags: ['NEW_INSTANCE'] });
  assert.equal(res.instanceId, 'a.term-2');
  assert.deepEqual(m.calls[0].body.intent.flags, ['NEW_INSTANCE']);
});

test('NEW_INSTANCE + instanceId, unknown flags, NEW_INSTANCE on single-instance apps → IntentError', async () => {
  const m = fakeManager([multiApp(), manifest('a.single'), manifest('a.svc', { componentType: 'service' })], { running: ['a.term'] });
  const cases = [
    [{ appId: 'a.term', instanceId: 'a.term', flags: ['NEW_INSTANCE'] }, 400, 'conflicting-target'],
    [{ appId: 'a.term', flags: ['NEW_TASKK'] }, 400, 'unknown-flag'],
    [{ appId: 'a.single', flags: ['NEW_INSTANCE'] }, 409, 'single-instance'],
    [{ appId: 'a.svc', flags: ['NEW_INSTANCE'] }, 409, 'single-instance'],
  ];
  for (const [over, status, code] of cases) {
    await assert.rejects(m.startIntent({ action: OPEN, ...over }), (err) => err instanceof IntentError && err.status === status && err.code === code);
  }
  assert.deepEqual(m.starts, []);
});

// ── Handler replies: rejected / noActivity / result ─────────────────────────

test('parseIntentRejection: defaults and status clamping', () => {
  assert.equal(parseIntentRejection({ ok: true }), null);
  assert.equal(parseIntentRejection(null), null);
  assert.deepEqual(parseIntentRejection({ rejected: {} }), { code: 'rejected', message: 'The app rejected the intent.', status: 422 });
  assert.deepEqual(
    parseIntentRejection({ rejected: { code: 'no-such-session', message: 'gone', hint: 'list', status: 404 } }),
    { code: 'no-such-session', message: 'gone', hint: 'list', status: 404 },
  );
  assert.equal(parseIntentRejection({ rejected: { status: 500 } }).status, 422);
});

test('onActivityCreate rejection → no activity, kind rejected, existing instance kept', async () => {
  const m = fakeManager([multiApp()], {
    running: ['a.term'],
    hookReplies: { onActivityCreate: { ok: false, rejected: { code: 'bad-extras', message: 'nope', status: 400 } } },
  });
  const res = await m.startIntent({ action: OPEN, appId: 'a.term', extras: { bogus: 1 } });
  assert.deepEqual(res, { kind: 'rejected', appId: 'a.term', instanceId: 'a.term', code: 'bad-extras', message: 'nope', status: 400 });
  assert.equal(m.activities.size, 0);
  assert.deepEqual(m.stops, []);
});

test('rejection on an instance started only for this intent stops it again', async () => {
  const m = fakeManager([multiApp()], {
    running: ['a.term'],
    hookReplies: { onActivityCreate: { rejected: { code: 'x', message: 'y' } } },
  });
  const res = await m.startIntent({ action: OPEN, appId: 'a.term', flags: ['NEW_INSTANCE'] });
  assert.equal(res.kind, 'rejected');
  assert.equal(res.instanceId, 'a.term-2');
  assert.deepEqual(m.stops, ['a.term-2']);
});

test('noActivity reply → handled window-less: no activity registered, result handed back', async () => {
  const m = fakeManager([multiApp()], {
    running: ['a.term'],
    hookReplies: { onActivityCreate: (body) => (body.data?.background
      ? { ok: true, noActivity: true, result: { sessionId: body.activityId } }
      : { ok: true }) },
  });
  const res = await m.startIntent({ action: OPEN, appId: 'a.term', extras: { background: true } });
  assert.deepEqual(res, { kind: 'started', appId: 'a.term', instanceId: 'a.term', intentDelivered: true, result: { sessionId: 'a.term#a1' } });
  assert.equal(m.activities.size, 0);
  // The activity number is spent, so the next window can never reuse that id.
  const next = await m.startIntent({ action: OPEN, appId: 'a.term' });
  assert.equal(next.activityId, 'a.term#a2');
});

test('result from a window-opening onActivityCreate is returned alongside activityId', async () => {
  const m = fakeManager([multiApp()], { hookReplies: { onActivityCreate: { ok: true, result: { k: 1 } } } });
  const res = await m.startIntent({ action: OPEN, appId: 'a.term' });
  assert.equal(res.activityId, 'a.term#a1');
  assert.deepEqual(res.result, { k: 1 });
});

test('plain openActivity ignores rejected/noActivity (only intent launches may decline a window)', async () => {
  const m = fakeManager([multiApp()], { running: ['a.term'], hookReplies: { onActivityCreate: { noActivity: true, rejected: { code: 'x', message: 'y' } } } });
  const act = await m.openActivity('a.term');
  assert.equal(act.activityId, 'a.term#a1');
  assert.equal(m.activities.size, 1);
});

test('onIntent handlers can reject and return a result too', async () => {
  const rej = fakeManager([manifest('a.viewer')], { hookReplies: { onIntent: { rejected: { code: 'bad', message: 'm' } } } });
  const r1 = await rej.startIntent({ action: VIEW, appId: 'a.viewer' });
  assert.equal(r1.kind, 'rejected');
  assert.deepEqual(rej.stops, ['a.viewer']);   // cold-started for the intent → stopped again
  const ok = fakeManager([manifest('a.viewer')], { running: ['a.viewer'], hookReplies: { onIntent: { ok: true, result: { id: 7 } } } });
  const r2 = await ok.startIntent({ action: VIEW, appId: 'a.viewer' });
  assert.deepEqual(r2.result, { id: 7 });
});
