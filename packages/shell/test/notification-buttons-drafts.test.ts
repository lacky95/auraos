// Standard dialogue buttons + persistent drafts (phase 4). DOM-free.
//
//   cd packages/shell && npx tsx --test test/notification-buttons-drafts.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerFor, behaviourValidates, planButtons } from '../src/lib/notifications/buttons.ts';
import { DRAFT_PREFIX, DraftStore, draftValuesFor, type StorageLike } from '../src/lib/notifications/drafts.ts';
import { buttonValidates, fieldErrorsFrom, missingRequired } from '../src/lib/notifications/cardPatch.ts';
import { admissionItem, admitToast, hidesOnSeen, mayReshowHidden, toastClickEffect } from '../src/lib/notifications/toasts.ts';
import type { Notification } from '../src/lib/notifications/api.ts';

const it = (id: string, priority: Notification['priority'] = 'medium') => ({ id, priority });
const n = (over: Partial<Notification> = {}) => ({ type: 'dialogue', components: [], ...over }) as Pick<Notification, 'type' | 'components'>;
const plan = (x: ReturnType<typeof n>, canPutOff = true) => planButtons(x, { canPutOff }).map((b) => `${b.behaviour}:${b.id}:${b.label}:${b.variant}`);

test('defaults per dialogue: OK without fields, Submit with fields; order Later, Cancel, Submit; no Later when it cannot be put off', () => {
  assert.deepEqual(plan(n()), ['later:later:Later:tertiary', 'cancel:cancel:Cancel:secondary', 'submit:submit:OK:primary']);
  const withField = n({ components: [{ kind: 'input', id: 'name' }] as Notification['components'] });
  assert.deepEqual(plan(withField), ['later:later:Later:tertiary', 'cancel:cancel:Cancel:secondary', 'submit:submit:Submit:primary']);
  assert.deepEqual(plan(n(), false), ['cancel:cancel:Cancel:secondary', 'submit:submit:OK:primary'], 'blocking / desktop: no Later');
  // Simple / locked notifications get no defaults.
  assert.deepEqual(plan(n({ type: 'simple' })), []);
});

test('sender role buttons replace the defaults and keep their labels; label-only role buttons; custom buttons come first', () => {
  const x = n({ components: [
    { kind: 'button', id: 'cancel', role: 'cancel', label: 'No thanks', variant: 'secondary' },
    { kind: 'button', id: 'go', role: 'submit', variant: 'secondary' },          // no label → default; always primary
    { kind: 'button', id: 'docs', label: 'Runbook', variant: 'tertiary', action: 'link', href: 'https://x' },
    { kind: 'button', id: 'ping', label: 'Ping', variant: 'secondary' },
  ] as Notification['components'] });
  assert.deepEqual(plan(x), ['link:docs:Runbook:tertiary', 'interact:ping:Ping:secondary', 'later:later:Later:tertiary', 'cancel:cancel:No thanks:secondary', 'submit:go:OK:primary']);
  // A sender id that collides with a default id → the default is prefixed.
  const y = n({ components: [{ kind: 'button', id: 'submit', label: 'Custom', variant: 'secondary' }] as Notification['components'] });
  assert.deepEqual(plan(y).slice(-1), ['submit:__submit:OK:primary']);
});

test('legacy buttons keep their meaning: resolve acts as submit, dismiss as the old cancel', () => {
  const x = n({ components: [
    { kind: 'button', id: 'yes', label: 'Yes', variant: 'primary', action: 'resolve' },
    { kind: 'button', id: 'no', label: 'No', variant: 'secondary', action: 'dismiss' },
  ] as Notification['components'] });
  assert.deepEqual(plan(x), ['resolve:yes:Yes:primary', 'dismiss:no:No:secondary', 'later:later:Later:tertiary']);
});

test('answers: submit carries values + outcome submitted; cancel sends no values, outcome cancelled; Later is local', () => {
  const [later, cancel, submit] = planButtons(n(), { canPutOff: true });
  assert.deepEqual(answerFor(submit!, { a: '1' }), { outcome: 'submitted', buttonId: 'submit', values: { a: '1' } });
  assert.deepEqual(answerFor(cancel!, { a: '1' }), { outcome: 'cancelled', buttonId: 'cancel' });
  assert.equal(answerFor(later!, {}), null, 'Later sends nothing');
  assert.equal(behaviourValidates('submit'), true);
  assert.equal(behaviourValidates('cancel'), false, 'Cancel skips validation');
  assert.equal(behaviourValidates('later'), false);
  assert.equal(buttonValidates({ role: 'cancel', action: 'resolve' }), false, 'the role decides');
});

class MemStorage implements StorageLike {
  m = new Map<string, string>();
  get length() { return this.m.size; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
}

test('drafts: saved on every input, survive a reload, filtered to existing components; cleared on resolve; GC', () => {
  const storage = new MemStorage();
  let now = 1_000_000;
  const a = new DraftStore({ storage, now: () => now });
  a.set('ntf_1', 'name', 'Ad');
  a.set('ntf_1', 'name', 'Ada');
  a.set('ntf_1', 'env', 'prod');
  a.set('ntf_1', 'gone', 'x');
  const raw = JSON.parse(storage.getItem(`${DRAFT_PREFIX}ntf_1`)!);
  assert.deepEqual(raw, { v: 1, values: { name: 'Ada', env: 'prod', gone: 'x' }, updatedAt: now });
  // "Reload": a fresh store on the same storage.
  const b = new DraftStore({ storage, now: () => now });
  const item = { components: [
    { kind: 'input', id: 'name' },
    { kind: 'options', id: 'env', options: [{ id: 'dev', label: 'Dev' }, { id: 'prod', label: 'Prod' }] },
  ] } as Pick<Notification, 'components'>;
  assert.deepEqual(draftValuesFor(item, b.get('ntf_1')), { name: 'Ada', env: 'prod' }, 'unknown ids are ignored');
  assert.deepEqual(draftValuesFor({ components: [{ kind: 'options', id: 'name', options: [{ id: 'x', label: 'X' }] }] as Notification['components'] }, b.get('ntf_1')), {}, 'kind mismatch is ignored');
  // Clear (submit / cancel / removed).
  b.clear('ntf_1');
  assert.equal(b.get('ntf_1'), null);
  assert.equal(storage.getItem(`${DRAFT_PREFIX}ntf_1`), null);
  // GC: inactive ids and anything older than 7 days.
  b.set('ntf_old', 'name', 'x');
  now += 8 * 24 * 3600 * 1000;
  b.set('ntf_live', 'name', 'y');
  b.set('ntf_dead', 'name', 'z');
  assert.equal(b.gc(new Set(['ntf_live', 'ntf_old'])), 2);
  assert.deepEqual(b.ids().sort(), ['ntf_live']);
});

test('drafts: a throwing storage falls back to memory', () => {
  const bad: StorageLike = { length: 0, key: () => null, getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('quota'); }, removeItem: () => { throw new Error('x'); } };
  const s = new DraftStore({ storage: bad });
  s.set('ntf_1', 'a', 'v');
  assert.deepEqual(s.get('ntf_1'), { a: 'v' });
  s.clear('ntf_1');
  assert.equal(s.get('ntf_1'), null);
});

test('pop-up click: no form → seen + hide; dialogue or form → seen + ACTIVE in place (not hidden); controls handle themselves', () => {
  const form = [{ kind: 'input', id: 'a' }] as Notification['components'];
  const sel = [{ kind: 'select', id: 's', options: [{ id: 'x', label: 'X' }] }] as unknown as Notification['components'];
  const btns = [{ kind: 'button', id: 'b', label: 'B', variant: 'secondary' }] as Notification['components'];
  assert.deepEqual(toastClickEffect({ type: 'simple' }, 'body'), { markSeen: true, activate: false, hide: true });
  assert.deepEqual(toastClickEffect({ type: 'locked' }, 'body'), { markSeen: true, activate: false, hide: true });
  assert.deepEqual(toastClickEffect({ type: 'simple', components: btns }, 'body'), { markSeen: true, activate: false, hide: true }, 'buttons alone are not a form');
  assert.deepEqual(toastClickEffect({ type: 'simple', components: form }, 'body'), { markSeen: true, activate: true, hide: false });
  assert.deepEqual(toastClickEffect({ type: 'simple', components: sel }, 'body'), { markSeen: true, activate: true, hide: false }, 'phase-6 select counts as a form');
  assert.deepEqual(toastClickEffect({ type: 'dialogue' }, 'body'), { markSeen: true, activate: true, hide: false });
  for (const type of ['simple', 'dialogue'] as const) assert.deepEqual(toastClickEffect({ type }, 'button'), { markSeen: true, activate: false, hide: false });
  for (const where of ['link', 'field', 'menu'] as const) assert.deepEqual(toastClickEffect({ type: 'simple', components: form }, where), { markSeen: false, activate: false, hide: false });
});

test('an active pop-up is never evicted by a new arrival; a seen update from this tab / while active never hides it', () => {
  const vis = [admissionItem(it('a'), true), admissionItem(it('b'), false), admissionItem(it('c'), false)];
  assert.equal(admitToast(vis, it('u', 'urgent')).evict, 'b', 'the active one is skipped');
  const allActive = ['a', 'b', 'c'].map((id) => admissionItem(it(id), true));
  assert.deepEqual(admitToast(allActive, it('u', 'urgent')), { admit: false }, 'urgent waits in the queue');
  assert.equal(hidesOnSeen({ active: true, seenHere: false }), false);
  assert.equal(hidesOnSeen({ active: false, seenHere: true }), false, 'its own button click marked it seen: it stays');
  assert.equal(hidesOnSeen({ active: false, seenHere: false }), true, 'seen in another tab: it hides');
});

test('submit: client validation blocks the request; server 400 details map to inline field errors', () => {
  const comps = [{ kind: 'input', id: 'name', required: true }, { kind: 'options', id: 'env', options: [{ id: 'a', label: 'A' }] }] as Notification['components'];
  assert.deepEqual(missingRequired(comps, { name: '' }).map((c) => c.id), ['name'], 'invalid → stays, no request');
  assert.equal(behaviourValidates('submit'), true);
  assert.deepEqual(fieldErrorsFrom([{ path: 'answer.values.name', message: 'Too short' }, { path: 'answer', message: 'x' }, { path: 'env', message: 'Pick one' }], comps),
    { name: 'Too short', env: 'Pick one' });
  assert.deepEqual(fieldErrorsFrom(undefined, comps), {});
});

test('pop-up ✕ keeps it hidden (unread) unless a genuine sender update of a high / urgent item arrives', () => {
  const base = { id: 'ntf_1', type: 'simple', title: 'Build', text: 'running', priority: 'high', visibility: 'private', pinned: false, popup: false,
    blocking: false, scope: 'auto', caller: { kind: 'anonymous', verification: 'unverified' }, sender: { kind: 'app', id: 'a.b', attribution: 'verified' },
    senderKey: 'app:a.b', state: 'active', createdAt: 1, updatedAt: 10, history: [] } as unknown as Notification;
  assert.equal(mayReshowHidden(base, { ...base }), false, 're-render / reconnect: same item');
  assert.equal(mayReshowHidden(base, { ...base, updatedAt: 20, lastInteraction: { componentId: 'x', kind: 'button', at: 20, actor: { kind: 'user', verification: 'unverified' } } } as Notification), false, 'the user\'s own echo');
  assert.equal(mayReshowHidden(base, { ...base, updatedAt: 20, text: 'failed' }), true, 'a real high-priority update');
  assert.equal(mayReshowHidden({ ...base, priority: 'medium' }, { ...base, priority: 'medium', updatedAt: 20, text: 'failed' }), false, 'medium stays hidden');
  // The ✕ is not part of the "click marks seen" rule (it stops propagation); a click on it is a button click
  // only for buttons that bubble — the hide button never reaches the pop-up handler.
});
