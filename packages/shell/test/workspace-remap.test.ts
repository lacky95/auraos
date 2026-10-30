// Activity-id remap across the workspace document (lib/workspaceRemap.ts).
//
//   cd packages/shell && npx tsx --test test/workspace-remap.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allMembers, remapWorkspaceIds, type RemapState } from '../src/lib/workspaceRemap.ts';

const A1 = 'com.aura.terminal-3#a1';
const A2 = 'com.aura.terminal-3#a2';
const N1 = 'com.aura.terminal-7#a1';
const NOTE = 'com.aura.notepad-2';

const state = (): RemapState => ({
  activeWorkspaceId: 'ws-1',
  workspaces: [
    {
      id: 'ws-1', members: [A1, NOTE, A2],
      layoutState: {
        focusedViewId: A2,
        rects: { [A1]: { x: 1, y: 2, w: 300, h: 200, z: 11, snap: { zone: 'left', restore: { w: 500, h: 400 } } }, [A2]: { x: 5, y: 5, w: 300, h: 200, z: 12 } },
        minimized: [A2],
        snapGrid: { x: 0.5, yl: 0.5, yr: 0.5 },
      },
      activities: { [A1]: { name: 'build' }, [A2]: { maximized: 'full' } },
    },
    { id: 'ws-2', members: [], layoutState: { focusedViewId: NOTE } },
  ],
});

test('renames ids in members (same slot), layoutState keys + values, activities', () => {
  const { state: s, changed } = remapWorkspaceIds(state(), { [A1]: N1 });
  assert.ok(changed);
  const w = s.workspaces[0]!;
  assert.deepEqual(w.members, [N1, NOTE, A2]);
  const rects = w.layoutState!['rects'] as Record<string, { snap?: { zone: string } }>;
  assert.ok(rects[N1] && !rects[A1]);
  assert.equal(rects[N1]!.snap!.zone, 'left', 'nested non-id strings untouched');
  assert.deepEqual(w.activities, { [N1]: { name: 'build' }, [A2]: { maximized: 'full' } });
  assert.deepEqual(w.layoutState!['snapGrid'], { x: 0.5, yl: 0.5, yr: 0.5 });
});

test('drops dead ids everywhere', () => {
  const { state: s } = remapWorkspaceIds(state(), {}, [A2]);
  const w = s.workspaces[0]!;
  assert.deepEqual(w.members, [A1, NOTE]);
  assert.equal(w.layoutState!['focusedViewId'], undefined);
  assert.deepEqual(w.layoutState!['minimized'], []);
  assert.ok(!(A2 in (w.layoutState!['rects'] as object)));
  assert.ok(!(A2 in (w.activities as object)));
  assert.equal(s.workspaces[1]!.layoutState!['focusedViewId'], NOTE, 'other workspaces keep live ids');
});

test('two old ids onto one new view: first slot wins, no duplicates', () => {
  const { state: s } = remapWorkspaceIds(state(), { [A1]: N1, [A2]: N1 });
  const w = s.workspaces[0]!;
  assert.deepEqual(w.members, [N1, NOTE]);
  assert.deepEqual(w.layoutState!['minimized'], [N1]);
  assert.equal((w.layoutState!['rects'] as Record<string, { z: number }>)[N1]!.z, 11);
});

test('a renamed id is never treated as dead; no-op reports unchanged; input untouched', () => {
  const before = state();
  const { state: s } = remapWorkspaceIds(before, { [A1]: N1 }, [N1]);
  assert.ok(s.workspaces[0]!.members.includes(N1));
  assert.equal(remapWorkspaceIds(state(), {}).changed, false);
  assert.deepEqual(before, state(), 'pure');
  assert.deepEqual(allMembers(state()).sort(), [A1, A2, NOTE].sort());
});

test('legacy per-activity state (`windows`, maximized "window") is migrated', () => {
  const legacy = state();
  const w = legacy.workspaces[0]! as Record<string, unknown>;
  w['windows'] = { [A1]: { name: 'old' }, [NOTE]: { maximized: 'window' } };
  delete w['activities'];
  const { state: s, changed } = remapWorkspaceIds(legacy, {});
  assert.ok(changed);
  const out = s.workspaces[0]! as Record<string, unknown>;
  assert.equal(out['windows'], undefined);
  assert.deepEqual(out['activities'], { [A1]: { name: 'old' }, [NOTE]: { maximized: 'area' } });
});
