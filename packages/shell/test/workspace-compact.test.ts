// compactState: the pure core of the topbar "compact workspaces" button.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactState, canCompact, type Workspace, type WorkspaceState } from '../src/lib/workspaceClient.ts';

function ws(id: string, name: string, members: string[] = [], extra: Partial<Workspace> = {}): Workspace {
  return { id, name, layoutId: 'tiling', members, ...extra };
}

test('drops empty workspaces and keeps order', () => {
  const s: WorkspaceState = {
    activeWorkspaceId: 'ws-1',
    workspaces: [ws('ws-1', 'Main', ['a']), ws('ws-2', 'WS 2'), ws('ws-3', 'Dev', ['b']), ws('ws-4', 'WS 4')],
  };
  const out = compactState(s);
  assert.deepEqual(out.workspaces.map((w) => w.id), ['ws-1', 'ws-3']);
});

test('renumbers only exact default names by new slot', () => {
  const s: WorkspaceState = {
    activeWorkspaceId: 'ws-3',
    workspaces: [
      ws('ws-1', 'WS 1'), ws('ws-3', 'WS 3', ['a']), ws('ws-5', 'Main', ['b']),
      ws('ws-6', 'WS 2 old', ['c']), ws('ws-7', 'WS 7', ['d']),
    ],
  };
  const out = compactState(s);
  assert.deepEqual(out.workspaces.map((w) => w.name), ['WS 1', 'Main', 'WS 2 old', 'WS 4']);
});

test('survivors keep ids, members, layout and layoutState', () => {
  const layoutState = { minimized: ['a'] } as unknown as Workspace['layoutState'];
  const s: WorkspaceState = {
    activeWorkspaceId: 'ws-9',
    workspaces: [ws('ws-2', 'WS 2'), ws('ws-9', 'WS 9', ['a', 'b'], { layoutId: 'free', layoutState })],
  };
  const [w] = compactState(s).workspaces;
  assert.equal(w!.id, 'ws-9');
  assert.equal(w!.name, 'WS 1');
  assert.equal(w!.layoutId, 'free');
  assert.deepEqual(w!.members, ['a', 'b']);
  assert.deepEqual(w!.layoutState, layoutState);
});

test('non-empty active stays active', () => {
  const s: WorkspaceState = {
    activeWorkspaceId: 'ws-3',
    workspaces: [ws('ws-1', 'WS 1'), ws('ws-2', 'WS 2', ['a']), ws('ws-3', 'WS 3', ['b'])],
  };
  assert.equal(compactState(s).activeWorkspaceId, 'ws-3');
});

test('empty active switches to nearest survivor before it', () => {
  const s: WorkspaceState = {
    activeWorkspaceId: 'ws-4',
    workspaces: [ws('ws-1', 'WS 1', ['a']), ws('ws-2', 'WS 2', ['b']), ws('ws-3', 'WS 3'), ws('ws-4', 'WS 4'), ws('ws-5', 'WS 5', ['c'])],
  };
  assert.equal(compactState(s).activeWorkspaceId, 'ws-2');
});

test('empty active with no survivor before it switches to the first', () => {
  const s: WorkspaceState = {
    activeWorkspaceId: 'ws-1',
    workspaces: [ws('ws-1', 'WS 1'), ws('ws-2', 'WS 2', ['a']), ws('ws-3', 'WS 3', ['b'])],
  };
  assert.equal(compactState(s).activeWorkspaceId, 'ws-2');
});

test('all empty keeps exactly the active one', () => {
  const s: WorkspaceState = {
    activeWorkspaceId: 'ws-4',
    workspaces: [ws('ws-1', 'Main'), ws('ws-4', 'WS 4'), ws('ws-5', 'WS 5')],
  };
  const out = compactState(s);
  assert.deepEqual(out.workspaces.map((w) => [w.id, w.name]), [['ws-4', 'WS 1']]);
  assert.equal(out.activeWorkspaceId, 'ws-4');
});

test('does not mutate the input', () => {
  const s: WorkspaceState = { activeWorkspaceId: 'ws-2', workspaces: [ws('ws-1', 'WS 1', ['a']), ws('ws-2', 'WS 2')] };
  const before = JSON.stringify(s);
  compactState(s);
  assert.equal(JSON.stringify(s), before);
});

test('canCompact: idempotent, false once compacted', () => {
  const s: WorkspaceState = {
    activeWorkspaceId: 'ws-3',
    workspaces: [ws('ws-1', 'Main', ['a']), ws('ws-2', 'WS 2'), ws('ws-3', 'WS 3', ['b'])],
  };
  assert.equal(canCompact(s), true);
  const once = compactState(s);
  assert.equal(canCompact(once), false);
  assert.deepEqual(compactState(once), once);
});

test('canCompact: false for already-tidy state', () => {
  const s: WorkspaceState = {
    activeWorkspaceId: 'ws-1',
    workspaces: [ws('ws-1', 'Main', ['a']), ws('ws-7', 'WS 2', ['b']), ws('ws-8', 'Notes', ['c'])],
  };
  assert.equal(canCompact(s), false);
});
