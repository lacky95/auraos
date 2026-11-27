// D101: what AppManager.closeActivity reports, from which the shell asks the
// user about a background process left without a window. Only the last
// activity of THAT instance counts (every window and flight of it); an app
// without a background process still stops with its last window, and a
// flight takeoff or landing is no close at all. As intent-dispatch and
// app-preview do, the prototype methods run against a small fake `this`.
//
//   node tools/run-tests.mjs --only=core
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AppManager } from '../dist/app-manager/AppManager.js';
import { OsEventBus } from '../dist/ipc/OsEventBus.js';

const BG = { id: 'io.bg.app', name: 'Bg', componentType: 'activity', activityMode: 'multi', backgroundService: true };
const FG = { id: 'io.fg.app', name: 'Fg', componentType: 'activity', activityMode: 'multi', backgroundService: false };

function fakeManager() {
  const running = new Set();
  const fake = {
    activities: new Map(),
    stops: [],
    registry: { getById: (id) => [BG, FG].find((m) => m.id === id) },
    runnerOf: () => ({ callOptionalLifecycle: async () => undefined, isRunning: (id) => running.has(id) }),
    async stop(id) { fake.stops.push(id); running.delete(id); },
    assertMayFly() {},
    emitFlight() {},
    run(id) { running.add(id); },
    open(activityId, appId, instanceId) {
      fake.activities.set(activityId, { activityId, appId, parentInstanceId: instanceId, path: '/', presentation: 'window', createdAt: new Date(), lastTransitionAt: new Date(), taskId: instanceId });
    },
  };
  for (const name of ['closeActivity', 'getActivitiesByInstance', 'getActivity', 'takeOffActivity', 'landFlight']) {
    fake[name] = AppManager.prototype[name].bind(fake);
  }
  return fake;
}

function closedEvents() {
  const seen = [];
  const fn = (ev) => seen.push(ev);
  OsEventBus.on('activity:closed', fn);
  return { seen, off: () => OsEventBus.off('activity:closed', fn) };
}

test('the last window of a background app: last of its instance, the instance keeps running', async () => {
  const m = fakeManager();
  m.run('io.bg.app-1');
  m.open('io.bg.app-1#a1', BG.id, 'io.bg.app-1');
  const ev = closedEvents();
  const r = await m.closeActivity('io.bg.app-1#a1');
  ev.off();
  assert.deepEqual(r, {
    closed: true, activityId: 'io.bg.app-1#a1', parentInstanceId: 'io.bg.app-1', appId: BG.id,
    lastOfInstance: true, instanceStopped: false, instanceRunning: true,
  });
  assert.deepEqual(m.stops, [], 'a background process is never stopped by the close itself');
  assert.equal(ev.seen.length, 1, 'activity:closed is emitted as before (unchanged payload)');
  assert.deepEqual(Object.keys(ev.seen[0]).sort(), ['activityId', 'appId', 'parentInstanceId']);
});

test('an app without a background process still stops with its last window (unchanged)', async () => {
  const m = fakeManager();
  m.run('io.fg.app-1');
  m.open('io.fg.app-1#a1', FG.id, 'io.fg.app-1');
  const r = await m.closeActivity('io.fg.app-1#a1');
  assert.equal(r.lastOfInstance, true);
  assert.equal(r.instanceStopped, true);
  assert.equal(r.instanceRunning, false);
  assert.deepEqual(m.stops, ['io.fg.app-1']);
});

test('not the last: another window of the same instance remains; windows of another instance do not count', async () => {
  const m = fakeManager();
  m.run('io.bg.app-1'); m.run('io.bg.app-2');
  m.open('io.bg.app-1#a1', BG.id, 'io.bg.app-1');
  m.open('io.bg.app-1#a2', BG.id, 'io.bg.app-1');
  m.open('io.bg.app-2#a1', BG.id, 'io.bg.app-2');
  const first = await m.closeActivity('io.bg.app-1#a1');
  assert.equal(first.lastOfInstance, false);
  const second = await m.closeActivity('io.bg.app-1#a2');
  assert.equal(second.lastOfInstance, true, 'the other instance\'s window does not keep instance 1 "open"');
  assert.equal(second.instanceRunning, true);
});

test('a flight is a window of its instance: takeoff and landing are no close, and a flight keeps the instance open', async () => {
  const m = fakeManager();
  m.run('io.bg.app-1');
  m.open('io.bg.app-1#a1', BG.id, 'io.bg.app-1');
  m.open('io.bg.app-1#a2', BG.id, 'io.bg.app-1');
  const ev = closedEvents();
  m.takeOffActivity('io.bg.app-1#a2', { rect: { x: 0, y: 0, w: 300, h: 200 } });
  assert.equal(m.getActivitiesByInstance('io.bg.app-1').length, 2, 'takeoff keeps the activity');
  const r = await m.closeActivity('io.bg.app-1#a1');
  assert.equal(r.lastOfInstance, false, 'the flight still holds the instance');
  assert.equal(m.landFlight('io.bg.app-1#a2'), true);
  assert.equal(m.getActivitiesByInstance('io.bg.app-1').length, 1, 'landing keeps the activity');
  ev.off();
  assert.deepEqual(ev.seen.map((e) => e.activityId), ['io.bg.app-1#a1'], 'only the real close emitted activity:closed');
});

test('closing an activity that is already gone reports nothing closed', async () => {
  const m = fakeManager();
  const r = await m.closeActivity('io.bg.app-9#a1');
  assert.equal(r.closed, false);
  assert.equal(r.lastOfInstance, false);
  assert.deepEqual(m.stops, []);
});
