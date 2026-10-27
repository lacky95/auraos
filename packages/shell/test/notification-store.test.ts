// NotificationClientStore: sorting, event de-duplication and coalescing,
// reconnect refetch, races, disposal. DOM-free — fake API + event source.
//
//   cd packages/shell && npx tsx --test test/notification-store.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NotificationClientStore, compareNotifications, type BusEvent } from '../src/lib/notifications/store.ts';
import { NotificationActions } from '../src/lib/notifications/actions.ts';
import { NotificationApiClient, NotificationApiError } from '../src/lib/notifications/api.ts';
import type { Notification } from '../src/lib/notifications/api.ts';

let seq = 0;
function ntf(p: Partial<Notification> & { id: string }): Notification {
  return {
    type: 'simple', title: p.id, text: '', priority: 'medium', visibility: 'private', pinned: false, popup: false,
    caller: { kind: 'anonymous', verification: 'unverified' }, sender: { kind: 'unknown', attribution: 'unverified' },
    senderKey: 'anon:rest', state: 'active', createdAt: 1000 + (seq++), updatedAt: 1000, history: [],
    ...p,
  } as Notification;
}

class FakeEvents {
  handlers = new Set<(ev: BusEvent) => void>();
  reconnect = new Set<() => void>();
  subscribe(_p: string | string[], h: (ev: BusEvent) => void) { this.handlers.add(h); return () => { this.handlers.delete(h); }; }
  onReconnect(fn: () => void) { this.reconnect.add(fn); return () => { this.reconnect.delete(fn); }; }
  emit(ev: BusEvent) { for (const h of this.handlers) h(ev); }
}

class FakeApi {
  server = new Map<string, Notification>();
  gets: string[] = [];
  lists = 0;
  listGate: Promise<void> | null = null;
  async get(id: string) { this.gets.push(id); await tick(); return this.server.get(id) ?? null; }
  async listAll() {
    this.lists++;
    const snap = [...this.server.values()].filter((n) => n.state === 'active');
    if (this.listGate) await this.listGate;
    return snap;
  }
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
async function settle(n = 6) { for (let i = 0; i < n; i++) await tick(); }

function setup() {
  const api = new FakeApi();
  const events = new FakeEvents();
  const store = new NotificationClientStore({ api, events, warn: () => {} });
  return { api, events, store };
}

test('sort: pinned first, then urgent > high > medium > low, then newest', () => {
  const list = [
    ntf({ id: 'ntf_low', priority: 'low', createdAt: 50 }),
    ntf({ id: 'ntf_med_old', priority: 'medium', createdAt: 10 }),
    ntf({ id: 'ntf_med_new', priority: 'medium', createdAt: 90 }),
    ntf({ id: 'ntf_urgent', priority: 'urgent', createdAt: 5 }),
    ntf({ id: 'ntf_high', priority: 'high', createdAt: 70 }),
    ntf({ id: 'ntf_pinned_low', priority: 'low', pinned: true, createdAt: 1 }),
    ntf({ id: 'ntf_pinned_high', priority: 'high', pinned: true, createdAt: 2 }),
  ];
  assert.deepEqual(list.sort(compareNotifications).map((n) => n.id), [
    'ntf_pinned_high', 'ntf_pinned_low', 'ntf_urgent', 'ntf_high', 'ntf_med_new', 'ntf_med_old', 'ntf_low',
  ]);
});

test('start loads the active list; snapshot has the sorted view and unseenCount', async () => {
  const { api, store } = setup();
  api.server.set('ntf_a', ntf({ id: 'ntf_a', priority: 'low' }));
  api.server.set('ntf_b', ntf({ id: 'ntf_b', priority: 'high', seenAt: 5 }));
  api.server.set('ntf_c', ntf({ id: 'ntf_c', state: 'removed' }));
  const snaps: Array<{ ids: string[]; unseen: number; ready: boolean; changes: string[] }> = [];
  store.subscribe((s, ch) => snaps.push({ ids: s.items.map((n) => n.id), unseen: s.unseenCount, ready: s.ready, changes: ch.map((c) => `${c.kind}:${c.id}:${c.source}`) }));
  await store.start();
  await settle();
  const last = snaps.at(-1)!;
  assert.deepEqual(last.ids, ['ntf_b', 'ntf_a']);
  assert.equal(last.unseen, 1);
  assert.equal(last.ready, true);
  assert.deepEqual(last.changes.sort(), ['added:ntf_a:initial', 'added:ntf_b:initial']);
  assert.equal(snaps[0]!.ready, false);   // immediate snapshot on subscribe
});

test('live events: dedupe by eventId, coalesce per id, removed/resolved drop without a fetch', async () => {
  const { api, events, store } = setup();
  await store.start();
  const changes: string[] = [];
  store.subscribe((_s, ch) => changes.push(...ch.map((c) => `${c.kind}:${c.id}:${c.source}`)));

  api.server.set('ntf_x', ntf({ id: 'ntf_x' }));
  events.emit({ type: 'notification:created', eventId: '1-0', id: 'ntf_x', state: 'active' });
  events.emit({ type: 'notification:created', eventId: '1-0', id: 'ntf_x', state: 'active' });   // duplicate
  events.emit({ type: 'notification:displayed', eventId: '1-1', id: 'ntf_x', state: 'active' }); // coalesced
  events.emit({ type: 'notification', appId: 'legacy', title: 't', body: 'b' });                 // legacy: ignored
  await settle();
  assert.deepEqual(api.gets, ['ntf_x']);
  assert.deepEqual(changes, ['added:ntf_x:live']);
  assert.equal(store.get('ntf_x')?.id, 'ntf_x');

  // An update fetches again; the same revision does not emit a change.
  api.server.set('ntf_x', ntf({ id: 'ntf_x', updatedAt: 2000, title: 'new' }));
  events.emit({ type: 'notification:updated', eventId: '1-2', id: 'ntf_x', state: 'active' });
  await settle();
  assert.equal(store.get('ntf_x')?.title, 'new');
  assert.deepEqual(changes.at(-1), 'updated:ntf_x:live');

  const gets = api.gets.length;
  events.emit({ type: 'notification:resolved', eventId: '1-3', id: 'ntf_x', state: 'resolved' });
  await settle();
  assert.equal(api.gets.length, gets);   // no fetch for a terminal state
  assert.equal(store.get('ntf_x'), undefined);
  assert.deepEqual(changes.at(-1), 'removed:ntf_x:live');
});

test('an event during an in-flight fetch fetches once more afterwards (latest wins)', async () => {
  const { api, events, store } = setup();
  await store.start();
  api.server.set('ntf_p', ntf({ id: 'ntf_p', updatedAt: 1 }));
  events.emit({ type: 'notification:created', eventId: '2-0', id: 'ntf_p', state: 'active' });
  await tick();   // flush scheduled → fetch in flight
  api.server.set('ntf_p', ntf({ id: 'ntf_p', updatedAt: 2, components: [{ kind: 'progress', value: 0.5 }] }));
  events.emit({ type: 'notification:updated', eventId: '2-1', id: 'ntf_p', state: 'active' });
  await settle(10);
  assert.deepEqual(api.gets, ['ntf_p', 'ntf_p']);
  assert.equal(store.get('ntf_p')?.updatedAt, 2);
});

test('older responses never overwrite newer state (seenAt counts, updatedAt alone does not)', () => {
  const { store } = setup();
  store.apply(ntf({ id: 'ntf_t', updatedAt: 10, title: 'new' }));
  store.apply(ntf({ id: 'ntf_t', updatedAt: 5, title: 'old' }));
  assert.equal(store.get('ntf_t')?.title, 'new');
  store.apply(ntf({ id: 'ntf_t', updatedAt: 10, title: 'new', seenAt: 20 }));
  store.apply(ntf({ id: 'ntf_t', updatedAt: 10, title: 'new' }));   // stale copy without the seen mark
  assert.equal(store.get('ntf_t')?.seenAt, 20);
});

test('reconnect → full refetch; items missing from the list are dropped', async () => {
  const { api, events, store } = setup();
  api.server.set('ntf_keep', ntf({ id: 'ntf_keep' }));
  api.server.set('ntf_gone', ntf({ id: 'ntf_gone' }));
  await store.start();
  await settle();
  assert.equal(api.lists, 1);
  // While "offline": one removed, one created — no events seen.
  api.server.delete('ntf_gone');
  api.server.set('ntf_new', ntf({ id: 'ntf_new' }));
  const changes: string[] = [];
  store.subscribe((_s, ch) => changes.push(...ch.map((c) => `${c.kind}:${c.id}:${c.source}`)));
  for (const fn of events.reconnect) fn();
  await settle();
  assert.equal(api.lists, 2);
  assert.deepEqual(store.sorted.map((n) => n.id).sort(), ['ntf_keep', 'ntf_new']);
  assert.deepEqual(changes.sort(), ['added:ntf_new:refetch', 'removed:ntf_gone:refetch']);
});

test('refetch race: an item created by a live event during the load is not dropped', async () => {
  const { api, events, store } = setup();
  await store.start();
  let open!: () => void;
  api.listGate = new Promise((r) => { open = r; });
  const p = store.refetch();          // list snapshot taken now (empty)
  api.server.set('ntf_race', ntf({ id: 'ntf_race' }));
  events.emit({ type: 'notification:created', eventId: '3-0', id: 'ntf_race', state: 'active' });
  await settle();                     // live fetch done while the list is still loading
  assert.ok(store.get('ntf_race'));
  open();
  await p;
  assert.ok(store.get('ntf_race'), 'kept although the (older) list did not have it');
});

test('load errors (401/403) are reported in the snapshot, not thrown', async () => {
  const api = { get: async () => null, listAll: async () => { throw new NotificationApiError(403, 'forbidden'); } };
  const store = new NotificationClientStore({ api, warn: () => {} });
  await store.start();
  await settle();
  const s = store.snapshot();
  assert.equal(s.ready, false);
  assert.deepEqual(s.error, { status: 403, message: 'forbidden' });
});

test('dispose unsubscribes from the bus and the reconnect hook', async () => {
  const { events, store } = setup();
  await store.start();
  assert.equal(events.handlers.size, 1);
  assert.equal(events.reconnect.size, 1);
  store.dispose();
  assert.equal(events.handlers.size, 0);
  assert.equal(events.reconnect.size, 0);
  store.handleEvent({ type: 'notification:created', eventId: '9-9', id: 'ntf_z', state: 'active' }); // no throw
  assert.equal(store.isDisposed, true);
});

test('actions: seen/displayed once per id, results applied, errors returned not thrown', async () => {
  const calls: string[] = [];
  const store = new NotificationClientStore({ api: { get: async () => null, listAll: async () => [ntf({ id: 'ntf_l', type: 'locked' })] }, warn: () => {} });
  store.apply(ntf({ id: 'ntf_s' }));
  store.apply(ntf({ id: 'ntf_l', type: 'locked' }));
  const api = {
    markDisplayed: async (id: string) => { calls.push(`displayed:${id}`); return ntf({ id, displayedAt: 1, updatedAt: 1000 }); },
    markSeen: async (id: string) => { calls.push(`seen:${id}`); return ntf({ id, seenAt: 2000, displayedAt: 2000, updatedAt: 1000 }); },
    dismiss: async (id: string) => { calls.push(`dismiss:${id}`); if (id === 'ntf_l') throw new NotificationApiError(409, 'locked notifications cannot be dismissed'); return ntf({ id, state: 'removed', updatedAt: 1001 }); },
    resolve: async (id: string, a: unknown) => { calls.push(`resolve:${id}:${JSON.stringify(a)}`); return ntf({ id, state: 'resolved', updatedAt: 1002 }); },
    interact: async (id: string, p: unknown) => { calls.push(`interact:${id}:${JSON.stringify(p)}`); throw new NotificationApiError(401, 'invalid credential'); },
    forceRemove: async (id: string) => ntf({ id, state: 'removed' }),
    clear: async () => ({ cleared: 1, skippedLocked: 1 }),
  };
  const actions = new NotificationActions(api as never, store);
  actions.markSeen(['ntf_s']);
  actions.markSeen(['ntf_s']);
  actions.markDisplayed('ntf_s');
  await settle();
  assert.deepEqual(calls, ['seen:ntf_s']);
  assert.equal(store.get('ntf_s')?.seenAt, 2000);
  const locked = await actions.dismiss('ntf_l');
  assert.equal(locked.ok, false);
  assert.ok(store.get('ntf_l'), 'a refused dismiss keeps the item');
  const denied = await actions.interact('ntf_s', { componentId: 'b' });
  assert.deepEqual(denied, { ok: false, status: 401, error: 'Not allowed: invalid credential' });
  const r = await actions.resolve('ntf_s', { buttonId: 'ok', values: { note: 'x' } });
  assert.equal(r.ok, true);
  assert.equal(store.get('ntf_s'), undefined);
});

test('api client: paths, bodies, error mapping', async () => {
  const seen: Array<{ url: string; method: string; body?: string }> = [];
  const fetchFake = async (url: string, init?: RequestInit) => {
    seen.push({ url, method: init?.method ?? 'GET', ...(init?.body ? { body: String(init.body) } : {}) });
    if (url.endsWith('/ntf_missing')) return new Response(JSON.stringify({ error: 'notification not found' }), { status: 404 });
    if (url.includes('/interact')) return new Response(JSON.stringify({ error: 'not allowed', details: { x: 1 } }), { status: 403 });
    if (url.includes('?limit=200')) return new Response(JSON.stringify({ items: [ntf({ id: 'ntf_1' })] }));
    return new Response(JSON.stringify({ id: 'ntf_1' }));
  };
  const api = new NotificationApiClient({ fetch: fetchFake as never, base: 'http://h/' });
  assert.equal(await api.get('ntf_missing'), null);
  await api.resolve('ntf_1', { buttonId: 'ok', values: {} });
  await api.markSeen('ntf_1');
  await api.dismiss('ntf_1');
  await api.clear({ priority: 'low' });
  const all = await api.listAll({ state: 'active' });
  assert.equal(all.length, 1);
  await assert.rejects(api.interact('ntf_1', { componentId: 'b' }), (e: unknown) => e instanceof NotificationApiError && e.status === 403 && e.isAuthError);
  assert.deepEqual(seen.map((s) => `${s.method} ${s.url}${s.body ? ' ' + s.body : ''}`), [
    'GET http://h/api/notifications/ntf_missing',
    'POST http://h/api/notifications/ntf_1/resolve {"answer":{"buttonId":"ok","values":{}}}',
    'POST http://h/api/notifications/ntf_1/seen',
    'DELETE http://h/api/notifications/ntf_1',
    'DELETE http://h/api/notifications?priority=low',
    'GET http://h/api/notifications?limit=200&state=active',
    'POST http://h/api/notifications/ntf_1/interact {"componentId":"b"}',
  ]);
});

test('counts: totalCount (locked included), unseenCount, highestUnseenPriority, newestUnseen', () => {
  const { store } = setup();
  let s = store.snapshot();
  assert.deepEqual([s.totalCount, s.unseenCount, s.highestUnseenPriority, s.newestUnseen], [0, 0, null, null]);
  store.apply(ntf({ id: 'ntf_seen_urgent', priority: 'urgent', seenAt: 5, createdAt: 50 }));
  store.apply(ntf({ id: 'ntf_locked', type: 'locked', priority: 'low', seenAt: 5, createdAt: 60 }));
  s = store.snapshot();
  assert.deepEqual([s.totalCount, s.unseenCount, s.highestUnseenPriority], [2, 0, null]);   // 0 new, n total
  store.apply(ntf({ id: 'ntf_new_med', priority: 'medium', createdAt: 70 }));
  store.apply(ntf({ id: 'ntf_new_high', priority: 'high', createdAt: 65 }));
  s = store.snapshot();
  assert.deepEqual([s.totalCount, s.unseenCount, s.highestUnseenPriority, s.newestUnseen?.id], [4, 2, 'high', 'ntf_new_med']);
  store.apply(ntf({ id: 'ntf_new_urgent', priority: 'urgent', createdAt: 66 }));
  assert.equal(store.highestUnseenPriority, 'urgent');
  assert.equal(store.newestUnseen?.id, 'ntf_new_med');
});

test('mostImportant: unseen > seen, then pinned, then priority, then newest; null when empty', () => {
  const { store } = setup();
  assert.equal(store.snapshot().mostImportant, null);
  store.apply(ntf({ id: 'ntf_seen_urgent_pinned', priority: 'urgent', pinned: true, seenAt: 5, createdAt: 90 }));
  assert.equal(store.mostImportant?.id, 'ntf_seen_urgent_pinned');          // only item, seen
  store.apply(ntf({ id: 'ntf_new_low', priority: 'low', createdAt: 10 }));
  assert.equal(store.mostImportant?.id, 'ntf_new_low');                    // unseen beats seen
  store.apply(ntf({ id: 'ntf_new_high', priority: 'high', createdAt: 20 }));
  assert.equal(store.mostImportant?.id, 'ntf_new_high');                   // priority
  store.apply(ntf({ id: 'ntf_new_pinned_low', priority: 'low', pinned: true, createdAt: 5 }));
  assert.equal(store.mostImportant?.id, 'ntf_new_pinned_low');             // pinned beats priority
  store.apply(ntf({ id: 'ntf_new_pinned_low2', priority: 'low', pinned: true, createdAt: 6 }));
  assert.equal(store.snapshot().mostImportant?.id, 'ntf_new_pinned_low2'); // newest on a tie
  for (const id of ['ntf_new_low', 'ntf_new_high', 'ntf_new_pinned_low', 'ntf_new_pinned_low2']) store.drop(id);
  store.apply(ntf({ id: 'ntf_seen_med', priority: 'medium', seenAt: 5, createdAt: 100 }));
  assert.equal(store.mostImportant?.id, 'ntf_seen_urgent_pinned');         // all seen: pinned urgent
});
