// Dismissing an unanswered question asks first (phase 4). DOM (happy-dom) + rule.
//
//   cd packages/shell && npx tsx --test test/notification-dismiss-confirm.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dom, flush, resetDom } from './dom.ts';
import type { Notification } from '../src/lib/notifications/api.ts';

const { renderNotificationCard } = await import('../src/components/shell/notifications/NotificationCard.ts');
const { needsDismissConfirm, dismissConfirmText } = await import('../src/lib/notifications/cardPatch.ts');
const { getDrafts } = await import('../src/lib/notifications/drafts.ts');

const doc = dom.document as unknown as Document;
let seq = 0;
const item = (over: Partial<Notification> = {}): Notification => ({
  id: `ntf_00000000dis${String(++seq).padStart(6, '0')}`, type: 'dialogue', title: 'Deploy?', text: '',
  priority: 'medium', visibility: 'private', pinned: false, popup: false, blocking: false, scope: 'auto',
  caller: { kind: 'anonymous', verification: 'unverified' }, sender: { kind: 'app', id: 'com.example.ci', name: 'CI', attribution: 'verified' },
  senderKey: 'app:com.example.ci', state: 'active', createdAt: 1, updatedAt: 1, history: [],
  ...over,
} as Notification);
const form = [{ kind: 'input', id: 'why', label: 'Why' }] as Notification['components'];
function harness() {
  const calls: string[] = [];
  const actions = {
    resolve: async () => ({ ok: true as const }), interact: async () => ({ ok: true as const }), forceRemove: async () => ({ ok: true as const }),
    dismiss: async (id: string) => { calls.push(`dismiss:${id}`); return { ok: true as const }; },
  };
  return { calls, actions };
}
const x = (card: HTMLElement) => card.querySelector<HTMLButtonElement>('[data-ntf-action="dismiss"]')!;
const confirmEl = (card: HTMLElement) => card.querySelector<HTMLElement>('.aura-ntf-dismiss-confirm');
const btn = (card: HTMLElement, role: string) => confirmEl(card)!.querySelector<HTMLButtonElement>(`.aura-confirm-btn[data-role="${role}"]`)!;

test('rule: unanswered dialogue and form-only Simple ask; answered, Simple and Locked do not; the draft warning', () => {
  assert.equal(needsDismissConfirm(item(), null).confirm, true);
  assert.equal(needsDismissConfirm(item({ type: 'simple', components: form }), null).confirm, true);
  assert.equal(needsDismissConfirm(item({ state: 'resolved' }), null).confirm, false);
  assert.equal(needsDismissConfirm(item({ type: 'simple' }), null).confirm, false);
  assert.equal(needsDismissConfirm(item({ type: 'locked', components: form }), null).confirm, false);
  assert.equal(needsDismissConfirm(item(), { why: 'because' }).draftLost, true);
  assert.equal(needsDismissConfirm(item(), { why: '  ' }).draftLost, false);
  assert.equal(dismissConfirmText('CI'), "You haven't answered this yet. CI is waiting for a reply and will be told you dismissed it.");
});

test('✕ on an unanswered question asks: [Answer] [Dismiss anyway] [Cancel]; Answer opens it; nothing dismissed', async () => {
  resetDom();
  const { calls, actions } = harness();
  const answered: string[] = [];
  const n = item({ components: form });
  const card = renderNotificationCard(n, { mode: 'list', actions, onAnswer: (it: Notification) => { answered.push(it.id); return true; } } as never);
  doc.body.appendChild(card);
  x(card).click();
  assert.ok(confirmEl(card), 'asks first');
  assert.match(confirmEl(card)!.textContent ?? '', /You haven't answered this yet\. CI is waiting/);
  assert.deepEqual([...confirmEl(card)!.querySelectorAll('.aura-confirm-btn')].map((b) => b.textContent), ['Answer', 'Dismiss anyway', 'Cancel']);
  assert.equal(doc.activeElement, btn(card, 'primary'), 'Answer is focused (Enter answers)');
  btn(card, 'primary').click();
  assert.deepEqual(answered, [n.id]);
  assert.equal(confirmEl(card), null);
  assert.deepEqual(calls, []);
});

test('Dismiss anyway dismisses and drops the draft; the draft warning is shown first', async () => {
  resetDom();
  const { calls, actions } = harness();
  const n = item({ components: form });
  getDrafts().set(n.id, 'why', 'half an answer');
  const card = renderNotificationCard(n, { mode: 'list', actions } as never);
  doc.body.appendChild(card);
  card.focus();
  card.dispatchEvent(new dom.KeyboardEvent('keydown', { key: 'Delete', bubbles: true }) as unknown as Event);
  assert.match(confirmEl(card)!.textContent ?? '', /Your entered answers will be lost\./, 'Delete asks too');
  btn(card, 'confirm').click();
  await flush();
  assert.deepEqual(calls, [`dismiss:${n.id}`]);
  assert.equal(getDrafts().get(n.id), null, 'draft cleared only now');
});

test('Cancel / Escape closes it and focus returns to the ✕; Simple items dismiss at once', async () => {
  resetDom();
  const { calls, actions } = harness();
  const n = item();
  getDrafts().set(n.id, 'x', 'keep me');
  const card = renderNotificationCard(n, { mode: 'list', actions } as never);
  doc.body.appendChild(card);
  x(card).click();
  confirmEl(card)!.dispatchEvent(new dom.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }) as unknown as Event);
  assert.equal(confirmEl(card), null);
  assert.equal(doc.activeElement, x(card), 'focus back on the ✕');
  assert.deepEqual(getDrafts().get(n.id), { x: 'keep me' }, 'the draft survives a cancel');
  assert.deepEqual(calls, []);
  const s = renderNotificationCard(item({ type: 'simple' }), { mode: 'list', actions } as never);
  doc.body.appendChild(s);
  x(s).click();
  await flush();
  assert.equal(confirmEl(s), null);
  assert.equal(calls.length, 1, 'no confirm for Simple items');
});
