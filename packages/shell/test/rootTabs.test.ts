// Phase 5 stream J.6: `aura root`'s route logic (lib/rootTabs.ts) with its
// dependencies faked: only the owner's own System Terminal, a fresh approval,
// refused while the aura-root switch is off, a single-use grant, End.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RootGrants } from '@aura/core';
import { endRootTabs, listRootTabs, postRootTab, type RootTabDeps } from '../src/lib/rootTabs.ts';

const TERM = { appId: 'com.aura.terminal', instanceId: 'com.aura.terminal-1', owner: 'default' };
const ctx = (body: unknown, url = 'http://x/api/admin/root') => ({ request: new Request(url, { method: 'POST', body: JSON.stringify(body) }) }) as never;

function deps(o: { enabled?: boolean; approve?: boolean; instances?: Record<string, unknown> } = {}) {
  const asked: Array<Record<string, unknown>> = [];
  const audits: string[] = [];
  const grants = new RootGrants();
  const ended: Array<string | undefined> = [];
  const d: RootTabDeps = {
    ownerAction: async (_c, req) => { asked.push(req as never); return o.approve === false ? new Response('{}', { status: 202 }) : { by: { kind: 'operator' }, detail: {} } as never; },
    audit: async (_a, action) => { audits.push(action); },
    mgr: {
      getInstance: (id: string) => (o.instances ?? { [TERM.instanceId]: TERM })[id] as never,
      rootGrants: grants,
      openSessions: () => [{ sessionId: 's1', instanceId: TERM.instanceId, kind: 'root', home: 'private', uid: 0, launcherPid: 9, startedAt: 'now', userId: 'default' }, { sessionId: 's2', instanceId: 'x-1', kind: 'user', home: 'private', uid: 1000, launcherPid: 8, startedAt: 'now' }],
      endRootSessions: async (id?: string) => { ended.push(id); return ['s1']; },
    } as never,
    enabled: async () => o.enabled !== false,
  };
  return { d, asked, audits, grants, ended };
}

test('a grant only for the owner\'s own System Terminal, after a fresh approval; audited', async () => {
  const t = deps();
  const res = await postRootTab(ctx({ instanceId: TERM.instanceId }), t.d);
  assert.equal(res.status, 200);
  const body = await res.json() as { grant: string };
  assert.equal(t.asked[0]!['level'], 'fresh');
  assert.deepEqual(t.audits, ['root.granted']);
  assert.equal(t.grants.consume(body.grant, 'default', TERM.instanceId), true);
});

test('refused: switch off, not a Terminal, another user\'s Terminal, a pool member, bad body, not approved', async () => {
  assert.equal((await postRootTab(ctx({ instanceId: TERM.instanceId }), deps({ enabled: false }).d)).status, 403);
  const other = { 'io.x-1': { appId: 'io.x', instanceId: 'io.x-1', owner: 'default' }, 'com.aura.terminal-2': { ...TERM, instanceId: 'com.aura.terminal-2', owner: 'u-bob' }, 'com.aura.terminal-3': { ...TERM, instanceId: 'com.aura.terminal-3', inPool: true } };
  for (const id of Object.keys(other)) {
    const t = deps({ instances: other });
    assert.equal((await postRootTab(ctx({ instanceId: id }), t.d)).status, 409, id);
    assert.equal(t.asked.length, 0, 'nothing is asked for a refused target');
  }
  assert.equal((await postRootTab(ctx({}), deps().d)).status, 400);
  const t = deps({ approve: false });
  assert.equal((await postRootTab(ctx({ instanceId: TERM.instanceId }), t.d)).status, 202);
  assert.deepEqual(t.audits, []);
});

test('list shows root tabs only; End ends them', async () => {
  const t = deps();
  const list = await (await listRootTabs(ctx({}), t.d)).json() as { tabs: Array<{ sessionId: string }> };
  assert.deepEqual(list.tabs.map((x) => x.sessionId), ['s1']);
  const end = await (await endRootTabs({ request: new Request(`http://x/api/admin/root?instanceId=${TERM.instanceId}`, { method: 'DELETE' }) } as never, t.d)).json() as { ended: string[] };
  assert.deepEqual(end.ended, ['s1']);
  assert.deepEqual(t.ended, [TERM.instanceId]);
});
