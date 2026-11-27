// Phase 5 I.2 part 2 (D82) in the kernel: a single-instance app is one
// user's (another user's start never gets it), and a disabled user's
// interactive sessions end (`endUserSessions`, the UserSessionEnders contract).
// AppManager's prototype methods run against a small fake `this`, as in
// lifecycle-user.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppManager } from '../dist/app-manager/AppManager.js';

const MEMBER = 'uaaaaaaaaaaaaaaa';

function fake(manifests, instances = [], sessions = []) {
  const byId = new Map(manifests.map((m) => [m.id, m]));
  const f = {
    spawned: [], resumed: [], stopped: [],
    registry: { getById: (id) => byId.get(id) },
    instances: new Map(instances.map((i) => [i.instanceId, { inPool: false, state: 'resumed', ...i }])),
    poolHomes: new Map(),
    endedSessions: [],
    // Stream J's session broker, through the container module's `sessions` group (5b CR).
    runtimes: { list: () => [{ sessions: {
      list: () => sessions,
      async end(id) { if (id.endsWith('-stuck')) return false; f.endedSessions.push(id); return true; },
    } }] },
    isEnabled: () => true,
    getInstancesByApp: (appId) => [...f.instances.values()].filter((i) => i.appId === appId),
    async spawnInstance(appId, opts) { f.spawned.push([appId, opts]); return `${appId}-new`; },
    async resume(id) { f.resumed.push(id); },
    async stop(id) { if (id.endsWith('-stuck')) throw new Error('stuck'); f.stopped.push(id); },
  };
  for (const name of ['launch', 'endUserSessions', 'endJumpSessionsOf', 'openSessions', 'endSession', 'modulesWith']) f[name] = AppManager.prototype[name].bind(f);
  return f;
}

const single = (id) => ({ id, componentType: 'app', instanceMode: 'single', warmPool: 0, maxInstances: 0 });

test('D82: a single-instance app is its owner\'s; another user\'s start is refused, never handed the instance', async () => {
  const m = fake([single('io.ex.notes')], [{ instanceId: 'io.ex.notes', appId: 'io.ex.notes', owner: 'default' }]);
  assert.equal(await m.launch('io.ex.notes'), 'io.ex.notes', 'the owner (no user given) gets its own');
  assert.equal(await m.launch('io.ex.notes', 'default'), 'io.ex.notes');
  await assert.rejects(m.launch('io.ex.notes', MEMBER), /another user's/);
  assert.deepEqual(m.spawned, []);
});

test('D82: an unlabelled single instance is the owner\'s; a member\'s own stopped one is resumed for it', async () => {
  const m = fake([single('io.ex.notes')], [{ instanceId: 'io.ex.notes', appId: 'io.ex.notes', state: 'stopped', owner: MEMBER }]);
  assert.equal(await m.launch('io.ex.notes', MEMBER), 'io.ex.notes');
  assert.deepEqual(m.resumed, ['io.ex.notes']);
  await assert.rejects(m.launch('io.ex.notes'), /another user's/, 'the owner does not take a member\'s either');
  const legacy = fake([single('io.ex.notes')], [{ instanceId: 'io.ex.notes', appId: 'io.ex.notes' }]);
  assert.equal(await legacy.launch('io.ex.notes'), 'io.ex.notes');
  await assert.rejects(legacy.launch('io.ex.notes', MEMBER), /another user's/);
});

test('D82: a member\'s first start of a single-instance app spawns its own', async () => {
  const m = fake([single('io.ex.notes')]);
  assert.equal(await m.launch('io.ex.notes', MEMBER), 'io.ex.notes-new');
  assert.deepEqual(m.spawned, [['io.ex.notes', { inPool: false, userId: MEMBER }]]);
});

test('D82 disable: the user\'s Terminal instances and pool members warmed for it stop; nobody else\'s, no other app', async () => {
  const m = fake([], [
    { instanceId: 'com.aura.terminal-1', appId: 'com.aura.terminal', owner: 'default' },
    { instanceId: 'com.aura.terminal-2', appId: 'com.aura.terminal', owner: MEMBER },
    { instanceId: 'com.aura.terminal-3', appId: 'com.aura.terminal', inPool: true },
    { instanceId: 'com.aura.terminal-4', appId: 'com.aura.terminal', inPool: true },
    { instanceId: 'com.aura.terminal-stuck', appId: 'com.aura.terminal', owner: MEMBER },
    { instanceId: 'io.ex.notes-1', appId: 'io.ex.notes', owner: MEMBER },
  ]);
  m.poolHomes.set('com.aura.terminal-3', MEMBER);
  m.poolHomes.set('com.aura.terminal-4', 'default');
  const ended = await m.endUserSessions(MEMBER);
  assert.deepEqual(m.stopped.sort(), ['com.aura.terminal-2', 'com.aura.terminal-3']);
  assert.deepEqual(ended, { terminals: 2, terminalsFailed: 1, jumpSessions: 0 });
});

test('5-main integration (I.2 + J): disabling a user ends that user\'s jump sessions only, through the session broker', async () => {
  const m = fake([], [], [
    { sessionId: 's-member-1', instanceId: 'io.ex.notes-1', userId: MEMBER, kind: 'jump', home: 'private' },
    { sessionId: 's-member-2', instanceId: 'com.aura.counter-1', userId: MEMBER, kind: 'jump', home: 'app' },
    { sessionId: 's-member-stuck', instanceId: 'io.ex.notes-1', userId: MEMBER, kind: 'jump', home: 'ephemeral' },
    { sessionId: 's-owner', instanceId: 'io.ex.notes-1', userId: 'default', kind: 'jump', home: 'private' },
    { sessionId: 's-app', instanceId: 'io.ex.notes-1', kind: 'jump', home: 'app' },
  ]);
  const ended = await m.endUserSessions(MEMBER);
  assert.deepEqual(m.endedSessions, ['s-member-1', 's-member-2']);
  assert.deepEqual(ended, { terminals: 0, terminalsFailed: 0, jumpSessions: 2 });
});
