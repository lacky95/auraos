// Pop-up overflow queue (phase 4). DOM-free: a tiny stack simulation over
// the real admitToast + ToastQueue, mirroring NotificationToasts.astro.
//
//   cd packages/shell && npx tsx --test test/notification-toast-queue.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_TOASTS, QUEUE_MAX_AGE_ON_UNLOCK_MS, ToastQueue, admissionList, admitToast, slotsUsed, toastHideAnimates } from '../src/lib/notifications/toasts.ts';
import { ExitMachine } from '../src/lib/notifications/exit.ts';
import type { Notification } from '../src/lib/notifications/api.ts';

type Item = Pick<Notification, 'id' | 'priority'> & { popupDurationMs?: number; seen?: boolean };
const it = (id: string, priority: Item['priority'] = 'medium', extra: Partial<Item> = {}): Item => ({ id, priority, ...extra });

class Stack {
  shown: Item[] = [];
  q: ToastQueue;
  locked = false;
  listOpen = false;
  hiddenByUser = new Set<string>();
  items = new Map<string, Item>();
  constructor(now: () => number = Date.now) { this.q = new ToastQueue(now); }
  arrive(n: Item) {
    this.items.set(n.id, n);
    if (this.locked || this.listOpen) return;
    const adm = admitToast(this.shown, n);
    if (!adm.admit) { this.q.enqueue(n); return; }
    if (adm.evict) this.shown = this.shown.filter((s) => s.id !== adm.evict);   // evicted: not re-queued
    this.shown.push(n);
  }
  free(id: string) { this.shown = this.shown.filter((s) => s.id !== id); this.pump(); }
  close(id: string) { this.hiddenByUser.add(id); this.q.remove(id); this.free(id); }   // ✕
  pump() {
    while (this.q.size && !this.locked && !this.listOpen && this.shown.length < MAX_TOASTS) {
      const id = this.q.next()!;
      const n = this.items.get(id);
      if (!n || n.seen || this.hiddenByUser.has(id)) continue;
      this.shown.push(n);
    }
  }
  ids() { return this.shown.map((s) => s.id); }
}

test('a full stack queues the overflow; ✕ / click / timeout / remove each free a slot for the next', () => {
  const s = new Stack();
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) s.arrive(it(id));
  assert.deepEqual(s.ids(), ['a', 'b', 'c']);
  assert.equal(s.q.size, 4, 'queued, not dropped');
  s.close('a');                 // ✕ (keep unread)
  assert.deepEqual(s.ids(), ['b', 'c', 'd']);
  s.free('b');                  // click (seen + hide)
  s.free('c');                  // duration ran out
  s.free('d');                  // resolved / removed / expired
  assert.deepEqual(s.ids(), ['e', 'f', 'g']);
  assert.equal(s.q.size, 0);
});

test('priority order: urgent > high > medium > low, FIFO within a priority', () => {
  const q = new ToastQueue();
  q.enqueue(it('m1')); q.enqueue(it('l1', 'low')); q.enqueue(it('h1', 'high')); q.enqueue(it('m2')); q.enqueue(it('u1', 'urgent')); q.enqueue(it('h2', 'high'));
  q.enqueue(it('m1'));   // duplicate ignored
  assert.deepEqual([q.next(), q.next(), q.next(), q.next(), q.next(), q.next(), q.next()], ['u1', 'h1', 'h2', 'm1', 'm2', 'l1', undefined]);
});

test('opening the list clears the queue; it is not restored after the list closes', () => {
  const s = new Stack();
  for (const id of ['a', 'b', 'c', 'd', 'e']) s.arrive(it(id));
  s.listOpen = true; s.q.clear(); s.shown = [];          // list opens: everything hides, queue cleared
  s.listOpen = false;
  s.pump();
  assert.deepEqual(s.ids(), [], 'old queue not restored');
  s.arrive(it('new'));
  assert.deepEqual(s.ids(), ['new'], 'only genuinely new arrivals pop up');
});

test('lock freezes the queue; unlock drops items older than 60 s', () => {
  let now = 1_000_000;
  const s = new Stack(() => now);
  for (const id of ['a', 'b', 'c', 'old']) s.arrive(it(id));
  now += QUEUE_MAX_AGE_ON_UNLOCK_MS + 1;
  s.arrive(it('fresh'));
  assert.equal(s.q.size, 2);
  s.locked = true; s.shown = [];
  s.pump();
  assert.deepEqual(s.ids(), [], 'nothing pops up while locked');
  s.locked = false;
  assert.equal(s.q.dropOlderThan(QUEUE_MAX_AGE_ON_UNLOCK_MS), 1);
  s.pump();
  assert.deepEqual(s.ids(), ['fresh']);
});

test('an evicted pop-up is not re-queued; sticky pop-ups hold their slots; seen / ✕ items never come back', () => {
  const s = new Stack();
  s.arrive(it('a')); s.arrive(it('b')); s.arrive(it('c'));
  s.arrive(it('u', 'urgent'));                 // evicts the oldest non-sticky
  assert.deepEqual(s.ids(), ['b', 'c', 'u']);
  assert.equal(s.q.has('a'), false, 'evicted, not queued');
  const t = new Stack();
  for (const id of ['s1', 's2', 's3']) t.arrive(it(id, 'medium', { popupDurationMs: 0 }));
  t.arrive(it('h', 'high'));
  assert.deepEqual(t.ids(), ['s1', 's2', 's3'], 'sticky slots are never taken');
  assert.equal(t.q.has('h'), true, 'it waits instead');
  // Hygiene: a queued item that became seen is skipped / removed.
  t.arrive(it('x'));
  t.items.get('h')!.seen = true;
  t.q.remove('h');
  t.close('s1');
  assert.deepEqual(t.ids(), ['s2', 's3', 'x']);
});

test('pop-up exit: animated for click / ✕ / timeout / dialog / ended / seen / evicted; instant for lock / wipe / list / teardown', () => {
  for (const r of ['click', 'close', 'timeout', 'dialog', 'ended', 'seen', 'evicted'] as const) assert.equal(toastHideAnimates(r), true, r);
  for (const r of ['lock', 'wipe', 'list', 'teardown'] as const) assert.equal(toastHideAnimates(r), false, r);
});

test('a leaving pop-up holds its slot until the exit ends; it no longer counts for admission / eviction', () => {
  const pending: Array<() => void> = [];
  const timers = { set: (fn: () => void) => { pending.push(fn); return fn; }, clear: () => {} };
  type T = { id: string; priority: Item['priority']; exiting: boolean; exit: ExitMachine };
  const mk = (id: string, priority: Item['priority'] = 'medium'): T => ({ id, priority, exiting: false, exit: new ExitMachine(timers) });
  let stack: T[] = [mk('a'), mk('b'), mk('c')];
  const q = new ToastQueue();
  q.enqueue(it('d'));
  // ✕ on 'a': exit starts — slot still used, the queue does not pull yet.
  const a = stack[0]!;
  a.exiting = true;
  a.exit.hide(() => { stack = stack.filter((t) => t !== a); });
  assert.equal(slotsUsed(stack), MAX_TOASTS, 'slot still taken during the exit');
  assert.deepEqual(admissionList(stack).map((t) => t.id), ['b', 'c']);
  assert.equal(a.exit.hide(() => {}), false, 'a second hide is ignored');
  // animationend → gone → slot free → the queued one pops.
  a.exit.end();
  assert.equal(slotsUsed(stack), 2);
  if (slotsUsed(stack) < MAX_TOASTS) stack.push(mk(q.next()!));
  assert.deepEqual(stack.map((t) => t.id), ['b', 'c', 'd']);
  // Eviction animates: the evicted one leaves via its exit, the urgent one enters at once.
  const adm = admitToast(admissionList(stack), it('u', 'urgent'));
  assert.equal(adm.evict, 'b');
  const b = stack.find((t) => t.id === 'b')!;
  b.exiting = true;
  b.exit.hide(() => { stack = stack.filter((t) => t !== b); });
  stack.push(mk('u', 'urgent'));
  assert.equal(b.exit.state, 'exiting', 'the evicted pop-up slides out');
  // Lock during an exit: instant.
  b.exit.hide(() => {}, { instant: true });
  assert.equal(b.exit.state, 'gone');
  assert.deepEqual(stack.map((t) => t.id), ['c', 'd', 'u']);
});
