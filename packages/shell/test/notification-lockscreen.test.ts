// Phase 5 (lock screen) on the client side, DOM-free: the store waits for
// the client session before its first load, re-syncs the lock state before a
// reconnect reload, and `wipe()` drops everything at once and discards
// anything still loading in the old view. Plus the API client's session
// header and clear-history call, and viewerFor's "only anonymous callers are
// screens" rule.
//
//   cd packages/shell && npx tsx --test test/notification-lockscreen.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NotificationClientStore, type BusEvent, type StoreChange } from '../src/lib/notifications/store.ts';
import { NotificationApiClient } from '../src/lib/notifications/api.ts';
import { NotificationActions } from '../src/lib/notifications/actions.ts';
import type { Notification } from '../src/lib/notifications/api.ts';
import { clientSessionIdFrom, viewerFor } from '../src/lib/clientSession.ts';

let seq = 0;
function ntf(p: Partial<Notification> & { id: string }): Notification {
  return {
    type: 'simple', title: p.id, text: '', priority: 'medium', visibility: 'private', pinned: false, popup: false,
    caller: { kind: 'anonymous', verification: 'unverified' }, sender: { kind: 'unknown', attribution: 'unverified' },
    senderKey: 'anon:rest', state: 'active', createdAt: 1000 + (seq++), updatedAt: 1000, history: [],
    ...p,
  } as Notification;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
async function settle(n = 8) { for (let i = 0; i < n; i++) await tick(); }

class FakeEvents {
  handlers = new Set<(ev: BusEvent) => void>();
  reconnect = new Set<() => void>();
  subscribe(_p: string | string[], h: (ev: BusEvent) => void) { this.handlers.add(h); return () => { this.handlers.delete(h); }; }
  onReconnect(fn: () => void) { this.reconnect.add(fn); return () => { this.reconnect.delete(fn); }; }
  emit(ev: BusEvent) { for (const h of this.handlers) h(ev); }
}

/** A server whose answers depend on the "lock state" (full vs redacted view). */
class ViewApi {
  locked = false;
  server = new Map<string, Notification>();
  log: string[] = [];
  listGate: Promise<void> | null = null;
  view(n: Notification): Notification | null {
    if (!this.locked) return n;
    if (n.visibility === 'secret') return null;
    return { ...n, title: 'New notification', text: '', redacted: true, lockscreen: true } as Notification;
  }
  async get(id: string) {
    this.log.push(`get:${id}`);
    await tick();
    const n = this.server.get(id);
    return n ? this.view(n) : null;
  }
  async listAll() {
    this.log.push(`list:${this.locked ? 'locked' : 'unlocked'}`);
    // Answers in the view that was current when the request was made.
    const out = [...this.server.values()].filter((n) => n.state === 'active').map((n) => this.view(n)).filter(Boolean) as Notification[];
    if (this.listGate) await this.listGate;
    return out;
  }
}

test('start waits for the client session before the first load', async () => {
  const api = new ViewApi();
  api.server.set('ntf_a', ntf({ id: 'ntf_a' }));
  let release!: () => void;
  const ready = new Promise<void>((r) => { release = r; });
  const store = new NotificationClientStore({ api, events: new FakeEvents(), session: { ready: () => ready, sync: async () => true }, warn: () => {} });
  void store.start();
  await settle();
  assert.deepEqual(api.log, [], 'nothing is loaded before the session exists');
  release();
  await settle();
  assert.deepEqual(api.log, ['list:unlocked']);
  assert.equal(store.sorted.length, 1);
});

test('reconnect: the lock state is synced BEFORE the reload', async () => {
  const api = new ViewApi();
  const events = new FakeEvents();
  const order: string[] = [];
  const store = new NotificationClientStore({
    api: { get: (id) => api.get(id), listAll: async () => { order.push('list'); return api.listAll(); } },
    events,
    session: { ready: async () => {}, sync: async () => { order.push('sync'); await tick(); return true; } },
    warn: () => {},
  });
  await store.start();
  order.length = 0;
  for (const fn of events.reconnect) fn();
  await settle();
  assert.deepEqual(order, ['sync', 'list']);
  // A failed sync still reloads (the server then treats the tab as locked).
  order.length = 0;
  const store2 = new NotificationClientStore({
    api: { get: (id) => api.get(id), listAll: async () => { order.push('list'); return api.listAll(); } },
    events,
    session: { ready: async () => {}, sync: async () => { order.push('sync'); throw new Error('offline'); } },
    warn: () => {},
  });
  await store2.start();
  order.length = 0;
  for (const fn of [...events.reconnect]) fn();
  await settle();
  assert.ok(order.includes('sync') && order.indexOf('sync') < order.lastIndexOf('list'));
});

test('wipe drops every item at once, ignores events and in-flight loads; resume reloads in the new view', async () => {
  const api = new ViewApi();
  const events = new FakeEvents();
  api.server.set('ntf_p', ntf({ id: 'ntf_p', title: 'secret plans', text: 'details', visibility: 'private' }));
  api.server.set('ntf_s', ntf({ id: 'ntf_s', title: 'top secret', visibility: 'secret' }));
  const store = new NotificationClientStore({ api, events, warn: () => {} });
  const seen: StoreChange[][] = [];
  store.subscribe((_s, ch) => { if (ch.length) seen.push([...ch]); });
  await store.start();
  await settle();
  assert.equal(store.sorted.length, 2);

  // A live fetch is in flight when the screen locks.
  api.server.set('ntf_new', ntf({ id: 'ntf_new', title: 'new full content' }));
  events.emit({ type: 'notification:created', eventId: '9-0', id: 'ntf_new', state: 'active' });
  await tick();
  store.wipe();
  assert.equal(store.sorted.length, 0, 'empty synchronously');
  assert.equal(store.isSuspended, true);
  await settle();
  assert.equal(store.get('ntf_new'), undefined, 'the in-flight full item was discarded');
  const removed = seen.flat().filter((c) => c.kind === 'removed').map((c) => c.id).sort();
  assert.deepEqual(removed, ['ntf_p', 'ntf_s']);

  // Events while suspended: nothing is fetched.
  const before = api.log.length;
  events.emit({ type: 'notification:updated', eventId: '10-0', id: 'ntf_p', state: 'active' });
  await settle();
  assert.equal(api.log.length, before);
  await store.refetch();
  assert.equal(api.log.length, before, 'refetch is a no-op while suspended');

  // The server acked the lock → resume loads the redacted view.
  api.locked = true;
  await store.resume();
  await settle();
  const items = store.sorted;
  assert.equal(items.length, 2, 'private + the new one; secret is left out by the server');
  assert.ok(items.every((n) => n.lockscreen === true && n.text === ''));
  assert.equal(items.some((n) => n.title === 'secret plans'), false);

  // Unlock: wipe + resume → full content again.
  api.locked = false;
  store.wipe();
  await store.resume();
  await settle();
  assert.equal(store.sorted.length, 3);
  assert.ok(store.sorted.some((n) => n.title === 'top secret'));
});

test('wipe during a running list load: its result never lands', async () => {
  const api = new ViewApi();
  api.server.set('ntf_x', ntf({ id: 'ntf_x', title: 'full' }));
  let open!: () => void;
  api.listGate = new Promise<void>((r) => { open = r; });
  const store = new NotificationClientStore({ api, events: new FakeEvents(), warn: () => {} });
  const p = store.start();
  await tick();
  store.wipe();
  open();
  await p;
  await settle();
  assert.equal(store.sorted.length, 0);
});

test('api client: every request carries the session headers; clearHistory path', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(url.includes('/history') ? { deleted: 2 } : { items: [] }), { status: 200 });
  };
  let sid: string | null = null;
  const api = new NotificationApiClient({ fetch, headers: (): Record<string, string> => (sid ? { 'X-Aura-Client-Session': sid } : {}) });
  await api.list({ state: 'active' });
  assert.equal((calls[0]!.init!.headers as Record<string, string>)['X-Aura-Client-Session'], undefined);
  sid = 'cs1.abc.def';
  await api.list({ state: 'active' });
  assert.equal((calls[1]!.init!.headers as Record<string, string>)['X-Aura-Client-Session'], 'cs1.abc.def');
  const r = await api.clearHistory('app:com.x');
  assert.deepEqual(r, { deleted: 2 });
  assert.equal(calls[2]!.url, '/api/notifications/history?sender=app%3Acom.x');
  assert.equal(calls[2]!.init!.method, 'DELETE');
  assert.equal((calls[2]!.init!.headers as Record<string, string>)['X-Aura-Client-Session'], 'cs1.abc.def');

  // Actions: clear by sender + clear history never throw.
  const store = new NotificationClientStore({ api: { get: async () => null, listAll: async () => [] }, warn: () => {} });
  const actions = new NotificationActions(api, store);
  const c = await actions.clearSender('app:com.x');
  assert.equal(c.ok, true);
  assert.ok(calls.some((x) => x.url === '/api/notifications?sender=app%3Acom.x' && x.init?.method === 'DELETE'));
  const h = await actions.clearHistory();
  assert.equal(h.ok, true);
});

test('viewerFor: only anonymous callers are screens; the sid comes from the header or ?cs=', async () => {
  const req = (h: Record<string, string> = {}, q = '') => new Request(`http://x/api/notifications${q}`, { headers: h });
  assert.equal(clientSessionIdFrom(req({ 'X-Aura-Client-Session': ' cs1.a.b ' })), 'cs1.a.b');
  assert.equal(clientSessionIdFrom(req({}, '?cs=cs1.q.r')), 'cs1.q.r');
  assert.equal(clientSessionIdFrom(req()), null);
  const inst = { kind: 'instance', appId: 'com.x', instanceId: 'com.x-1', verification: 'verified' } as const;
  const v = await viewerFor(req({ 'X-Aura-Client-Session': 'cs1.a.b' }), inst as never);
  assert.equal(v.screen, undefined, 'an app is not a screen');
  const anon = await viewerFor(req(), { kind: 'anonymous', verification: 'unverified' } as never, { senderToken: 'nst_x' });
  assert.equal(anon.screen, undefined);
  assert.equal(anon.senderToken, 'nst_x');
});
