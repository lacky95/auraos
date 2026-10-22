// NotificationService + NotificationStore against a REAL valkey-server
// (KvServer on a tmp dataDir — the same code path the shell boots).
//
//   pnpm --filter @aura/core test
//
// Covers: create/get/list, every lifecycle transition with its actor,
// caller vs sender separation, identity-override attempts, locked/popup
// gating + downgrade warnings, senderToken, the expiry sweep, the event
// stream, and persistence across a KvServer restart.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KvServer, KvClient, createRedis } from '@aura/kv-store';
import {
  NotificationService, NotificationError, SYSTEM_CALLER, isSystemCaller, KEY_EVENTS, itemKey,
  emitNotificationBusEvent,
} from '../dist/notifications/index.js';
import { OsEventBus, NOTIFICATION_BUS_EVENTS } from '../dist/ipc/OsEventBus.js';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'aura-notif-'));
let server = new KvServer();
let redis;
let clock = 1_700_000_000_000;
const now = () => clock;
const events = [];
let svc;

const APP = { kind: 'instance', appId: 'com.example.notes', instanceId: 'com.example.notes-1', verification: 'verified' };
const OTHER_APP = { kind: 'instance', appId: 'com.example.other', instanceId: 'com.example.other-1', verification: 'verified' };
const DAEMON = { kind: 'instance', appId: 'com.aura.aurashelld', instanceId: 'com.aura.aurashelld-1', verification: 'verified' };
const ANON = { kind: 'anonymous', verification: 'unverified' };
const HINTED = { kind: 'anonymous', verification: 'unverified', hints: { appId: 'com.example.notes', instanceId: 'com.example.notes-1' } };

before(async () => {
  const uri = await server.start({ dataDir: DATA_DIR });
  redis = createRedis(uri);
  svc = new NotificationService({ redis, now, onEvent: (ev) => events.push(ev) });
});

after(async () => {
  redis?.disconnect();
  await server.stop();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

async function rejectsStatus(p, status) {
  await assert.rejects(p, (err) => err instanceof NotificationError && err.status === status);
}

test('create → get round-trip with defaults; caller and sender stored separately', async () => {
  const { notification: n, senderToken, warnings } = await svc.create({ title: 'Hello', text: 'see [docs](https://x)' }, APP);
  assert.match(n.id, /^ntf_/);
  assert.equal(n.type, 'simple');
  assert.equal(n.priority, 'medium');
  assert.equal(n.visibility, 'private');
  assert.equal(n.pinned, false);
  assert.equal(n.popup, false);
  assert.equal(n.state, 'active');
  assert.deepEqual(n.caller, APP);
  assert.deepEqual(n.sender, { kind: 'app', id: 'com.example.notes', attribution: 'verified' });
  assert.equal(n.senderKey, 'app:com.example.notes');
  assert.match(senderToken, /^nst_/);
  assert.deepEqual(warnings, []);
  assert.equal(n.history.length, 1);
  assert.equal(n.history[0].event, 'created');
  assert.deepEqual(n.history[0].actor, { kind: 'app', appId: 'com.example.notes', instanceId: 'com.example.notes-1', verification: 'verified' });
  assert.equal('senderTokenHash' in n, false);

  const got = await svc.get(n.id);
  assert.deepEqual(got, n);
  // The stored record keeps only a hash of the token.
  const raw = JSON.parse(await redis.get(itemKey(n.id)));
  assert.equal(typeof raw.senderTokenHash, 'string');
  assert.equal(raw.senderTokenHash.includes(senderToken), false);
});

test('validation: missing title / too many options → 400', async () => {
  await rejectsStatus(svc.create({ text: 'x' }, APP), 400);
  await rejectsStatus(svc.create({
    title: 't', type: 'dialogue',
    components: [{ kind: 'options', id: 'o', options: [1, 2, 3, 4, 5].map((i) => ({ id: `o${i}`, label: `O${i}` })) }],
  }, SYSTEM_CALLER), 400);
  await rejectsStatus(svc.create({ title: 't', components: [{ kind: 'button', id: 'a', label: 'A' }, { kind: 'button', id: 'a', label: 'B' }] }, APP), 400);
  // Valid components are stored (rendering comes in phase 3).
  const { notification } = await svc.create({
    title: 'Pick', type: 'dialogue',
    components: [
      { kind: 'options', id: 'o', options: [{ id: 'a', label: 'A' }] },
      { kind: 'input', id: 'why', multiline: true },
      { kind: 'button', id: 'ok', label: 'OK', variant: 'primary', action: 'resolve' },
      { kind: 'progress', value: 0.5 },
    ],
  }, APP);
  assert.equal(notification.components.length, 4);
  assert.equal(notification.components[2].variant, 'primary');
});

test('identity overrides in the body are ignored and reported', async () => {
  const { notification: n, warnings } = await svc.create({
    title: 'forged',
    caller: { kind: 'system', verification: 'internal' },
    verification: 'internal',
    attribution: 'internal',
    sender: { kind: 'auraos', id: 'auraos', attribution: 'internal', name: 'AuraOS', actor: { name: 'root', attribution: 'verified' } },
  }, ANON);
  assert.deepEqual(n.caller, ANON);
  assert.equal(n.sender.kind, 'rest');
  assert.equal(n.sender.attribution, 'unverified');
  assert.equal(n.sender.name, 'AuraOS');
  assert.equal(n.sender.nameAttribution, 'unverified');
  assert.deepEqual(n.sender.actor, { name: 'root', attribution: 'unverified' });
  const fields = warnings.map((w) => w.field).sort();
  for (const f of ['caller', 'verification', 'attribution', 'sender.kind', 'sender.id', 'sender.attribution', 'sender.actor.attribution']) {
    assert.ok(fields.includes(f), `expected a warning for ${f}, got ${fields}`);
  }
});

test('sender derivation: hinted anonymous, unknown, daemon agent, system', async () => {
  const hinted = (await svc.create({ title: 'h' }, HINTED)).notification;
  assert.deepEqual(hinted.sender, { kind: 'app', id: 'com.example.notes', attribution: 'unverified' });
  assert.equal(hinted.senderKey, 'anon:com.example.notes');
  assert.equal(hinted.caller.verification, 'unverified');

  const unknown = (await svc.create({ title: 'u' }, ANON)).notification;
  assert.deepEqual(unknown.sender, { kind: 'unknown', attribution: 'unverified' });
  assert.equal(unknown.senderKey, 'anon:rest');

  const agent = (await svc.create({ title: 'a', sender: { actor: { name: 'claude' } } }, DAEMON)).notification;
  assert.deepEqual(agent.sender, { kind: 'agent', id: 'com.aura.aurashelld', attribution: 'verified', actor: { name: 'claude', attribution: 'declared' } });

  const sys = await svc.create({ title: 's' }, SYSTEM_CALLER);
  assert.equal(sys.notification.sender.kind, 'auraos');
  assert.equal(sys.notification.sender.attribution, 'internal');
  assert.equal(sys.notification.senderKey, 'auraos');
  assert.equal(sys.senderToken, undefined);
});

test('gating: locked/popup downgraded for every non-system caller, kept for SYSTEM_CALLER', async () => {
  for (const caller of [APP, ANON, HINTED, DAEMON]) {
    const { notification: n, warnings } = await svc.create({ title: 'lock', type: 'locked' }, caller);
    assert.equal(n.type, 'simple');
    assert.ok(warnings.some((w) => w.code === 'downgraded' && w.field === 'type' && w.from === 'locked'));
    const d = await svc.create({ title: 'pop', type: 'dialogue', popup: true }, caller);
    assert.equal(d.notification.popup, false);
    assert.ok(d.warnings.some((w) => w.code === 'downgraded' && w.field === 'popup'));
  }
  const locked = await svc.create({ title: 'lock', type: 'locked' }, SYSTEM_CALLER);
  assert.equal(locked.notification.type, 'locked');
  assert.deepEqual(locked.warnings, []);
  const pop = await svc.create({ title: 'pop', type: 'dialogue', popup: true }, SYSTEM_CALLER);
  assert.equal(pop.notification.popup, true);
});

test('SYSTEM_CALLER is one object per process (shared by every module copy), still frozen', async () => {
  const again = await import(`../dist/notifications/types.js?copy=${Date.now()}`);
  assert.equal(again.SYSTEM_CALLER, SYSTEM_CALLER, 'a second module copy sees the same object');
  assert.equal(Object.isFrozen(SYSTEM_CALLER), true);
});

test('claiming to be system grants nothing: a JSON copy of SYSTEM_CALLER is refused', async () => {
  const fake = JSON.parse(JSON.stringify(SYSTEM_CALLER));
  assert.equal(isSystemCaller(fake), false);
  assert.equal(Object.isFrozen(SYSTEM_CALLER), true);
  await rejectsStatus(svc.create({ title: 'x', type: 'locked' }, fake), 403);
});

test('sender ops: same verified app or senderToken only', async () => {
  const { notification: n, senderToken } = await svc.create({ title: 'v1' }, APP);
  // same app, other instance → ok
  const r1 = await svc.update(n.id, { title: 'v2', priority: 'high' }, { ...APP, instanceId: 'com.example.notes-2' });
  assert.equal(r1.notification.title, 'v2');
  assert.equal(r1.notification.priority, 'high');
  // other verified app → 403; anonymous with matching hints → 403
  await rejectsStatus(svc.update(n.id, { title: 'evil' }, OTHER_APP), 403);
  await rejectsStatus(svc.update(n.id, { title: 'evil' }, HINTED), 403);
  await rejectsStatus(svc.update(n.id, { title: 'evil' }, ANON, 'nst_wrong'), 403);
  // senderToken → ok, recorded as via senderToken
  const r2 = await svc.update(n.id, { text: 'by token' }, ANON, senderToken);
  assert.equal(r2.notification.text, 'by token');
  const last = r2.notification.history.at(-1);
  assert.equal(last.event, 'updated');
  assert.equal(last.actor.via, 'senderToken');
  assert.deepEqual(last.detail.fields, ['text']);
  // identity is never re-derived from the updater
  assert.deepEqual(r2.notification.caller, APP);
  assert.equal(r2.notification.sender.attribution, 'verified');

  // Anonymous creator manages its own via token
  const a = await svc.create({ title: 'anon' }, ANON);
  await rejectsStatus(svc.update(a.notification.id, { title: 'x' }, ANON), 403);
  const removed = await svc.removeBySender(a.notification.id, ANON, a.senderToken);
  assert.equal(removed.state, 'removed');
  assert.equal(removed.removedReason, 'completed');
});

test('update: type immutable, popup gated, timeout restart / clear, null clears optional fields', async () => {
  const { notification: n } = await svc.create({ title: 't', type: 'dialogue', icon: 'bell' }, APP);
  const r = await svc.update(n.id, { type: 'locked', popup: true, icon: null, timeoutMs: 1000 }, APP);
  assert.equal(r.notification.type, 'dialogue');
  assert.equal(r.notification.popup, false);
  assert.equal(r.notification.icon, undefined);
  assert.equal(r.notification.expiresAt, clock + 1000);
  assert.ok(r.warnings.some((w) => w.field === 'type'));
  assert.ok(r.warnings.some((w) => w.code === 'downgraded' && w.field === 'popup'));
  const r2 = await svc.update(n.id, { timeoutMs: null }, APP);
  assert.equal(r2.notification.expiresAt, undefined);
});

test('full lifecycle: displayed → seen → update → resolve, each with its actor', async () => {
  const { notification: n } = await svc.create({ title: 'ask', type: 'dialogue' }, APP);
  clock += 10;
  const d = await svc.markDisplayed(n.id);
  assert.equal(d.displayedAt, clock);
  const d2 = await svc.markDisplayed(n.id); // idempotent
  assert.equal(d2.history.length, 2);
  clock += 10;
  const s = await svc.markSeen(n.id);
  assert.equal(s.seenAt, clock);
  clock += 10;
  await svc.update(n.id, { text: 'more' }, APP);
  clock += 10;
  const r = await svc.resolve(n.id, { button: 'ok', input: { why: 'because' } });
  assert.equal(r.state, 'resolved');
  assert.equal(r.resolvedAt, clock);
  assert.deepEqual(r.answer, { button: 'ok', input: { why: 'because' } });
  assert.deepEqual(r.history.map((h) => h.event), ['created', 'displayed', 'seen', 'updated', 'resolved']);
  assert.deepEqual(r.history[1].actor, { kind: 'user', verification: 'unverified' });
  assert.deepEqual(r.history[4].actor, { kind: 'user', verification: 'unverified' });
  // resolved is terminal for updates / a second resolve
  await rejectsStatus(svc.resolve(n.id, {}), 409);
  await rejectsStatus(svc.update(n.id, { text: 'x' }, APP), 409);
  // but can still be dismissed from the list
  const gone = await svc.dismiss(n.id);
  assert.equal(gone.removedReason, 'dismissed');
  await rejectsStatus(svc.dismiss(n.id), 409);
  await rejectsStatus(svc.markSeen(n.id), 409);
});

test('dismiss refuses locked; force-remove removes it; clear skips locked', async () => {
  const locked = (await svc.create({ title: 'L', type: 'locked' }, SYSTEM_CALLER)).notification;
  await rejectsStatus(svc.dismiss(locked.id), 409);
  const sender = 'app:com.example.clear';
  const C = { ...APP, appId: 'com.example.clear', instanceId: 'com.example.clear-1' };
  const a = (await svc.create({ title: 'a' }, C)).notification;
  const b = (await svc.create({ title: 'b', priority: 'low' }, C)).notification;
  // clear filtered by sender + priority
  const r1 = await svc.clear({ sender, priority: 'low' });
  assert.equal(r1.cleared, 1);
  assert.equal((await svc.get(b.id)).removedReason, 'cleared');
  assert.equal((await svc.get(a.id)).state, 'active');
  // unfiltered clear leaves the locked one
  const r2 = await svc.clear();
  assert.ok(r2.cleared >= 1);
  assert.ok(r2.skippedLocked >= 1);
  assert.equal((await svc.get(locked.id)).state, 'active');
  assert.equal((await svc.get(a.id)).removedReason, 'cleared');
  const fr = await svc.forceRemove(locked.id);
  assert.equal(fr.removedReason, 'force-removed');
  assert.equal(fr.history.at(-1).detail.reason, 'force-removed');
});

test('list: state / sender / priority filters and cursor paging', async () => {
  const L = { ...APP, appId: 'com.example.list', instanceId: 'com.example.list-1' };
  const ids = [];
  for (let i = 0; i < 7; i++) {
    clock += 1;
    ids.push((await svc.create({ title: `n${i}`, priority: i % 2 ? 'high' : 'low' }, L)).notification.id);
  }
  await svc.dismiss(ids[0]);
  const page1 = await svc.list({ sender: 'app:com.example.list', limit: 3 });
  assert.deepEqual(page1.items.map((n) => n.title), ['n6', 'n5', 'n4']);
  assert.ok(page1.nextCursor);
  const page2 = await svc.list({ sender: 'app:com.example.list', limit: 3, cursor: page1.nextCursor });
  assert.deepEqual(page2.items.map((n) => n.title), ['n3', 'n2', 'n1']);
  assert.equal(page2.nextCursor, undefined); // n0 is removed, not active
  const removed = await svc.list({ sender: 'app:com.example.list', state: 'removed' });
  assert.deepEqual(removed.items.map((n) => n.title), ['n0']);
  const high = await svc.list({ sender: 'app:com.example.list', priority: 'high', state: 'all' });
  assert.deepEqual(high.items.map((n) => n.title), ['n5', 'n3', 'n1']);
  const active = await svc.list({ limit: 200 });
  assert.ok(active.items.every((n) => n.state === 'active'));
  await rejectsStatus(svc.list({ cursor: 'garbage' }), 400);
  // same-millisecond ties page correctly
  const T = { ...APP, appId: 'com.example.ties', instanceId: 'com.example.ties-1' };
  for (let i = 0; i < 5; i++) await svc.create({ title: `t${i}` }, T);
  const seen = new Set();
  let cursor;
  do {
    const p = await svc.list({ sender: 'app:com.example.ties', limit: 2, cursor });
    for (const n of p.items) { assert.equal(seen.has(n.id), false); seen.add(n.id); }
    cursor = p.nextCursor;
  } while (cursor);
  assert.equal(seen.size, 5);
});

test('expiry sweep removes timed-out notifications with reason expired', async () => {
  const keep = (await svc.create({ title: 'keep', timeoutMs: 60_000 }, APP)).notification;
  const gone = (await svc.create({ title: 'gone', timeoutMs: 1_000 }, APP)).notification;
  clock += 1_500;
  const n = await svc.sweep();
  assert.ok(n >= 1);
  const g = await svc.get(gone.id);
  assert.equal(g.state, 'removed');
  assert.equal(g.removedReason, 'expired');
  assert.deepEqual(g.history.at(-1).actor, { kind: 'system', verification: 'internal', reason: 'timeout' });
  assert.equal((await svc.get(keep.id)).state, 'active');
});

test('the interval sweeper runs on its own (real clock)', async () => {
  const live = new NotificationService({ redis, sweepIntervalMs: 50 });
  const { notification: n } = await live.create({ title: 'short', timeoutMs: 1 }, APP);
  live.start();
  live.start(); // idempotent
  try {
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await live.get(n.id)).removedReason, 'expired');
  } finally {
    live.stop();
  }
});

test('every mutation writes exactly one stream event; eventsSince catches up; reset on unknown ids', async () => {
  const start = events.length;
  const { notification: n } = await svc.create({ title: 'ev' }, APP);
  await svc.markDisplayed(n.id);
  await svc.markSeen(n.id);
  await svc.update(n.id, { text: 'u' }, APP);
  await svc.dismiss(n.id);
  const mine = events.slice(start);
  assert.deepEqual(mine.map((e) => e.event), ['created', 'displayed', 'seen', 'updated', 'removed']);
  assert.ok(mine.every((e) => e.id === n.id && /^\d+-\d+$/.test(e.eventId)));
  assert.equal(mine.at(-1).state, 'removed');

  const { events: caught, reset } = await svc.events.eventsSince(mine[1].eventId);
  assert.equal(reset, false);
  assert.deepEqual(caught.map((e) => e.eventId), mine.slice(2).map((e) => e.eventId));
  assert.deepEqual(caught[0], mine[2]);
  assert.equal((await svc.events.eventsSince('1-0')).reset, true);           // older than stream
  assert.equal((await svc.events.eventsSince('99999999999999-0')).reset, true); // newer than stream
  assert.ok((await redis.xlen(KEY_EVENTS)) >= 5);
});

test('bus relay: notification:<event> on OsEventBus, content-free {eventId,id,state}', async () => {
  const seen = [];
  const fns = NOTIFICATION_BUS_EVENTS.map((type) => {
    const fn = (p) => seen.push({ type, p });
    OsEventBus.on(type, fn);
    return [type, fn];
  });
  try {
    const bussed = new NotificationService({ redis, now, onEvent: emitNotificationBusEvent });
    const { notification: n } = await bussed.create({ title: 'secret stuff', text: 'do not leak' }, APP);
    await bussed.markDisplayed(n.id);
    await bussed.markSeen(n.id);
    await bussed.update(n.id, { text: 'x' }, APP);
    await bussed.resolve(n.id, { ok: true });
    await bussed.dismiss(n.id);
    assert.deepEqual(seen.map((s) => s.type), [
      'notification:created', 'notification:displayed', 'notification:seen',
      'notification:updated', 'notification:resolved', 'notification:removed',
    ]);
    for (const { p } of seen) {
      assert.deepEqual(Object.keys(p).sort(), ['eventId', 'id', 'state']);
      assert.equal(p.id, n.id);
    }
    assert.equal(seen.at(-1).p.state, 'removed');
  } finally {
    for (const [type, fn] of fns) OsEventBus.off(type, fn);
  }
});

test('interact: validated against the components, stored as lastInteraction, one stream + bus event', async () => {
  const components = [
    { kind: 'input', id: 'note', label: 'Note' },
    { kind: 'options', id: 'pick', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
    { kind: 'options', id: 'many', multiple: true, options: [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }] },
    { kind: 'button', id: 'ping', label: 'Ping', variant: 'secondary' },
    { kind: 'button', id: 'ok', label: 'OK', variant: 'primary', action: 'resolve' },
    { kind: 'progress', id: 'prog', value: 0.5 },
  ];
  const bus = [];
  const fn = (p) => bus.push(p);
  OsEventBus.on('notification:interacted', fn);
  try {
    const bussed = new NotificationService({ redis, now, onEvent: emitNotificationBusEvent });
    const { notification: n } = await bussed.create({ title: 'Ask', components }, APP);
    const before = (await bussed.events.eventBounds()).last;

    // A button without action, with the current values of the other components.
    clock += 1000;
    const r1 = await bussed.interact(n.id, { componentId: 'ping', values: { note: 'hi', pick: 'b', many: ['y', 'x'] } });
    assert.equal(r1.state, 'active');
    assert.deepEqual(r1.lastInteraction, {
      componentId: 'ping', kind: 'button', values: { note: 'hi', pick: 'b', many: ['y', 'x'] },
      at: clock, actor: { kind: 'user', verification: 'unverified' },
    });
    const h = r1.history.at(-1);
    assert.equal(h.event, 'interacted');
    assert.deepEqual(h.detail, { componentId: 'ping', kind: 'button' });

    // Input submit / single choice (string or one-element array) / multiple choice.
    assert.equal((await bussed.interact(n.id, { componentId: 'note', value: 'x'.repeat(4000) })).lastInteraction.value.length, 4000);
    assert.equal((await bussed.interact(n.id, { componentId: 'pick', value: ['a'] })).lastInteraction.value, 'a');
    assert.deepEqual((await bussed.interact(n.id, { componentId: 'many', value: 'x' })).lastInteraction.value, ['x']);

    const { events: evs } = await bussed.events.eventsSince(before);
    assert.deepEqual(evs.map((e) => e.event), ['interacted', 'interacted', 'interacted', 'interacted']);
    assert.equal(bus.length, 4);
    assert.deepEqual(Object.keys(bus[0]).sort(), ['eventId', 'id', 'state']);
    assert.equal(bus[0].state, 'active');

    // Refusals.
    await rejectsStatus(bussed.interact(n.id, { componentId: 'nope' }), 400);
    await rejectsStatus(bussed.interact(n.id, { componentId: 'ok' }), 400);            // has action resolve
    await rejectsStatus(bussed.interact(n.id, { componentId: 'prog' }), 400);          // progress
    await rejectsStatus(bussed.interact(n.id, { componentId: 'ping', value: 'v' }), 400);
    await rejectsStatus(bussed.interact(n.id, { componentId: 'note' }), 400);          // input needs a value
    await rejectsStatus(bussed.interact(n.id, { componentId: 'note', value: ['a'] }), 400);
    await rejectsStatus(bussed.interact(n.id, { componentId: 'note', value: 'x'.repeat(4001) }), 400);
    await rejectsStatus(bussed.interact(n.id, { componentId: 'pick', value: 'zzz' }), 400);
    await rejectsStatus(bussed.interact(n.id, { componentId: 'pick', value: ['a', 'b'] }), 400);
    await rejectsStatus(bussed.interact(n.id, { componentId: 'many', value: ['x', 'x'] }), 400);
    await rejectsStatus(bussed.interact(n.id, { componentId: 'ping', values: { ping: 'v' } }), 400);
    await rejectsStatus(bussed.interact(n.id, { componentId: 'ping', values: { pick: 'zzz' } }), 400);
    await rejectsStatus(bussed.interact('ntf_doesnotexist0', { componentId: 'ping' }), 404);
    assert.equal(bus.length, 4);

    // Only while active.
    await bussed.resolve(n.id, { buttonId: 'ok' });
    await rejectsStatus(bussed.interact(n.id, { componentId: 'ping' }), 409);
    const done = await bussed.get(n.id);
    assert.equal(done.lastInteraction.componentId, 'many');   // kept after resolve
  } finally {
    OsEventBus.off('notification:interacted', fn);
  }
});

// ---- phase 4: dialogue policy (scope / blocking / pop-up rate) -------------

test('select / combobox (phase 6): schema limits, defaults, interact + resolve values validated', async () => {
  const opts = (n) => Array.from({ length: n }, (_, i) => ({ id: `o${i}`, label: `Option ${i}` }));
  const select = { kind: 'select', id: 'region', label: 'Region', required: true, default: 'o2', options: opts(50) };
  const combo = { kind: 'combobox', id: 'owner', label: 'Owner', allowCustom: true, options: opts(3) };
  const strict = { kind: 'combobox', id: 'team', options: opts(2) };
  const { notification: n } = await svc.create({ type: 'dialogue', title: 'Pick', components: [select, combo, strict] }, APP);
  assert.equal(n.components[0].options.length, 50);
  assert.equal(n.components[0].default, 'o2');
  assert.equal(n.components[1].allowCustom, true);
  // Schema refusals.
  await rejectsStatus(svc.create({ title: 'x', components: [{ ...select, options: opts(51) }] }, APP), 400);
  await rejectsStatus(svc.create({ title: 'x', components: [{ ...select, options: [] }] }, APP), 400);
  await rejectsStatus(svc.create({ title: 'x', components: [{ ...select, default: 'nope' }] }, APP), 400);
  await rejectsStatus(svc.create({ title: 'x', components: [{ ...select, options: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }], default: 'a' }] }, APP), 400);
  await rejectsStatus(svc.create({ title: 'x', components: [{ kind: 'combobox', id: 'c', options: [] }] }, APP), 400);
  await rejectsStatus(svc.create({ title: 'x', components: [{ ...strict, default: 'free text' }] }, APP), 400);
  const { notification: free } = await svc.create({ title: 'x', components: [{ kind: 'combobox', id: 'c', allowCustom: true, options: [], default: 'anything' }] }, APP);
  assert.equal(free.components[0].default, 'anything');
  // interact.
  assert.equal((await svc.interact(n.id, { componentId: 'region', value: 'o49' })).lastInteraction.value, 'o49');
  assert.equal((await svc.interact(n.id, { componentId: 'owner', value: 'o1' })).lastInteraction.value, 'o1');
  assert.equal((await svc.interact(n.id, { componentId: 'owner', value: '  Grace Hopper ' })).lastInteraction.value, 'Grace Hopper', 'free text is trimmed');
  await rejectsStatus(svc.interact(n.id, { componentId: 'region', value: 'o50' }), 400);
  await rejectsStatus(svc.interact(n.id, { componentId: 'region', value: ['o1'] }), 400);
  await rejectsStatus(svc.interact(n.id, { componentId: 'team', value: 'someone' }), 400, 'no free text without allowCustom');
  await rejectsStatus(svc.interact(n.id, { componentId: 'owner', value: 'x'.repeat(201) }), 400);
  await rejectsStatus(svc.interact(n.id, { componentId: 'owner', value: '   ' }), 400);
  await rejectsStatus(svc.interact(n.id, { componentId: 'region' }), 400);
  // values sent along with a component.
  const v = await svc.interact(n.id, { componentId: 'team', value: 'o0', values: { region: 'o3', owner: 'Ada' } });
  assert.deepEqual(v.lastInteraction.values, { region: 'o3', owner: 'Ada' });
  await rejectsStatus(svc.interact(n.id, { componentId: 'team', value: 'o0', values: { region: 'zzz' } }), 400);
  // resolve: answer.values checked against the fields; other keys left alone.
  await rejectsStatus(svc.resolve(n.id, { outcome: 'submitted', values: { region: 'zzz' } }), 400);
  await rejectsStatus(svc.resolve(n.id, { outcome: 'submitted', values: { team: 'free' } }), 400);
  const r = await svc.resolve(n.id, { outcome: 'submitted', buttonId: 'submit', values: { region: 'o7', owner: ' Linus ', team: '', note: 'not a field' } });
  assert.deepEqual(r.answer.values, { region: 'o7', owner: 'Linus', team: '', note: 'not a field' });
  assert.equal(r.outcome, 'submitted');
  // Answers without values (legacy shapes) are untouched.
  const { notification: q } = await svc.create({ type: 'dialogue', title: 'Q', components: [select] }, APP);
  assert.deepEqual((await svc.resolve(q.id, { choice: 'yes' })).answer, { choice: 'yes' });
});

const APIKEY = { kind: 'apiKey', keyId: 'key1', name: 'ci', verification: 'verified' };
const ALLOW_ALL = { authorize: async () => ({ allow: true, reason: 'test' }) };
// Fake AppManager view: activities / instances and the app that owns them.
const WINDOWS = new Map([
  ['activity:com.example.notes-1#a1', 'com.example.notes'],
  ['instance:com.example.notes-1', 'com.example.notes'],
  ['activity:com.example.other-1#a1', 'com.example.other'],
  ['activity:com.aura.aurashelld-1#a1', 'com.aura.aurashelld'],
]);
const windowOwner = ({ kind, id }) => WINDOWS.get(`${kind}:${id}`) ?? null;
const OWN_ACT = { kind: 'activity', id: 'com.example.notes-1#a1', appId: 'com.example.other' };
const FOREIGN_ACT = { kind: 'activity', id: 'com.example.other-1#a1', appId: 'com.example.notes' };

test('phase 4: defaults — blocking false, scope auto; pre-phase-4 records read the same', async () => {
  const { notification: n, warnings } = await svc.create({ title: 'q', type: 'dialogue' }, APP);
  assert.equal(n.blocking, false);
  assert.equal(n.scope, 'auto');
  assert.deepEqual(warnings, []);
  // A record stored without the fields (phase 1–3) reads as defaults.
  const raw = JSON.parse(await redis.get(itemKey(n.id)));
  delete raw.blocking; delete raw.scope;
  await redis.set(itemKey(n.id), JSON.stringify(raw));
  const got = await svc.get(n.id);
  assert.equal(got.blocking, false);
  assert.equal(got.scope, 'auto');
});

test('phase 4: scope desktop is downgraded for every non-system caller, even with every grant', async () => {
  const granted = new NotificationService({ redis, now, authorizer: ALLOW_ALL, windowOwner });
  for (const s of [svc, granted]) {
    for (const caller of [APP, ANON, HINTED, DAEMON, APIKEY]) {
      const { notification: n, warnings } = await s.create({ title: 'sys?', type: 'dialogue', scope: 'desktop' }, caller);
      assert.equal(n.scope, 'auto', `${caller.kind} ${caller.appId ?? ''}`);
      assert.deepEqual(warnings.find((w) => w.field === 'scope'), {
        code: 'downgraded', field: 'scope', from: 'desktop', to: 'auto',
        message: 'desktop-wide dialogues are reserved for AuraOS system decisions',
      });
    }
  }
  // A JSON copy of SYSTEM_CALLER is not system at all.
  await rejectsStatus(granted.create({ title: 'x', type: 'dialogue', scope: 'desktop' }, JSON.parse(JSON.stringify(SYSTEM_CALLER))), 403);
  // SYSTEM_CALLER keeps it (and may block without a window).
  const sys = await granted.create({ title: 'Decide', type: 'dialogue', scope: 'desktop', blocking: true }, SYSTEM_CALLER);
  assert.equal(sys.notification.scope, 'desktop');
  assert.equal(sys.notification.blocking, true);
  assert.deepEqual(sys.warnings, []);
});

test('phase 4: blocking only on the sender\'s OWN window (resolved via the AppManager, not context.appId)', async () => {
  const s = new NotificationService({ redis, now, authorizer: ALLOW_ALL, windowOwner });
  const own = await s.create({ title: 'b', type: 'dialogue', blocking: true, context: OWN_ACT }, APP);
  assert.equal(own.notification.blocking, true, 'own activity (context.appId lies, the AppManager decides)');
  assert.deepEqual(own.warnings, []);
  const ownInst = await s.create({ title: 'b', type: 'dialogue', blocking: true, context: { kind: 'instance', id: 'com.example.notes-1' } }, APP);
  assert.equal(ownInst.notification.blocking, true, 'own instance');

  const cases = [
    ['foreign activity', APP, FOREIGN_ACT],
    ['missing context', APP, undefined],
    ['task context', APP, { kind: 'task', id: 't1' }],
    ['unknown activity', APP, { kind: 'activity', id: 'com.example.notes-1#a99' }],
    ['other app on my window', OTHER_APP, OWN_ACT],
    ['daemon agent on its own window', DAEMON, { kind: 'activity', id: 'com.aura.aurashelld-1#a1' }],
    ['api key', APIKEY, OWN_ACT],
    ['anonymous', ANON, OWN_ACT],
    ['hinted anonymous', HINTED, OWN_ACT],
  ];
  for (const [label, caller, context] of cases) {
    const r = await s.create({ title: 'b', type: 'dialogue', blocking: true, ...(context ? { context } : {}) }, caller);
    assert.equal(r.notification.blocking, false, label);
    const w = r.warnings.find((x) => x.field === 'blocking');
    assert.equal(w?.code, 'downgraded', label);
    assert.equal(w?.from, true, label);
  }
  // Without an ownership resolver nobody but system can block.
  const r = await svc.create({ title: 'b', type: 'dialogue', blocking: true, context: OWN_ACT }, APP);
  assert.equal(r.notification.blocking, false);
});

test('phase 4: blocking / scope are ignored (with a warning) outside dialogues', async () => {
  const s = new NotificationService({ redis, now, authorizer: ALLOW_ALL, windowOwner });
  const r = await s.create({ title: 'n', type: 'simple', blocking: true, scope: 'desktop', context: OWN_ACT }, APP);
  assert.equal(r.notification.blocking, false);
  assert.equal(r.notification.scope, 'auto');
  assert.ok(r.warnings.some((w) => w.code === 'ignored-field' && w.field === 'blocking'));
  assert.ok(r.warnings.some((w) => w.code === 'ignored-field' && w.field === 'scope'));
  const sys = await s.create({ title: 'n', type: 'locked', scope: 'desktop' }, SYSTEM_CALLER);
  assert.equal(sys.notification.scope, 'auto');
});

test('phase 4: at most 3 forced pop-ups per sender per 10 minutes; the 4th stays in the list', async () => {
  const s = new NotificationService({ redis, now, authorizer: ALLOW_ALL, windowOwner, popupLimit: { max: 3, windowMs: 600_000 } });
  const rate = { ...APP, appId: 'com.example.rate', instanceId: 'com.example.rate-1' };
  const start = clock;
  try {
    for (let i = 0; i < 3; i++) {
      clock += 1000;
      const r = await s.create({ title: `p${i}`, type: 'dialogue', popup: true }, rate);
      assert.equal(r.notification.popup, true, `pop-up ${i + 1}`);
    }
    // Non-popup dialogues don't count and are untouched.
    assert.equal((await s.create({ title: 'quiet', type: 'dialogue' }, rate)).notification.popup, false);
    const fourth = await s.create({ title: 'p4', type: 'dialogue', popup: true }, rate);
    assert.equal(fourth.notification.popup, false);
    assert.equal(fourth.notification.state, 'active', 'still available in the list');
    assert.ok(fourth.warnings.some((w) => w.code === 'downgraded' && w.field === 'popup' && /3 forced pop-ups/.test(w.message)));
    // Another sender has its own budget.
    assert.equal((await s.create({ title: 'o', type: 'dialogue', popup: true }, OTHER_APP)).notification.popup, true);
    // update → popup:true is re-gated by the same limit.
    const u = await s.update(fourth.notification.id, { popup: true }, rate);
    assert.equal(u.notification.popup, false);
    assert.ok(u.warnings.some((w) => w.field === 'popup' && w.code === 'downgraded'));
    // SYSTEM_CALLER is exempt.
    for (let i = 0; i < 5; i++) assert.equal((await s.create({ title: 's', type: 'dialogue', popup: true }, SYSTEM_CALLER)).notification.popup, true);
    // The window slides: 10 minutes after the first one, one slot is free again.
    clock = start + 1000 + 600_000 + 1;
    assert.equal((await s.create({ title: 'p5', type: 'dialogue', popup: true }, rate)).notification.popup, true);
    assert.equal((await s.create({ title: 'p6', type: 'dialogue', popup: true }, rate)).notification.popup, false);
  } finally {
    clock = start + 700_000;
  }
});

test('phase 4: update re-gates scope and blocking (and a context change re-checks blocking)', async () => {
  const s = new NotificationService({ redis, now, authorizer: ALLOW_ALL, windowOwner });
  const { notification: n } = await s.create({ title: 'q', type: 'dialogue', context: OWN_ACT }, APP);
  let u = await s.update(n.id, { scope: 'desktop' }, APP);
  assert.equal(u.notification.scope, 'auto');
  assert.ok(u.warnings.some((w) => w.field === 'scope' && w.code === 'downgraded'));
  u = await s.update(n.id, { blocking: true }, APP);
  assert.equal(u.notification.blocking, true, 'own window: allowed on update too');
  // Moving a blocking dialogue onto another app's window drops blocking.
  u = await s.update(n.id, { context: FOREIGN_ACT }, APP);
  assert.equal(u.notification.blocking, false);
  assert.ok(u.warnings.some((w) => w.field === 'blocking' && w.code === 'downgraded'));
  u = await s.update(n.id, { blocking: true }, APP);
  assert.equal(u.notification.blocking, false);
  // The senderToken holder (anonymous) can never turn blocking on.
  const anon = await s.create({ title: 'a', type: 'dialogue', context: OWN_ACT }, ANON);
  const ua = await s.update(anon.notification.id, { blocking: true, scope: 'desktop' }, ANON, anon.senderToken);
  assert.equal(ua.notification.blocking, false);
  assert.equal(ua.notification.scope, 'auto');
  // Non-dialogues ignore both on update.
  const simple = await s.create({ title: 's', context: OWN_ACT }, APP);
  const us = await s.update(simple.notification.id, { blocking: true }, APP);
  assert.equal(us.notification.blocking, false);
  assert.ok(us.warnings.some((w) => w.field === 'blocking' && w.code === 'ignored-field'));
  // System may set desktop on update.
  const sys = await s.create({ title: 'sys', type: 'dialogue' }, SYSTEM_CALLER);
  assert.equal((await s.update(sys.notification.id, { scope: 'desktop' }, SYSTEM_CALLER)).notification.scope, 'desktop');
});

test('phase 4: appManagerWindowOwner reads the AppManager singleton', async () => {
  const { appManagerWindowOwner } = await import('../dist/notifications/index.js');
  const key = '__aura_app_manager__';
  const prev = globalThis[key];
  try {
    delete globalThis[key];
    assert.equal(appManagerWindowOwner({ kind: 'activity', id: 'x#a1' }), null);
    globalThis[key] = {
      getActivity: (id) => (id === 'x-1#a1' ? { appId: 'com.x' } : undefined),
      getInstance: (id) => (id === 'x-1' ? { appId: 'com.x' } : undefined),
    };
    assert.equal(appManagerWindowOwner({ kind: 'activity', id: 'x-1#a1' }), 'com.x');
    assert.equal(appManagerWindowOwner({ kind: 'instance', id: 'x-1' }), 'com.x');
    assert.equal(appManagerWindowOwner({ kind: 'instance', id: 'nope' }), null);
  } finally {
    if (prev === undefined) delete globalThis[key]; else globalThis[key] = prev;
  }
});

test('phase 4: button roles — label / id optional on role buttons, required on custom ones; one per role', async () => {
  const { notification: n } = await svc.create({ title: 'q', type: 'dialogue', components: [
    { kind: 'input', id: 'name', required: true },
    { kind: 'button', role: 'cancel', label: 'No thanks' },
    { kind: 'button', role: 'submit' },
    { kind: 'button', id: 'custom', label: 'Remind me', variant: 'tertiary' },
  ] }, APP);
  const btn = (id) => n.components.find((c) => c.id === id);
  assert.deepEqual({ ...btn('cancel') }, { kind: 'button', id: 'cancel', label: 'No thanks', variant: 'secondary', role: 'cancel' });
  assert.equal(btn('submit').role, 'submit');
  assert.equal(btn('submit').label, undefined, 'the shell supplies the default text');
  assert.equal((await svc.get(n.id)).components.length, 4, 'round-trips');
  await rejectsStatus(svc.create({ title: 'x', type: 'dialogue', components: [{ kind: 'button', id: 'a' }] }, APP), 400);
  await rejectsStatus(svc.create({ title: 'x', type: 'dialogue', components: [{ kind: 'button', label: 'A' }] }, APP), 400);
  await rejectsStatus(svc.create({ title: 'x', type: 'dialogue', components: [{ kind: 'button', role: 'cancel' }, { kind: 'button', role: 'cancel', id: 'c2' }] }, APP), 400);
  await rejectsStatus(svc.create({ title: 'x', type: 'dialogue', components: [{ kind: 'button', role: 'submit', label: 'x'.repeat(201) }] }, APP), 400);
  await rejectsStatus(svc.create({ title: 'x', type: 'dialogue', components: [{ kind: 'button', role: 'cancel' }, { kind: 'button', id: 'cancel', label: 'dup' }] }, APP), 400);
  // Role buttons are not interactions.
  await rejectsStatus(svc.interact(n.id, { componentId: 'cancel' }), 400);
});

test('phase 4: outcome — submitted / cancelled stored next to answer, in history; no outcome = submitted', async () => {
  const mk = async () => (await svc.create({ title: 'q', type: 'dialogue' }, APP)).notification;
  const a = await mk();
  const ra = await svc.resolve(a.id, { outcome: 'cancelled', buttonId: 'cancel' });
  assert.equal(ra.outcome, 'cancelled');
  assert.deepEqual(ra.answer, { outcome: 'cancelled', buttonId: 'cancel' });
  assert.deepEqual(ra.history.at(-1).detail, { outcome: 'cancelled' });
  assert.equal((await svc.get(a.id)).outcome, 'cancelled');
  const b = await mk();
  assert.equal((await svc.resolve(b.id, { outcome: 'submitted', buttonId: 'submit', values: { x: '1' } })).outcome, 'submitted');
  const c = await mk();
  assert.equal((await svc.resolve(c.id, { buttonId: 'yes' })).outcome, 'submitted', 'legacy answers count as submitted');
  const d = await mk();
  assert.equal((await svc.resolve(d.id)).outcome, 'submitted');
  const e = await mk();
  await rejectsStatus(svc.resolve(e.id, { outcome: 'maybe' }), 400);
});

test('notif: data is unreachable through KvClient namespaces', async () => {
  const c = new KvClient(server.getUri());
  try {
    await assert.rejects(() => c.get('notif', 'item'), /invalid namespace/);
    await assert.rejects(() => c.set('notif:item', 'x', 1), /invalid namespace/);
  } finally {
    await c.close();
  }
});

test('persistence: items, indexes, history and events survive a KvServer restart', async () => {
  const { notification: n } = await svc.create({ title: 'durable' }, APP);
  await svc.markSeen(n.id);
  const before = await svc.get(n.id);
  const lastEvent = (await svc.events.eventBounds()).last;
  redis.disconnect();
  await server.stop();

  server = new KvServer();
  const uri = await server.start({ dataDir: DATA_DIR });
  redis = createRedis(uri);
  const svc2 = new NotificationService({ redis, now });
  assert.deepEqual(await svc2.get(n.id), before);
  const listed = await svc2.list({ sender: 'app:com.example.notes', limit: 200 });
  assert.ok(listed.items.some((x) => x.id === n.id));
  assert.equal((await svc2.events.eventBounds()).last, lastEvent);
  svc = svc2;
});

test('popupDurationMs: optional, round-trips, negatives → -1, max 24 h, null on update returns to the default', async () => {
  const a = (await svc.create({ title: 'pd default' }, APP)).notification;
  assert.equal('popupDurationMs' in a, false, 'absent → shell default');
  const b = (await svc.create({ title: 'pd 5s', popupDurationMs: 5000 }, APP)).notification;
  assert.equal(b.popupDurationMs, 5000);
  assert.equal((await svc.get(b.id)).popupDurationMs, 5000);
  const c = (await svc.create({ title: 'pd sticky', popupDurationMs: 0 }, APP)).notification;
  assert.equal(c.popupDurationMs, 0);
  const d = (await svc.create({ title: 'pd neg', popupDurationMs: -7 }, APP)).notification;
  assert.equal(d.popupDurationMs, -1, 'negatives are normalised to -1');
  await rejectsStatus(svc.create({ title: 'pd big', popupDurationMs: 24 * 3600 * 1000 + 1 }, APP), 400);
  await rejectsStatus(svc.create({ title: 'pd frac', popupDurationMs: 1.5 }, APP), 400);
  await rejectsStatus(svc.create({ title: 'pd str', popupDurationMs: '5000' }, APP), 400);
  // update: set, change, clear
  assert.equal((await svc.update(a.id, { popupDurationMs: -1 }, APP)).notification.popupDurationMs, -1);
  assert.equal((await svc.update(a.id, { popupDurationMs: 1200 }, APP)).notification.popupDurationMs, 1200);
  const cleared = (await svc.update(a.id, { popupDurationMs: null }, APP)).notification;
  assert.equal('popupDurationMs' in cleared, false);
  // independent of the lifetime
  const e = (await svc.create({ title: 'pd + timeout', popupDurationMs: 2000, timeoutMs: 60000 }, APP)).notification;
  assert.equal(e.popupDurationMs, 2000);
  assert.equal(e.timeoutMs, 60000);
  for (const n of [a, b, c, d, e]) await svc.forceRemove(n.id);
});
