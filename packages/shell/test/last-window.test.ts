/**
 * D101, the pure half (lib/lastWindow.ts, lib/activityClose.ts): which closes
 * ask, the remembered choice per app (installation, else app id), the
 * Settings switch, and the preference's format. The dialog and the Settings
 * section are last-window-dom.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  LAST_WINDOW_DEFAULTS, LAST_WINDOW_PREF, choiceKey, decideLastWindow, forgetChoice, keepsBackgroundProcess,
  normalizeLastWindowPrefs, rememberChoice, type CloseFacts,
} from '../src/lib/lastWindow.ts';
import { describeClose } from '../src/lib/activityClose.ts';
import { USER_PREF_KEYS } from '../../core/src/users/userData.ts';

const BG = { componentType: 'activity', backgroundService: true };
const FG = { componentType: 'activity', backgroundService: false };
const SERVICE = { componentType: 'service', backgroundService: true };
const last: CloseFacts = { closed: true, lastOfInstance: true, instanceStopped: false, instanceRunning: true, appId: 'io.bg.app' };
const on = normalizeLastWindowPrefs(null);

test('the switch defaults to on; broken documents fall back entry by entry', () => {
  assert.deepEqual(on, { ask: true, apps: {} });
  assert.equal(LAST_WINDOW_DEFAULTS.ask, true);
  assert.deepEqual(normalizeLastWindowPrefs({ ask: 'yes', apps: [] }), { ask: true, apps: {} });
  assert.deepEqual(normalizeLastWindowPrefs({
    ask: false,
    apps: {
      'inst_1': { choice: 'stop', appId: 'io.bg.app', name: 'Bg', at: 5 },
      'bad key!': { choice: 'stop', appId: 'x' },
      'io.x': { choice: 'maybe', appId: 'io.x' },
      'io.y': { choice: 'keep' },
    },
  }), { ask: false, apps: { inst_1: { choice: 'stop', appId: 'io.bg.app', name: 'Bg', at: 5 } } });
});

test('the preference is a per-user pref (D46), read and written through os/lastWindow', () => {
  assert.equal(LAST_WINDOW_PREF, 'lastWindow');
  assert.ok((USER_PREF_KEYS as readonly string[]).includes(LAST_WINDOW_PREF));
});

test('only an app with a background process is asked; services and plain activity apps never', () => {
  assert.equal(keepsBackgroundProcess(BG), true);
  assert.equal(keepsBackgroundProcess(FG), false);
  assert.equal(keepsBackgroundProcess(SERVICE), false, 'D73: a service is never affected');
  assert.equal(keepsBackgroundProcess(null), false);
  assert.equal(decideLastWindow(last, BG, on), 'ask');
  assert.equal(decideLastWindow(last, FG, on), 'none');
  assert.equal(decideLastWindow(last, SERVICE, on), 'none');
});

test('only the last activity of that instance, and only while the process still runs', () => {
  assert.equal(decideLastWindow({ ...last, lastOfInstance: false }, BG, on), 'none', 'another window or flight remains');
  assert.equal(decideLastWindow({ ...last, instanceStopped: true, instanceRunning: false }, BG, on), 'none');
  assert.equal(decideLastWindow({ ...last, instanceRunning: false }, BG, on), 'none');
  assert.equal(decideLastWindow({ ...last, closed: false }, BG, on), 'none');
  assert.equal(decideLastWindow(null, BG, on), 'none', 'no answer from the server (old shell, network): no question');
});

test('a remembered choice answers for its app, by installation first, then by app id', () => {
  const byInst = rememberChoice(on, choiceKey('io.bg.app', 'inst_1'), { choice: 'stop', appId: 'io.bg.app', name: 'Bg' }, 10);
  assert.deepEqual(byInst.apps, { inst_1: { choice: 'stop', appId: 'io.bg.app', name: 'Bg', at: 10 } });
  assert.equal(decideLastWindow({ ...last, installationId: 'inst_1' }, BG, byInst), 'stop');
  assert.equal(decideLastWindow({ ...last, installationId: 'inst_2' }, BG, byInst), 'ask', 'a reinstall (new installation) asks afresh');
  const byApp = rememberChoice(on, choiceKey('io.bg.app', null), { choice: 'keep', appId: 'io.bg.app' }, 11);
  assert.deepEqual(Object.keys(byApp.apps), ['io.bg.app']);
  assert.equal(decideLastWindow(last, BG, byApp), 'keep');
  assert.equal(decideLastWindow({ ...last, installationId: 'inst_1' }, BG, byApp), 'keep', 'an app-id choice still applies');
  assert.equal(decideLastWindow({ ...last, appId: 'io.other' }, BG, byApp), 'ask', 'per app');
  assert.equal(choiceKey('io.bg.app', '../../etc'), 'io.bg.app', 'an odd installation id never becomes a key');
});

test('the switch off: no question; remembered choices still apply; a reset asks again', () => {
  const off = { ...on, ask: false };
  assert.equal(decideLastWindow(last, BG, off), 'none', 'off = keep running, as before D101');
  const offStop = rememberChoice(off, 'io.bg.app', { choice: 'stop', appId: 'io.bg.app' }, 1);
  assert.equal(decideLastWindow(last, BG, offStop), 'stop');
  const reset = forgetChoice(rememberChoice(on, 'io.bg.app', { choice: 'stop', appId: 'io.bg.app' }, 1), 'io.bg.app');
  assert.equal(decideLastWindow(last, BG, reset), 'ask');
  const two = rememberChoice(rememberChoice(on, 'a.b', { choice: 'keep', appId: 'a.b' }, 1), 'c.d', { choice: 'stop', appId: 'c.d' }, 2);
  assert.deepEqual(forgetChoice(two, null).apps, {});
});

test('describeClose adds the installation only when a running instance stays behind', async () => {
  const asked: string[] = [];
  const lookup = async (appId: string) => { asked.push(appId); return 'inst_9'; };
  const r = { ...last, activityId: 'io.bg.app-1#a1', parentInstanceId: 'io.bg.app-1' };
  assert.equal((await describeClose(r, lookup)).installationId, 'inst_9');
  assert.equal((await describeClose({ ...r, lastOfInstance: false }, lookup)).installationId, undefined);
  assert.equal((await describeClose({ ...r, instanceRunning: false, instanceStopped: true }, lookup)).installationId, undefined);
  assert.deepEqual(asked, ['io.bg.app']);
  assert.equal((await describeClose(r, async () => null)).installationId, undefined, 'no installation: the app id is the key');
});

test('the close routes answer what the close did; Stop is the lifecycle stop and only while idle', () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
  assert.match(read('../src/pages/api/activities/[activityId]/close.ts'), /describeClose\(await getAppManager\(\)\.closeActivity\(activityId\)\)/);
  assert.match(read('../src/pages/api/activities/[activityId]/flight/[action].ts'), /close: await describeClose\(r\.close\)/);
  const stop = read('../src/pages/api/instances/[instanceId]/stop.ts');
  assert.match(stop, /ifIdle/);
  assert.match(stop, /getActivitiesByInstance\(instanceId\)\.length > 0/);
  assert.match(stop, /await mgr\.stop\(instanceId\)/, 'the normal stop: onStop reason user (its default)');
});

test('the desktop asks only on a user close: chrome and layout close yes, an agent\'s closeWindow no', () => {
  const page = readFileSync(new URL('../src/pages/index.astro', import.meta.url), 'latin1');
  assert.match(page, /if \(action === 'close'\)\s+\{ e\.preventDefault\(\); closeView_\(viewId, \{ user: true \}\); \}/);
  assert.match(page, /close: \(viewId\) => closeView_\(viewId, \{ user: true \}\)/);
  assert.match(page, /registerUiCommand\('closeWindow',\s+\(\{ viewId \}\) => \{ const v = needView\(viewId\); closeView_\(v\.viewId\);/);
  assert.match(page, /if \(opts\.user\) void closing\.then\(\(body\) => afterUserClose\(/);
  // A workspace move or a takeoff closes no activity: the desktop's only
  // activity close is closeView_ (the server's count is what decides "last").
  const takeoff = page.slice(page.indexOf('function takeOffView_'), page.indexOf('function refreshView_'));
  assert.doesNotMatch(takeoff, /closeView_|\/close`/);
  const body = { from: page.indexOf('function closeView_('), to: page.indexOf('function minimizeView_(') };
  const closes = [...page.matchAll(/\/api\/activities\/\$\{[^}]+\}\/close`/g)].map((m) => m.index!);
  assert.ok(closes.length >= 1);
  for (const at of closes) assert.ok(at > body.from && at < body.to, `an activity close outside closeView_ at ${at}`);
});
