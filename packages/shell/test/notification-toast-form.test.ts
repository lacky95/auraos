// A dialogue / form POP-UP (the toast in the bottom-right stack) must never
// re-render, re-activate or lose focus when its controls are used (user bug,
// phase 6). Mounts the real stack (toastStack.ts) on happy-dom with a fake
// runtime: segmented options, a radio list, a select, a combobox and an input.
//
//   cd packages/shell && npx tsx --test test/notification-toast-form.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dom, flush, resetDom } from './dom.ts';
import type { Notification } from '../src/lib/notifications/api.ts';

const { mountToasts } = await import('../src/components/shell/notifications/toastStack.ts');

const doc = dom.document as unknown as Document;

function fakeRuntime() {
  const items = new Map<string, Notification>();
  const subs: Array<(snap: unknown, changes: unknown[]) => void> = [];
  const calls: Array<[string, ...unknown[]]> = [];
  const emit = (changes: unknown[]) => { for (const s of subs) s({}, changes); };
  const put = (n: Notification, kind: 'added' | 'updated', source = 'live') => { items.set(n.id, n); emit([{ kind, id: n.id, source }]); };
  const ok = (n?: Notification) => ({ ok: true as const, ...(n ? { notification: n } : {}) });
  const rt = {
    store: {
      subscribe(fn: (snap: unknown, changes: unknown[]) => void) { subs.push(fn); return () => {}; },
      get: (id: string) => items.get(id) ?? null,
      isDisposed: false,
    },
    appLookup: () => undefined,
    actions: {
      markDisplayed: (id: string) => { calls.push(['displayed', id]); },
      markSeen: (ids: string[]) => {
        calls.push(['seen', ...ids]);
        // The server echo: seenAt set (the card must only patch, never rebuild).
        for (const id of ids) { const n = items.get(id); if (n && n.seenAt === undefined) queueMicrotask(() => put({ ...n, seenAt: 5, updatedAt: n.updatedAt + 1 }, 'updated')); }
      },
      interact: async (id: string, p: Record<string, unknown>) => {
        calls.push(['interact', id, p]);
        const n = items.get(id)!;
        queueMicrotask(() => put({ ...n, updatedAt: n.updatedAt + 1, lastInteraction: { ...(p as object), at: 9, actor: { kind: 'user' } } } as Notification, 'updated'));
        return ok();
      },
      resolve: async (id: string, a: unknown) => { calls.push(['resolve', id, a]); return ok(); },
      dismiss: async (id: string) => { calls.push(['dismiss', id]); return ok(); },
      forceRemove: async (id: string) => { calls.push(['forceRemove', id]); return ok(); },
    },
  };
  return { rt, calls, put };
}

const CITIES = [{ id: 'vie', label: 'Vienna' }, { id: 'ber', label: 'Berlin' }, { id: 'lin', label: 'Linz' }];
const form = (over: Partial<Notification> = {}): Notification => ({
  id: 'ntf_00000000tst000001', type: 'dialogue', title: 'Deploy?', text: 'Pick', priority: 'high', visibility: 'private',
  pinned: false, popup: false, blocking: false, scope: 'auto',
  caller: { kind: 'instance', appId: 'a.b', instanceId: 'a.b', verification: 'verified' },
  sender: { kind: 'app', id: 'a.b', name: 'App', attribution: 'verified' }, senderKey: 'app:a.b',
  state: 'active', createdAt: 1, updatedAt: 1, history: [],
  components: [
    { kind: 'options', id: 'env', label: 'Env', options: [{ id: 'dev', label: 'Dev' }, { id: 'prod', label: 'Prod' }] },
    { kind: 'options', id: 'when', label: 'When', display: 'radio', options: [{ id: 'now', label: 'Now', description: 'Right away' }, { id: 'tonight', label: 'Tonight' }] },
    { kind: 'select', id: 'city', label: 'City', options: CITIES },
    { kind: 'combobox', id: 'owner', label: 'Owner', allowCustom: true, options: CITIES },
    { kind: 'input', id: 'note', label: 'Note' },
    { kind: 'button', role: 'submit', id: 'submit' },
  ],
  ...over,
} as Notification);

const key = (el: Element, k: string) =>
  el.dispatchEvent(new dom.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true } as never) as unknown as Event);
const settle = async () => { await flush(); await flush(); };

async function mountWith(n: Notification) {
  resetDom('<div id="notif-toasts" class="notif-toasts" hidden></div>');
  const region = doc.getElementById('notif-toasts')!;
  const f = fakeRuntime();
  const dispose = mountToasts(region, async () => f.rt as never);
  await settle();
  f.put(n, 'added');
  await settle();
  const card = region.querySelector<HTMLElement>('.aura-ntf')!;
  assert.ok(card, 'the pop-up is shown');
  return { ...f, region, card, dispose };
}

test('pop-up form: chips, radios, select, combobox and input change only themselves — no interact, no rebuild, focus kept', async () => {
  const { calls, region, card, dispose } = await mountWith(form());
  const nodes = [...card.querySelectorAll('input, button, [role="combobox"]')];
  // 1) A segmented chip (its hidden radio covers the chip).
  const chip = card.querySelector<HTMLInputElement>('input[data-ntf-options="env"][value="prod"]')!;
  chip.focus();
  chip.click();
  await settle();
  assert.equal(card.dataset['active'], 'true', 'the first click on a control activates the pop-up');
  assert.ok(calls.some((c) => c[0] === 'seen'), 'and marks it seen');
  // 2) A radio row.
  card.querySelector<HTMLInputElement>('input[data-ntf-options="when"][value="tonight"]')!.click();
  await settle();
  // 3) The select: open, choose with the keyboard.
  const sel = card.querySelector<HTMLButtonElement>('[data-ntf-field="city"]')!;
  sel.focus();
  sel.click();
  await settle();
  assert.ok(doc.querySelector('.aura-ctl-listbox'), 'the list is open');
  key(sel, 'ArrowDown');
  key(sel, 'Enter');
  await settle();
  assert.ok(doc.activeElement === sel, 'focus stays on the select');
  // 4) The combobox: type, pick.
  const cmb = card.querySelector<HTMLInputElement>('[data-ntf-field="owner"]')!;
  cmb.focus();
  cmb.value = 'li';
  cmb.dispatchEvent(new dom.Event('input', { bubbles: true }) as unknown as Event);
  key(cmb, 'ArrowDown');   // "Use “li”" (allowCustom) …
  key(cmb, 'ArrowDown');   // … then Linz
  key(cmb, 'Enter');
  await settle();
  // 5) The input.
  const note = card.querySelector<HTMLInputElement>('[data-ntf-input="note"]')!;
  note.focus();
  note.value = 'hello';
  note.dispatchEvent(new dom.Event('input', { bubbles: true }) as unknown as Event);
  note.dispatchEvent(new dom.Event('change', { bubbles: true }) as unknown as Event);
  await settle();
  assert.ok(doc.activeElement === note, 'focus kept in the input');

  assert.deepEqual(calls.filter((c) => c[0] === 'interact'), [], 'a pop-up form is local state: nothing is sent on change');
  assert.ok(region.querySelector('.aura-ntf') === card, 'the same pop-up element (never rebuilt / re-inserted)');
  assert.ok(nodes.every((x) => x.isConnected && card.contains(x)), 'every control is the same node');
  assert.equal(card.dataset['exit'], undefined, 'not hiding');
  assert.equal(card.style.animation, '', 'no entrance animation replay');
  assert.equal(card.getAttribute('aria-busy'), null, 'never dimmed busy by a field change');
  // The values are all there for Submit.
  card.querySelector<HTMLButtonElement>('[data-behaviour="submit"]')!.click();
  await settle();
  const resolve = calls.find((c) => c[0] === 'resolve');
  assert.deepEqual(JSON.parse(JSON.stringify(resolve?.[2])), {
    outcome: 'submitted', buttonId: 'submit',
    values: { env: 'prod', when: 'tonight', city: 'ber', owner: 'lin', note: 'hello' },
  });
  dispose();
});

test('pop-up form: store echoes (seen, interacted, a sender text update) patch in place — never a rebuild', async () => {
  const { put, card, region, dispose } = await mountWith(form({ id: 'ntf_00000000tst000002' }));
  const sel = card.querySelector('[data-ntf-field="city"]');
  // This tab's own click: active + seen here (a seen echo must not hide it).
  card.querySelector<HTMLInputElement>('input[data-ntf-options="env"][value="dev"]')!.click();
  await settle();
  const base = form({ id: 'ntf_00000000tst000002' });
  put({ ...base, seenAt: 5, updatedAt: 2 }, 'updated');
  put({ ...base, seenAt: 5, updatedAt: 3, lastInteraction: { componentId: 'env', kind: 'options', value: 'dev', at: 3, actor: { kind: 'user', verification: 'unverified' } } } as Notification, 'updated');
  put({ ...base, seenAt: 5, updatedAt: 4, text: 'Pick one, please' }, 'updated');
  await settle();
  assert.ok(region.querySelector('.aura-ntf') === card, 'same element');
  assert.ok(card.querySelector('[data-ntf-field="city"]') === sel, 'same select');
  assert.equal(card.querySelector('.aura-ntf-text')!.textContent, 'Pick one, please');
  dispose();
});

test('pop-up form: a click on a control of an ACTIVE pop-up is a no-op for the pop-up (no re-activation / focus jump)', async () => {
  const { calls, card, dispose } = await mountWith(form({ id: 'ntf_00000000tst000003' }));
  card.querySelector<HTMLElement>('.aura-ntf-title')!.click();     // body click → activate (focus may move in)
  await settle();
  assert.equal(card.dataset['active'], 'true');
  const seen = calls.filter((c) => c[0] === 'seen').length;
  const radio = card.querySelector<HTMLInputElement>('input[data-ntf-options="when"][value="now"]')!;
  radio.focus();
  radio.click();
  await settle();
  assert.ok(doc.activeElement === radio, 'focus stays on the clicked radio');
  assert.equal(calls.filter((c) => c[0] === 'seen').length, seen, 'not marked seen again');
  dispose();
});
