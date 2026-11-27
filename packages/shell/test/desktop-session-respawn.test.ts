// Instances on a runtime that does not survive a shell restart (PRoot), after
// the restart (5b RS). The kernel respawns them at init from its own record
// (core runtimes/respawn.ts), with no browser and no sign-in; the desktop
// keeps windows only. The snapshot no longer records window-less PRoot
// instances, and the restore maps a window to the kernel's respawned
// instance, so nothing is started twice (one respawner).
//
//   node tools/run-tests.mjs --only=shell
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { reopenActivities, sessionInstances, type DesktopSnapshot, type RestoreReport } from '../src/lib/desktopSession.ts';

type Inst = { instanceId: string; appId: string; state: string; inPool?: boolean; sandbox?: 'proot' | 'container' };
const manifests: Record<string, { activityMode: string; componentType?: string }> = {
  'io.ex.tx':       { activityMode: 'multi' },
  'com.aura.term':  { activityMode: 'multi' },
};

function mgrOf(list: Inst[], respawned: Record<string, string> = {}) {
  const instances = new Map(list.map((i) => [i.instanceId, i]));
  const started: string[] = [];
  const opened: string[] = [];
  let n = 0;
  const mgr = {
    getAllInstances: () => [...instances.values()],
    getInstance: (id: string) => instances.get(id),
    getManifest: (appId: string) => manifests[appId],
    isEnabled: () => true,
    respawnedInstance: async (id: string) => respawned[id] ?? null,
    start: async (appId: string) => {
      const id = `${appId}-new${++n}`;
      instances.set(id, { instanceId: id, appId, state: 'resumed', sandbox: 'proot' });
      started.push(appId);
      return id;
    },
    openActivity: async (instanceId: string) => { opened.push(instanceId); return { activityId: `${instanceId}#a1` }; },
  };
  return { mgr: mgr as never, started, opened };
}
const report = (): RestoreReport => ({ restored: 0, failed: [], idMap: {}, pruned: 0 });

test('the snapshot keeps windows and workspace views only: a window-less PRoot instance is the kernel\'s to respawn', () => {
  const { mgr } = mgrOf([
    { instanceId: 'io.ex.tx', appId: 'io.ex.tx', state: 'resumed', sandbox: 'proot' },
    { instanceId: 'com.aura.term-1', appId: 'com.aura.term', state: 'resumed', sandbox: 'container' },
    { instanceId: 'com.aura.term-2', appId: 'com.aura.term', state: 'resumed', sandbox: 'container' },
  ]);
  assert.deepEqual(sessionInstances(mgr, new Set(), new Set(['com.aura.term-2', 'io.ex.tx'])), [
    { instanceId: 'io.ex.tx', appId: 'io.ex.tx', view: false },
    { instanceId: 'com.aura.term-2', appId: 'com.aura.term', view: false },
  ]);
});

const snap: DesktopSnapshot = {
  schema: 1, savedAt: '2026-11-27T11:48:00.000Z', reason: 'signal',
  instances: [],
  activities: [
    { activityId: 'io.ex.tx#a1', parentInstanceId: 'io.ex.tx', appId: 'io.ex.tx', path: '/', createdAt: '2026-11-27T07:00:00.000Z' },
    { activityId: 'com.aura.term-3#a1', parentInstanceId: 'com.aura.term-3', appId: 'com.aura.term', path: '/', createdAt: '2026-11-27T07:01:00.000Z' },
  ],
};

test('a window of a respawned PRoot instance opens on the kernel\'s new instance; nothing is started twice', async () => {
  const { mgr, started, opened } = mgrOf([
    { instanceId: 'io.ex.tx-9', appId: 'io.ex.tx', state: 'resumed', sandbox: 'proot' },
    { instanceId: 'com.aura.term-3', appId: 'com.aura.term', state: 'resumed', sandbox: 'container' },
  ], { 'io.ex.tx': 'io.ex.tx-9' });
  const r = report();
  await reopenActivities(mgr, snap, r);
  assert.deepEqual(started, []);
  assert.deepEqual(opened, ['io.ex.tx-9', 'com.aura.term-3']);
  assert.equal(r.restored, 2);
  assert.deepEqual(r.failed, []);
});

test('a window whose instance the kernel did not respawn starts one (as before)', async () => {
  const { mgr, started } = mgrOf([{ instanceId: 'com.aura.term-3', appId: 'com.aura.term', state: 'resumed', sandbox: 'container' }]);
  const r = report();
  await reopenActivities(mgr, snap, r);
  assert.deepEqual(started, ['io.ex.tx']);
  assert.equal(r.restored, 2);
});

test('M5: activities not restored: the desktop starts nothing', async () => {
  const { mgr, started, opened } = mgrOf([]);
  await reopenActivities(mgr, snap, report(), false);
  assert.deepEqual(started, []);
  assert.deepEqual(opened, []);
});

test('one respawner: the desktop session has no respawn path left', () => {
  const src = readFileSync(new URL('../src/lib/desktopSession.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /respawn: true|i\.respawn\b|RESPAWN_STATES|survivesShellRestart/);
  assert.match(src, /respawnedInstance\(oldId\)/);
});
