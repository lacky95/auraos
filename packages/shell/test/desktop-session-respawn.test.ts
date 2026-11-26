// PRoot instances after a shell restart (lib/desktopSession.ts). Container
// apps survive and are adopted; a PRoot app is a child process of the shell
// and dies with it. The desktop snapshot keeps every running PRoot instance,
// with or without a window, and the restore starts it again, only when the
// desktop is restored: restore off or a restart without restoring brings
// nothing back (M5, D57).
//
//   cd packages/shell && npx tsx --test test/desktop-session-respawn.test.ts
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { reopenActivities, sessionInstances, type DesktopSnapshot, type RestoreReport } from '../src/lib/desktopSession.ts';

type Inst = { instanceId: string; appId: string; state: string; inPool?: boolean; sandbox?: 'proot' | 'container' };
const manifests: Record<string, { activityMode: string; componentType?: string }> = {
  'io.ex.tx':       { activityMode: 'multi' },
  'io.ex.svc':      { activityMode: 'none', componentType: 'service' },
  'com.aura.term':  { activityMode: 'multi' },
};

function mgrOf(list: Inst[]) {
  const instances = new Map(list.map((i) => [i.instanceId, i]));
  const started: string[] = [];
  const opened: string[] = [];
  let n = 0;
  const mgr = {
    getAllInstances: () => [...instances.values()],
    getInstance: (id: string) => instances.get(id),
    getManifest: (appId: string) => manifests[appId],
    isEnabled: () => true,
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
const report = (): RestoreReport => ({ restored: 0, respawned: 0, failed: [], idMap: {}, pruned: 0 });

test('the snapshot keeps a running PRoot instance without a window; a container one only with a window', () => {
  const { mgr } = mgrOf([
    { instanceId: 'io.ex.tx', appId: 'io.ex.tx', state: 'resumed', sandbox: 'proot' },
    { instanceId: 'com.aura.term-1', appId: 'com.aura.term', state: 'resumed', sandbox: 'container' },
    { instanceId: 'com.aura.term-2', appId: 'com.aura.term', state: 'resumed', sandbox: 'container' },
    { instanceId: 'io.ex.tx-pool', appId: 'io.ex.tx', state: 'resumed', sandbox: 'proot', inPool: true },
    { instanceId: 'io.ex.tx-dead', appId: 'io.ex.tx', state: 'error', sandbox: 'proot' },
    { instanceId: 'io.ex.tx-stopped', appId: 'io.ex.tx', state: 'stopped', sandbox: 'proot' },
    { instanceId: 'io.ex.tx-crashed', appId: 'io.ex.tx', state: 'crashed', sandbox: 'proot' },
    { instanceId: 'io.ex.svc', appId: 'io.ex.svc', state: 'resumed', sandbox: 'proot' },
  ]);
  const got = sessionInstances(mgr, new Set(), new Set(['com.aura.term-2']));
  assert.deepEqual(got, [
    { instanceId: 'io.ex.tx', appId: 'io.ex.tx', view: false, respawn: true },
    { instanceId: 'com.aura.term-2', appId: 'com.aura.term', view: false },
  ]);
});

const snap: DesktopSnapshot = {
  schema: 1, savedAt: '2026-11-25T11:48:00.000Z', reason: 'signal',
  instances: [
    { instanceId: 'io.ex.tx', appId: 'io.ex.tx', view: false, respawn: true },
    { instanceId: 'com.aura.term-3', appId: 'com.aura.term', view: false },
  ],
  activities: [
    { activityId: 'com.aura.term-3#a1', parentInstanceId: 'com.aura.term-3', appId: 'com.aura.term', path: '/', createdAt: '2026-11-25T07:00:00.000Z' },
  ],
};

test('the restore starts the PRoot instance again; the adopted container keeps its id', async () => {
  const { mgr, started, opened } = mgrOf([{ instanceId: 'com.aura.term-3', appId: 'com.aura.term', state: 'resumed', sandbox: 'container' }]);
  const r = report();
  await reopenActivities(mgr, snap, r);
  assert.deepEqual(started, ['io.ex.tx']);
  assert.deepEqual(opened, ['com.aura.term-3']);
  assert.equal(r.restored, 1);
  assert.equal(r.respawned, 1);
  assert.equal(r.idMap['io.ex.tx'], 'io.ex.tx-new1');
  assert.deepEqual(r.failed, []);
});

test('M5: activities not restored (setting off, or a restart without restore): nothing comes back, PRoot included', async () => {
  const { mgr, started, opened } = mgrOf([]);
  const r = report();
  await reopenActivities(mgr, snap, r, false);
  assert.deepEqual(started, []);
  assert.deepEqual(opened, []);
  assert.equal(r.restored, 0);
  assert.equal(r.respawned, 0);
});

test('M5: doRestore passes windows only when nothing skipped the restore', () => {
  const src = readFileSync(new URL('../src/lib/desktopSession.ts', import.meta.url), 'utf8');
  assert.match(src, /await reopenActivities\(mgr, snap, report, !report\.skipped, userId\)/);
  assert.match(src, /for \(const si of windows \? snap\.instances\.filter\(\(i\) => i\.respawn\) : \[\]\)/);
});

test('a PRoot instance with a window is started once, by its window', async () => {
  const { mgr, started } = mgrOf([]);
  const r = report();
  await reopenActivities(mgr, {
    ...snap,
    activities: [{ activityId: 'io.ex.tx#a1', parentInstanceId: 'io.ex.tx', appId: 'io.ex.tx', path: '/', createdAt: '2026-11-25T07:00:00.000Z' }],
  }, r);
  assert.deepEqual(started, ['io.ex.tx']);
  assert.equal(r.restored, 1);
  assert.equal(r.respawned, 0);
});

test('a PRoot app that is already running again (autoStart) is not started twice', async () => {
  const { mgr, started } = mgrOf([{ instanceId: 'io.ex.tx', appId: 'io.ex.tx', state: 'resumed', sandbox: 'proot' }]);
  const r = report();
  await reopenActivities(mgr, { ...snap, activities: [] }, r);
  assert.deepEqual(started, []);
  assert.equal(r.respawned, 1);
  assert.equal(r.idMap['io.ex.tx'], 'io.ex.tx');
});
