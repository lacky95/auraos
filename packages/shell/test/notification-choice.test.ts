// Select / combobox (phase 6): the DOM-free logic (filter, typeahead,
// navigation, settle) and the rendered ARIA combobox / listbox on happy-dom
// (keyboard, mouse, popup placement outside the card, values, drafts,
// patch in place, interact vs dialogue-local, required validation).
//
//   cd packages/shell && npx tsx --test test/notification-choice.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dom, flush, resetDom } from './dom.ts';
import type { Notification } from '../src/lib/notifications/api.ts';
import {
  comboStateFor, comboValue, exactChoice, filterChoices, fold, navigate, settleCombo, typeahead,
} from '../src/lib/notifications/choices.ts';
import { missingRequired } from '../src/lib/notifications/cardPatch.ts';
import { draftValuesFor } from '../src/lib/notifications/drafts.ts';
import { hasFormFields, isComplex } from '../src/lib/notifications/dialogs.ts';

const { renderNotificationCard, updateNotificationCard, collectValues } = await import('../src/components/shell/notifications/NotificationCard.ts');
const { choiceValue } = await import('../src/components/shell/notifications/ChoiceField.ts');

const doc = dom.document as unknown as Document;
const CITIES = [
  { id: 'vie', label: 'Vienna' }, { id: 'ber', label: 'Berlin' }, { id: 'bern', label: 'Bern' },
  { id: 'zrh', label: 'Zürich' }, { id: 'bud', label: 'Budapest' }, { id: 'lin', label: 'Linz' },
];

// ── DOM-free ────────────────────────────────────────────────────────────────

test('choices: fold / filter (prefix first, accent-insensitive) / exact match', () => {
  assert.equal(fold('  ZÜRICH  Hbf '), 'zurich hbf');
  assert.deepEqual(filterChoices(CITIES, 'ber').map((o) => o.id), ['ber', 'bern']);
  assert.deepEqual(filterChoices(CITIES, 'n').map((o) => o.id), ['vie', 'ber', 'bern', 'lin'], 'contains, in order');
  assert.deepEqual(filterChoices(CITIES, 'zur').map((o) => o.id), ['zrh']);
  assert.deepEqual(filterChoices(CITIES, 'b').map((o) => o.id), ['ber', 'bern', 'bud'], 'prefix matches first');
  assert.equal(filterChoices(CITIES, '').length, 6);
  assert.equal(exactChoice(CITIES, 'zurich')?.id, 'zrh');
  assert.equal(exactChoice(CITIES, 'Ber'), undefined);
});

test('choices: typeahead cycles on a repeated letter, refines on a longer buffer; navigation clamps', () => {
  assert.equal(typeahead(CITIES, 'b', -1), 1);
  assert.equal(typeahead(CITIES, 'b', 1), 2, 'same letter again → next B');
  assert.equal(typeahead(CITIES, 'bb', 2), 4, 'repeated letter keeps cycling');
  assert.equal(typeahead(CITIES, 'b', 4), 1, 'wraps');
  assert.equal(typeahead(CITIES, 'bern', 1), 2, 'a longer buffer refines from the current one');
  assert.equal(typeahead(CITIES, 'x', 0), -1);
  assert.equal(navigate('ArrowDown', -1, 6), 0);
  assert.equal(navigate('ArrowDown', 5, 6), 5, 'no wrap');
  assert.equal(navigate('ArrowUp', -1, 6), 5);
  assert.equal(navigate('ArrowUp', 0, 6), 0);
  assert.equal(navigate('End', 2, 6), 5);
  assert.equal(navigate('Home', 4, 6), 0);
  assert.equal(navigate('PageDown', 0, 60), 10);
  assert.equal(navigate('PageUp', 5, 60), 0);
  assert.equal(navigate('ArrowDown', -1, 0), -1);
});

test('choices: combobox value / settle / state for a stored value', () => {
  assert.equal(comboValue({ selected: 'vie', text: 'Vienna' }, false), 'vie');
  assert.equal(comboValue({ text: '  Graz ' }, true), 'Graz');
  assert.equal(comboValue({ text: 'Graz' }, false), undefined);
  assert.deepEqual(settleCombo(CITIES, 'vienna', false, { text: '' }), { selected: 'vie', text: 'Vienna' }, 'exact label picks it');
  assert.deepEqual(settleCombo(CITIES, 'Graz', true, { text: '' }), { text: 'Graz' }, 'free text kept');
  assert.deepEqual(settleCombo(CITIES, 'Graz', false, { selected: 'lin', text: 'Linz' }), { selected: 'lin', text: 'Linz' }, 'not allowed → last choice back');
  assert.deepEqual(settleCombo(CITIES, '  ', false, { selected: 'lin', text: 'Linz' }), { text: '' }, 'cleared');
  assert.deepEqual(comboStateFor(CITIES, 'zrh', false), { selected: 'zrh', text: 'Zürich' });
  assert.deepEqual(comboStateFor(CITIES, 'Graz', true), { text: 'Graz' });
  assert.deepEqual(comboStateFor(CITIES, 'Graz', false), { text: '' });
});

test('helpers know the new fields: required, drafts, form detection', () => {
  const comps = [
    { kind: 'select', id: 's', label: 'S', required: true, options: CITIES },
    { kind: 'combobox', id: 'c', required: true, options: CITIES },
    { kind: 'combobox', id: 'free', allowCustom: true, options: [] },
  ] as Notification['components'];
  assert.deepEqual(missingRequired(comps, {}).map((m) => m.id), ['s', 'c']);
  assert.deepEqual(missingRequired(comps, { s: 'vie', c: 'Graz' }).map((m) => m.id), []);
  assert.deepEqual(draftValuesFor({ components: comps }, { s: 'nope', c: 'ber', free: 'anything' }), { c: 'ber', free: 'anything' });
  assert.deepEqual(draftValuesFor({ components: comps }, { s: 'vie', c: 'free text' }), { s: 'vie' }, 'no free text without allowCustom');
  assert.equal(hasFormFields({ components: [comps![0]!] }), true);
  assert.equal(isComplex({ components: [...comps!, { kind: 'select', id: 'x', options: CITIES }] as Notification['components'] }), true);
});

// ── DOM ─────────────────────────────────────────────────────────────────────

let seq = 0;
const item = (components: Notification['components'], over: Partial<Notification> = {}): Notification => ({
  id: `ntf_00000000chc${String(++seq).padStart(6, '0')}`, type: 'dialogue', title: 'Where?', text: '', priority: 'medium',
  visibility: 'private', pinned: false, popup: false, blocking: false, scope: 'auto',
  caller: { kind: 'instance', appId: 'a.b', instanceId: 'a.b', verification: 'verified' },
  sender: { kind: 'app', id: 'a.b', name: 'App', attribution: 'verified' }, senderKey: 'app:a.b',
  state: 'active', createdAt: 1, updatedAt: 1, history: [], components, ...over,
} as Notification);

function recorder() {
  const calls: Array<[string, ...unknown[]]> = [];
  const ok = async () => ({ ok: true as const });
  return {
    calls,
    actions: {
      resolve: async (id: string, a: Record<string, unknown>) => { calls.push(['resolve', id, a]); return ok(); },
      dismiss: async (id: string) => { calls.push(['dismiss', id]); return ok(); },
      interact: async (id: string, p: unknown) => { calls.push(['interact', id, p]); return ok(); },
      forceRemove: async (id: string) => { calls.push(['forceRemove', id]); return ok(); },
    },
  };
}
const key = (el: Element, k: string, init: Record<string, unknown> = {}) =>
  el.dispatchEvent(new dom.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init } as never) as unknown as Event);
const listbox = () => doc.querySelector<HTMLElement>('body > .aura-ctl-listbox');
const activeLabel = (owner: HTMLElement) => {
  const id = owner.getAttribute('aria-activedescendant');
  return id ? doc.getElementById(id)?.textContent ?? null : null;
};
const plain = (x: unknown) => JSON.parse(JSON.stringify(x));

test('select: ARIA combobox + listbox; keyboard open / move / choose; popup at body level', async () => {
  resetDom();
  const r = recorder();
  const n = item([{ kind: 'select', id: 'city', label: 'City', placeholder: 'Pick a city', options: CITIES }]);
  const card = renderNotificationCard(n, { mode: 'dialog', actions: r.actions });
  doc.body.appendChild(card);
  const t = card.querySelector<HTMLButtonElement>('[role="combobox"]')!;
  assert.equal(t.getAttribute('aria-haspopup'), 'listbox');
  assert.equal(t.getAttribute('aria-expanded'), 'false');
  assert.match(t.getAttribute('aria-labelledby')!, /-label /);
  assert.equal(t.textContent, 'Pick a city');
  assert.equal(t.dataset['empty'], 'true');
  t.focus();
  key(t, 'ArrowDown');
  const lb = listbox()!;
  assert.ok(lb, 'the list opens at body level, outside the card');
  assert.ok(!card.contains(lb));
  assert.equal(t.getAttribute('aria-expanded'), 'true');
  assert.equal(t.getAttribute('aria-controls'), lb.id);
  assert.equal(lb.getAttribute('role'), 'listbox');
  assert.equal(lb.querySelectorAll('[role="option"]').length, 6);
  assert.equal(activeLabel(t), 'Vienna');
  key(t, 'ArrowDown'); key(t, 'ArrowDown');
  assert.equal(activeLabel(t), 'Bern');
  key(t, 'End');
  assert.equal(activeLabel(t), 'Linz');
  key(t, 'Home');
  key(t, 'z');
  assert.equal(activeLabel(t), 'Zürich', 'typeahead (accent-insensitive)');
  key(t, 'Enter');
  assert.equal(listbox(), null, 'closed after choosing');
  assert.equal(t.getAttribute('aria-expanded'), 'false');
  assert.equal(t.textContent, 'Zürich');
  assert.ok(doc.activeElement === t, 'focus stays on the field');
  assert.deepEqual(collectValues(card, n), { city: 'zrh' });
  assert.equal(r.calls.length, 0, 'a dialogue sends nothing on change');
  // Escape closes without choosing and does not propagate to the dialogue.
  let outer = 0;
  card.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Escape') outer++; });
  key(t, 'Enter');
  key(t, 'ArrowUp');
  key(t, 'Escape');
  assert.equal(listbox(), null);
  assert.equal(outer, 0, 'Escape stayed with the open list');
  assert.equal(choiceValue(card.querySelector('[data-ntf-choice="city"]')!), 'zrh');
  // Closed: typeahead changes the value directly (APG select-only combobox).
  key(t, 'l');
  assert.equal(t.textContent, 'Linz');
  key(t, 'Escape');
  assert.equal(outer, 1, 'a closed field lets Escape reach the dialogue');
});

test('select: mouse picks; outside click closes; arrow keys never reach the list roving; default preselected', async () => {
  resetDom();
  const r = recorder();
  const n = item([{ kind: 'select', id: 'city', options: CITIES, default: 'ber' }], { type: 'simple' });
  const card = renderNotificationCard(n, { mode: 'list', actions: r.actions });
  const panel = doc.createElement('div');
  let roving = 0;
  panel.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key.startsWith('Arrow')) roving++; });
  panel.appendChild(card);
  doc.body.appendChild(panel);
  const t = card.querySelector<HTMLButtonElement>('[role="combobox"]')!;
  assert.equal(t.textContent, 'Berlin');
  t.click();
  assert.equal(activeLabel(t), 'Berlin', 'opens on the chosen option');
  key(t, 'ArrowDown');
  assert.equal(roving, 0, 'navigation keys stay in the field');
  let docClicks = 0;
  const onDoc = () => docClicks++;
  doc.addEventListener('click', onDoc);
  const opts = listbox()!.querySelectorAll<HTMLElement>('[role="option"]');
  opts[4]!.click();
  doc.removeEventListener('click', onDoc);
  assert.equal(docClicks, 0, 'a list click is not an outside click for the panel');
  assert.equal(t.textContent, 'Budapest');
  await flush();
  assert.deepEqual(plain(r.calls), [['interact', n.id, { componentId: 'city', value: 'bud', values: { city: 'bud' } }]], 'list cards send the choice');
  t.click();
  assert.ok(listbox());
  doc.body.dispatchEvent(new dom.PointerEvent('pointerdown', { bubbles: true }) as unknown as Event);
  assert.equal(listbox(), null, 'outside pointerdown closes');
});

test('combobox: typing filters, Enter picks, free text with allowCustom, settle on blur, live status', async () => {
  resetDom();
  const r = recorder();
  const n = item([
    { kind: 'combobox', id: 'owner', label: 'Owner', allowCustom: true, options: CITIES },
    { kind: 'combobox', id: 'strict', label: 'Strict', options: CITIES },
  ]);
  const card = renderNotificationCard(n, { mode: 'dialog', actions: r.actions });
  doc.body.appendChild(card);
  const [own, strict] = [...card.querySelectorAll<HTMLInputElement>('input[role="combobox"]')];
  assert.equal(own!.getAttribute('aria-autocomplete'), 'list');
  own!.focus();
  own!.value = 'ber';
  own!.dispatchEvent(new dom.Event('input', { bubbles: true }) as unknown as Event);
  const lb = listbox()!;
  const labels = () => [...listbox()!.querySelectorAll('[role="option"]')].map((o) => o.textContent);
  assert.deepEqual(labels(), ['Use “ber”', 'Berlin', 'Bern'], 'free-text entry first, then the matches');
  assert.equal(lb.getAttribute('role'), 'listbox');
  assert.match(card.querySelector('[role="status"]')!.textContent!, /2 options/);
  key(own!, 'ArrowDown'); key(own!, 'ArrowDown');
  assert.equal(activeLabel(own!), 'Berlin');
  key(own!, 'Enter');
  assert.equal(own!.value, 'Berlin');
  assert.equal(listbox(), null);
  assert.deepEqual(collectValues(card, n), { owner: 'ber' });
  // Free text.
  own!.value = 'Grace Hopper';
  own!.dispatchEvent(new dom.Event('input', { bubbles: true }) as unknown as Event);
  key(own!, 'Escape');                       // close the list
  own!.blur();
  assert.deepEqual(collectValues(card, n), { owner: 'Grace Hopper' });
  // Strict: no free text; an exact label settles to that option, junk reverts.
  strict!.focus();
  strict!.value = 'linz';
  strict!.dispatchEvent(new dom.Event('input', { bubbles: true }) as unknown as Event);
  assert.deepEqual(labels(), ['Linz'], 'no "Use …" entry without allowCustom');
  strict!.blur();
  assert.equal(strict!.value, 'Linz');
  strict!.focus();
  strict!.value = 'nowhere';
  strict!.dispatchEvent(new dom.Event('input', { bubbles: true }) as unknown as Event);
  assert.equal(listbox()!.querySelector('.aura-ctl-listbox-empty')!.textContent, 'No matches');
  strict!.blur();
  assert.equal(strict!.value, 'Linz', 'the last choice comes back');
  assert.deepEqual(collectValues(card, n), { owner: 'Grace Hopper', strict: 'lin' });
  // Second Escape on a closed box clears it.
  strict!.focus();
  key(strict!, 'Escape');
  assert.equal(strict!.value, '');
  assert.deepEqual(collectValues(card, n), { owner: 'Grace Hopper' });
  assert.equal(r.calls.length, 0, 'dialogue: nothing sent until a button');
});

test('select / combobox in a dialogue: required validation, Submit carries the values, drafts restore, patch keeps them', async () => {
  resetDom();
  const r = recorder();
  const comps = [
    { kind: 'select', id: 'city', label: 'City', required: true, options: CITIES },
    { kind: 'combobox', id: 'owner', label: 'Owner', allowCustom: true, options: CITIES },
  ] as Notification['components'];
  const n = item(comps);
  const card = renderNotificationCard(n, { mode: 'dialog', actions: r.actions });
  doc.body.appendChild(card);
  const submit = card.querySelector<HTMLButtonElement>('[data-behaviour="submit"]')!;
  assert.equal(submit.textContent, 'Submit', 'fields → Submit (not OK)');
  submit.click();
  await flush();
  assert.equal(r.calls.length, 0);
  const t = card.querySelector<HTMLButtonElement>('[data-ntf-field="city"]')!;
  assert.equal(t.getAttribute('aria-invalid'), 'true');
  assert.ok(doc.activeElement === t, 'focus on the missing select');
  t.click();
  listbox()!.querySelectorAll<HTMLElement>('[role="option"]')[0]!.click();
  assert.equal(t.getAttribute('aria-invalid'), null, 'choosing clears the error');
  // Draft: a second rendering (after a re-open) restores the choice.
  const again = renderNotificationCard(n, { mode: 'dialog', actions: recorder().actions });
  assert.equal(again.querySelector('[data-ntf-field="city"]')!.textContent, 'Vienna');
  // Patch in place (text update) keeps the same field element and value.
  const patched = updateNotificationCard(card, { ...n, text: 'now with text', updatedAt: 2 }, { mode: 'dialog', actions: r.actions });
  assert.ok(patched === card && card.querySelector('[data-ntf-field="city"]') === t);
  // A rebuild (label change) carries the values over.
  const rebuilt = updateNotificationCard(card, { ...n, updatedAt: 3, components: [{ ...comps![0]!, label: 'Town' }, comps![1]!] as Notification['components'] }, { mode: 'dialog', actions: r.actions });
  assert.ok(rebuilt !== card);
  assert.equal(rebuilt.querySelector('[data-ntf-field="city"]')!.textContent, 'Vienna');
  rebuilt.querySelector<HTMLButtonElement>('[data-behaviour="submit"]')!.click();
  await flush();
  assert.deepEqual(plain(r.calls), [['resolve', n.id, { outcome: 'submitted', buttonId: 'submit', values: { city: 'vie' } }]]);
});

test('popup list follows its field and goes away with it; a system decision hosts it inside its overlay', () => {
  resetDom('<div class="aura-dlg-system" data-ntf-popup-host="true" id="dec"></div>');
  const n = item([{ kind: 'select', id: 'city', options: CITIES }]);
  const card = renderNotificationCard(n, { mode: 'dialog', actions: recorder().actions });
  doc.getElementById('dec')!.appendChild(card);
  const t = card.querySelector<HTMLButtonElement>('[role="combobox"]')!;
  t.click();
  const lb = doc.querySelector('.aura-ctl-listbox')!;
  assert.equal(lb.parentElement?.id, 'dec', 'not a body child (body children are inert under a decision)');
  assert.ok(['top', 'bottom'].includes((lb as HTMLElement).dataset['placement']!));
  card.remove();
  // The next frame notices the field is gone.
  return new Promise<void>((resolve) => dom.requestAnimationFrame(() => dom.requestAnimationFrame(() => {
    assert.equal(doc.querySelector('.aura-ctl-listbox'), null);
    resolve();
  })));
});
