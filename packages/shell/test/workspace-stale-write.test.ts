// Conditional workspace writes: a client whose cache fell behind (a tab
// resumed after a day) must not roll newer workspaces back — it gets 409 and
// replays its change on the current state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as wc from '../src/lib/workspaceClient.ts';
import type { Workspace, WorkspaceState } from '../src/lib/workspaceClient.ts';

function ws(id: string, members: string[] = []): Workspace {
  return { id, name: id, layoutId: 'tiling', members };
}

/** In-memory stand-in for `/api/kv/os/workspaces` with the server's `ifUpdatedAt` rule. */
function fakeServer(initial: WorkspaceState, updatedAt: number) {
  const srv = { entry: { value: initial, updatedAt }, puts: [] as Array<{ ifUpdatedAt?: number; status: number }> };
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    if (init?.method !== 'PUT') return new Response(JSON.stringify(srv.entry), { status: 200 });
    const body = JSON.parse(String(init.body)) as { value: WorkspaceState; ifUpdatedAt?: number };
    if (body.ifUpdatedAt !== undefined && body.ifUpdatedAt !== srv.entry.updatedAt) {
      srv.puts.push({ ifUpdatedAt: body.ifUpdatedAt, status: 409 });
      return new Response(JSON.stringify({ error: 'stale', current: srv.entry }), { status: 409 });
    }
    srv.puts.push({ ifUpdatedAt: body.ifUpdatedAt, status: 200 });
    srv.entry = { value: body.value, updatedAt: srv.entry.updatedAt + 1 };
    return new Response(JSON.stringify(srv.entry), { status: 200 });
  }) as typeof fetch;
  return srv;
}

test('a stale cache replays its change instead of overwriting newer workspaces', async () => {
  // The day-old page: 3 workspaces at version 100.
  wc.hydrate({ activeWorkspaceId: 'ws-3', workspaces: [ws('ws-1', ['a']), ws('ws-2'), ws('ws-3', ['old'])] }, 100);
  // Meanwhile another device made it 5 (version 200).
  const srv = fakeServer({
    activeWorkspaceId: 'ws-5',
    workspaces: [ws('ws-1', ['a']), ws('ws-2', ['b']), ws('ws-4', ['c']), ws('ws-5', ['d']), ws('ws-6', ['e'])],
  }, 200);

  await wc.setActive('ws-1');

  assert.deepEqual(srv.puts.map((p) => p.status), [409, 200]);
  assert.equal(srv.puts[1]!.ifUpdatedAt, 200);
  assert.deepEqual(srv.entry.value.workspaces.map((w) => w.id), ['ws-1', 'ws-2', 'ws-4', 'ws-5', 'ws-6']);
  assert.equal(srv.entry.value.activeWorkspaceId, 'ws-1');
  assert.deepEqual(wc.getCached(), srv.entry.value);
});

test('the next write is based on the version the server returned', async () => {
  wc.hydrate({ activeWorkspaceId: 'ws-1', workspaces: [ws('ws-1', ['a', 'x'])] }, 7);
  const srv = fakeServer({ activeWorkspaceId: 'ws-1', workspaces: [ws('ws-1', ['a', 'x'])] }, 7);
  await wc.removeMember('x');
  await wc.createWorkspace();
  assert.deepEqual(srv.puts, [{ ifUpdatedAt: 7, status: 200 }, { ifUpdatedAt: 8, status: 200 }]);
  assert.deepEqual(srv.entry.value.workspaces.map((w) => [w.id, w.members]), [['ws-1', ['a']], ['ws-2', []]]);
});

test('a change that no longer applies after the rebase writes nothing', async () => {
  wc.hydrate({ activeWorkspaceId: 'ws-1', workspaces: [ws('ws-1'), ws('ws-2', ['v'])] }, 1);
  const srv = fakeServer({ activeWorkspaceId: 'ws-1', workspaces: [ws('ws-1'), ws('ws-3', ['w'])] }, 2);
  await wc.removeMember('v');   // `v` is already gone on the server
  assert.deepEqual(srv.puts.map((p) => p.status), [409]);
  assert.deepEqual(srv.entry.value.workspaces.map((w) => w.id), ['ws-1', 'ws-3']);
  assert.deepEqual(wc.getCached(), srv.entry.value);
});

test('createWorkspace picks its id from the rebased state', async () => {
  wc.hydrate({ activeWorkspaceId: 'ws-1', workspaces: [ws('ws-1', ['a'])] }, 1);
  const srv = fakeServer({ activeWorkspaceId: 'ws-1', workspaces: [ws('ws-1', ['a']), ws('ws-2', ['b'])] }, 5);
  const created = await wc.createWorkspace();
  assert.equal(created.id, 'ws-3');
  assert.deepEqual(srv.entry.value.workspaces.map((w) => w.id), ['ws-1', 'ws-2', 'ws-3']);
});
