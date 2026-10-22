// Card updates patch in place; dialogue fields are local form state. DOM-free.
//
//   cd packages/shell && npx tsx --test test/notification-card-patch.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buttonValidates, missingRequired, planCardUpdate, sendsOnFieldChange, structureKey } from '../src/lib/notifications/cardPatch.ts';
import type { Notification } from '../src/lib/notifications/api.ts';

const base = (over: Partial<Notification> = {}): Notification => ({
  id: 'ntf_1', type: 'dialogue', title: 'Deploy?', text: 'Pick one', priority: 'medium', visibility: 'private',
  pinned: false, popup: false, blocking: false, scope: 'auto',
  caller: { kind: 'anonymous', verification: 'unverified' }, sender: { kind: 'app', id: 'a.b', attribution: 'verified' },
  senderKey: 'app:a.b', state: 'active', createdAt: 1, updatedAt: 1, history: [],
  components: [
    { kind: 'options', id: 'env', options: [{ id: 'dev', label: 'Dev' }, { id: 'prod', label: 'Prod' }] },
    { kind: 'input', id: 'why', label: 'Why' },
    { kind: 'progress', value: 0.2, label: 'Upload' },
    { kind: 'button', id: 'ok', label: 'OK', variant: 'primary', action: 'resolve' },
  ],
  ...over,
} as Notification);

test('the echo of the user\'s own interaction changes nothing visible → no re-render', () => {
  const prev = base();
  const echo = base({ updatedAt: 9, lastInteraction: { componentId: 'env', kind: 'options', value: 'prod', at: 9, actor: { kind: 'user', verification: 'unverified' } }, history: [{ event: 'interacted', at: 9, actor: { kind: 'user', verification: 'unverified' } }], displayedAt: 5 } as Partial<Notification>);
  assert.equal(planCardUpdate(prev, echo), 'none');
});

test('title / text / progress / seen updates patch in place (form controls untouched)', () => {
  const prev = base();
  assert.equal(planCardUpdate(prev, base({ title: 'Deploy now?' })), 'patch');
  assert.equal(planCardUpdate(prev, base({ text: 'new text' })), 'patch');
  assert.equal(planCardUpdate(prev, base({ seenAt: 3 })), 'patch');
  const moreProgress = base({ components: base().components!.map((c) => (c.kind === 'progress' ? { ...c, value: 0.8 } : c)) });
  assert.equal(planCardUpdate(prev, moreProgress), 'patch');
  assert.equal(structureKey(prev), structureKey(moreProgress), 'progress values are not structure');
});

test('a structural change (components, labels, options, type, priority, state) rebuilds', () => {
  const prev = base();
  const comps = base().components!;
  assert.equal(planCardUpdate(prev, base({ components: comps.filter((c) => c.kind !== 'input') })), 'rebuild');
  assert.equal(planCardUpdate(prev, base({ components: comps.map((c) => (c.kind === 'button' ? { ...c, label: 'Go' } : c)) })), 'rebuild');
  assert.equal(planCardUpdate(prev, base({ components: comps.map((c) => (c.kind === 'options' ? { ...c, options: [{ id: 'dev', label: 'Dev' }] } : c)) })), 'rebuild');
  assert.equal(planCardUpdate(prev, base({ priority: 'high' })), 'rebuild');
  assert.equal(planCardUpdate(prev, base({ state: 'resolved' })), 'rebuild');
  assert.equal(planCardUpdate(undefined, prev), 'rebuild');
  assert.equal(planCardUpdate(prev, base({ id: 'ntf_2' })), 'rebuild');
});

test('dialogue mode: option / input changes send no interact (values go with a button); list + pop-up keep phase-3 interact', () => {
  assert.equal(sendsOnFieldChange('dialog'), false);
  assert.equal(sendsOnFieldChange('list'), true);
  assert.equal(sendsOnFieldChange('toast'), false, 'pop-up forms are local state too (phase 6 fix)');
});

test('required fields: only submitting buttons validate; cancel / link / ✕ / Escape never do', () => {
  const comps = [
    { kind: 'input', id: 'name', label: 'Name', required: true },
    { kind: 'input', id: 'note', label: 'Note' },
  ] as Notification['components'];
  const empty = { name: '  ', note: '' };
  // A dismiss ("Cancel") button with an empty required input proceeds.
  assert.equal(buttonValidates({ action: 'dismiss' }), false);
  assert.equal(buttonValidates({ action: 'link' }), false);
  // A resolve button with an empty required input is blocked (inline error).
  assert.equal(buttonValidates({ action: 'resolve' }), true);
  assert.deepEqual(missingRequired(comps, empty).map((c) => c.id), ['name']);
  // A button without an action sends values too → validates.
  assert.equal(buttonValidates({}), true);
  assert.deepEqual(missingRequired(comps, { name: 'Ada' }), []);
});
