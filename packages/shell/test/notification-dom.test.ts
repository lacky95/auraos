// DOM tests (phase 6) for the runtime-rendered notification UI, on happy-dom:
// NotificationCard (rendering, value collection, interactions, patch in
// place / focus keeping, Locked menu, drafts), the dialogue frame + window
// dialogue (focus, Escape, ✕, blocking inert, exit animation), the Dock
// button view (count states, tiers, labels) and the native-surface overlay
// selectors.
//
//   cd packages/shell && npx tsx --test test/notification-dom.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dom, flush, resetDom, setRect } from './dom.ts';
import type { Notification } from '../src/lib/notifications/api.ts';

const { renderNotificationCard, updateNotificationCard, collectValues } = await import('../src/components/shell/notifications/NotificationCard.ts');
const { buildDialogFrame, playExit } = await import('../src/components/shell/notifications/DialogFrame.ts');
const { mountWindowDialog } = await import('../src/components/shell/notifications/WindowDialog.ts');
const { buttonView, buttonTierMax } = await import('../src/lib/notifications/buttonView.ts');
const { occluderOf, OVERLAY_SELECTORS } = await import('../src/lib/nativeSurface.ts');
const { EXIT_FALLBACK_MS } = await import('../src/lib/notifications/exit.ts');

const doc = dom.document as unknown as Document;

let seq = 0;
/** Unique ids per item: drafts are keyed by id and outlive a test. */
const item = (over: Partial<Notification> = {}): Notification => ({
  id: `ntf_00000000dom${String(++seq).padStart(6, '0')}`, type: 'simple', title: 'Build finished', text: 'See https://example.com/log for details',
  priority: 'medium', visibility: 'private', pinned: false, popup: false, blocking: false, scope: 'auto',
  caller: { kind: 'instance', appId: 'com.example.ci', instanceId: 'com.example.ci', verification: 'verified' },
  sender: { kind: 'app', id: 'com.example.ci', name: 'CI', attribution: 'verified' },
  senderKey: 'app:com.example.ci', state: 'active', createdAt: 1_000, updatedAt: 1_000, history: [],
  ...over,
} as Notification);

const FORM = [
  { kind: 'input', id: 'name', label: 'Name', required: true },
  { kind: 'options', id: 'env', label: 'Environment', options: [{ id: 'dev', label: 'Dev' }, { id: 'prod', label: 'Prod' }] },
  { kind: 'options', id: 'tags', multiple: true, options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
  { kind: 'progress', value: 0.4, label: 'Upload' },
] as Notification['components'];

function recorder() {
  const calls: Array<[string, ...unknown[]]> = [];
  const ok = async () => ({ ok: true as const });
  return {
    calls,
    actions: {
      resolve: async (id: string, answer: Record<string, unknown>) => { calls.push(['resolve', id, answer]); return ok(); },
      dismiss: async (id: string) => { calls.push(['dismiss', id]); return ok(); },
      interact: async (id: string, p: unknown) => { calls.push(['interact', id, p]); return ok(); },
      forceRemove: async (id: string) => { calls.push(['forceRemove', id]); return ok(); },
    },
  };
}

const $ = <T extends Element = HTMLElement>(root: ParentNode, sel: string) => root.querySelector(sel) as T | null;
const click = (el: Element | null) => { assert.ok(el, 'element to click'); (el as HTMLElement).click(); };
const key = (el: Element, k: string, init: Record<string, unknown> = {}) =>
  el.dispatchEvent(new dom.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init } as never) as unknown as Event);
function type(field: HTMLInputElement | HTMLTextAreaElement, v: string) {
  field.value = v;
  field.dispatchEvent(new dom.Event('input', { bubbles: true }) as unknown as Event);
}
function check(input: HTMLInputElement, on = true) {
  input.checked = on;
  input.dispatchEvent(new dom.Event('change', { bubbles: true }) as unknown as Event);
}

// ── NotificationCard ────────────────────────────────────────────────────────

test('card: title, sender, linkified text (http only), tags and the unseen marker; no markup interpreted', () => {
  resetDom();
  const { actions } = recorder();
  const card = renderNotificationCard(item({ title: '<b>Hi</b>', pinned: true, priority: 'high', text: 'x javascript:alert(1) https://ok.test/a.' }), { mode: 'list', actions, now: 2_000 });
  doc.body.appendChild(card);
  assert.equal($(card, '.aura-ntf-title')!.textContent, '<b>Hi</b>');
  assert.ok(card.querySelector('b') === null, 'title is text, never HTML');
  assert.equal($(card, '.aura-ntf-sender')!.textContent, 'CI');
  const links = [...card.querySelectorAll('a.aura-ntf-link')];
  assert.deepEqual(links.map((a) => a.getAttribute('href')), ['https://ok.test/a']);
  assert.equal(links[0]!.getAttribute('rel'), 'noopener noreferrer');
  const tags = [...card.querySelectorAll<HTMLElement>('.aura-ntf-tag')].map((t) => t.dataset['tag']);
  assert.deepEqual(tags, ['pinned', 'high']);
  assert.ok($(card, '.aura-ntf-unseen-dot'));
  assert.equal(card.dataset['unseen'], 'true');
  assert.ok($(card, '[data-ntf-action="dismiss"]'), 'list cards have a dismiss ✕');
});

test('card: every component renders with the shared aura-ctl style and ARIA', () => {
  resetDom();
  const { actions } = recorder();
  const card = renderNotificationCard(item({ type: 'dialogue', components: FORM }), { mode: 'dialog', actions });
  doc.body.appendChild(card);
  const name = $<HTMLInputElement>(card, '[data-ntf-input="name"]')!;
  assert.ok(name.classList.contains('aura-ctl-input'));
  assert.equal(name.required, true);
  assert.equal(name.getAttribute('aria-required'), 'true');
  assert.equal(doc.getElementById(name.getAttribute('aria-describedby')!)!.className, 'aura-ctl-error');
  assert.equal($<HTMLLabelElement>(card, `label[for="${name.id}"]`)!.textContent!.includes('Name'), true);
  const env = $<HTMLFieldSetElement>(card, 'fieldset[data-style="segmented"]')!;
  assert.equal(env.querySelector('legend')!.textContent, 'Environment');
  assert.equal(env.querySelectorAll('input[type="radio"]').length, 2);
  const tags = $<HTMLFieldSetElement>(card, 'fieldset[data-style="list"]')!;
  assert.equal(tags.querySelectorAll('input[type="checkbox"]').length, 2);
  assert.ok(tags.querySelector('legend.aura-sr-only'), 'an unlabeled group still has a (hidden) legend');
  const bar = $(card, '[role="progressbar"]')!;
  assert.equal(bar.getAttribute('aria-valuenow'), '40');
  // Standard dialogue buttons: Cancel + Submit (no Later without onLater), Submit primary.
  const btns = [...card.querySelectorAll<HTMLButtonElement>('.aura-ntf-btn')];
  assert.deepEqual(btns.map((b) => [b.textContent, b.dataset['behaviour'], b.dataset['variant']]), [['Cancel', 'cancel', 'secondary'], ['Submit', 'submit', 'primary']]);
});

test('card: collectValues reads inputs, the radio choice and the checkbox set', () => {
  resetDom();
  const n = item({ type: 'dialogue', components: FORM });
  const card = renderNotificationCard(n, { mode: 'dialog', actions: recorder().actions });
  doc.body.appendChild(card);
  assert.deepEqual(collectValues(card, n), { name: '', tags: [] });
  type($<HTMLInputElement>(card, '[data-ntf-input="name"]')!, 'Ada');
  check($<HTMLInputElement>(card, 'input[data-ntf-options="env"][value="prod"]')!);
  check($<HTMLInputElement>(card, 'input[data-ntf-options="tags"][value="b"]')!);
  assert.deepEqual(collectValues(card, n), { name: 'Ada', env: 'prod', tags: ['b'] });
});

test('card: list cards interact on change; dialogue fields are local until a button', async () => {
  resetDom();
  const comps = [{ kind: 'options', id: 'env', options: [{ id: 'dev', label: 'Dev' }, { id: 'prod', label: 'Prod' }] }] as Notification['components'];
  const r1 = recorder();
  const ln = item({ components: comps });
  const list = renderNotificationCard(ln, { mode: 'list', actions: r1.actions });
  doc.body.appendChild(list);
  check($<HTMLInputElement>(list, 'input[value="dev"]')!);
  await flush();
  assert.deepEqual(r1.calls, [['interact', ln.id, { componentId: 'env', value: 'dev', values: { env: 'dev' } }]]);
  const r2 = recorder();
  const dlg = renderNotificationCard(item({ id: 'ntf_00000000dox000002', type: 'dialogue', components: comps }), { mode: 'dialog', actions: r2.actions });
  doc.body.appendChild(dlg);
  check($<HTMLInputElement>(dlg, 'input[value="prod"]')!);
  await flush();
  assert.deepEqual(r2.calls, [], 'a dialogue sends nothing on change');
});

test('card: Submit validates required fields first; Cancel never validates and sends no values', async () => {
  resetDom();
  const r = recorder();
  const n = item({ type: 'dialogue', components: FORM });
  const card = renderNotificationCard(n, { mode: 'dialog', actions: r.actions });
  doc.body.appendChild(card);
  const submit = $<HTMLButtonElement>(card, '[data-behaviour="submit"]')!;
  click(submit);
  await flush();
  assert.equal(r.calls.length, 0, 'blocked by the empty required field');
  const name = $<HTMLInputElement>(card, '[data-ntf-input="name"]')!;
  assert.equal(name.getAttribute('aria-invalid'), 'true');
  assert.equal(doc.getElementById(name.getAttribute('aria-describedby')!)!.textContent, 'Required');
  assert.ok(doc.activeElement === name, 'focus moves to the missing field');
  type(name, 'Ada');
  assert.equal(name.getAttribute('aria-invalid'), null, 'typing clears the error');
  click(submit);
  await flush();
  assert.deepEqual(r.calls.at(-1), ['resolve', n.id, { outcome: 'submitted', buttonId: 'submit', values: { name: 'Ada', tags: [] } }]);
  const r2 = recorder();
  const c2 = renderNotificationCard(item({ id: 'ntf_00000000dox000003', type: 'dialogue', components: FORM }), { mode: 'dialog', actions: r2.actions });
  doc.body.appendChild(c2);
  click($(c2, '[data-behaviour="cancel"]'));
  await flush();
  assert.deepEqual(r2.calls, [['resolve', 'ntf_00000000dox000003', { outcome: 'cancelled', buttonId: 'cancel' }]]);
});

test('card: Enter in a single-line dialogue field presses the primary button', async () => {
  resetDom();
  const r = recorder();
  const n = item({ type: 'dialogue', components: [{ kind: 'input', id: 'q', label: 'Q' }] as Notification['components'] });
  const card = renderNotificationCard(n, { mode: 'dialog', actions: r.actions });
  doc.body.appendChild(card);
  const f = $<HTMLInputElement>(card, '[data-ntf-input="q"]')!;
  type(f, 'yes');
  key(f, 'Enter');
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(r.calls)), [['resolve', n.id, { outcome: 'submitted', buttonId: 'submit', values: { q: 'yes' } }]]);
});

test('card update: a text / progress patch keeps the element, typed value and focus; a rebuild keeps value, focus and caret', () => {
  resetDom();
  const opts = { mode: 'list' as const, actions: recorder().actions };
  const comps = [{ kind: 'input', id: 'note', label: 'Note' }, { kind: 'progress', value: 0.1 }] as Notification['components'];
  const n = item({ components: comps });
  const card = renderNotificationCard(n, opts);
  doc.body.appendChild(card);
  const f = $<HTMLInputElement>(card, '[data-ntf-input="note"]')!;
  f.focus();
  type(f, 'half typed');
  const patched = updateNotificationCard(card, item({ id: n.id, components: [comps![0]!, { kind: 'progress', value: 0.7 }] as Notification['components'], text: 'new text', updatedAt: 2 }), opts);
  assert.ok(patched === card, 'same element (patched in place)');
  assert.ok($(card, '[data-ntf-input="note"]') === f, 'the field was never replaced');
  assert.ok(doc.activeElement === f, 'focus');
  assert.equal($(card, '[role="progressbar"]')!.getAttribute('aria-valuenow'), '70');
  assert.equal($(card, '.aura-ntf-text')!.textContent, 'new text');
  f.setSelectionRange(2, 4);
  const rebuilt = updateNotificationCard(card, item({ id: n.id, components: [{ kind: 'input', id: 'note', label: 'Your note' }] as Notification['components'], updatedAt: 3 }), opts);
  assert.ok(rebuilt !== card, 'a label change rebuilds');
  assert.ok(rebuilt.isConnected && !card.isConnected);
  const f2 = $<HTMLInputElement>(rebuilt, '[data-ntf-input="note"]')!;
  assert.equal(f2.value, 'half typed');
  assert.ok(doc.activeElement === f2, 'focus follows to the same field');
  assert.deepEqual([f2.selectionStart, f2.selectionEnd], [2, 4]);
});

test('card update: a background update never steals focus that was elsewhere', () => {
  resetDom('<input id="outside">');
  const outside = doc.getElementById('outside') as HTMLInputElement;
  outside.focus();
  const opts = { mode: 'toast' as const, actions: recorder().actions };
  const n = item();
  const card = renderNotificationCard(n, opts);
  doc.body.appendChild(card);
  updateNotificationCard(card, { ...n, priority: 'urgent', updatedAt: 5 }, opts);
  assert.ok(doc.activeElement === outside, 'focus');
});

test('card: pop-ups get a hide ✕ (never dismiss); Locked list cards: no ✕, ⋯ → Force remove… → confirm', async () => {
  resetDom();
  const closed: string[] = [];
  const tn = item({ type: 'locked' });
  const toast = renderNotificationCard(tn, { mode: 'toast', actions: recorder().actions, onClose: (n) => closed.push(n.id) });
  doc.body.appendChild(toast);
  assert.ok($(toast, '[data-ntf-action="dismiss"]') === null, 'element');
  click($(toast, '[data-action="hide"]'));
  assert.deepEqual(closed, [tn.id]);

  const r = recorder();
  const n = item({ id: 'ntf_00000000dox000004', type: 'locked', components: [{ kind: 'button', id: 'x', label: 'Close', action: 'dismiss' }] as Notification['components'] });
  const card = renderNotificationCard(n, { mode: 'list', actions: r.actions });
  doc.body.appendChild(card);
  assert.ok($(card, '[data-ntf-action="dismiss"]') === null, 'no ✕');
  assert.equal($<HTMLButtonElement>(card, '[data-behaviour="dismiss"]')!.disabled, true, "the sender's dismiss button is disabled");
  card.focus();
  key(card, 'Delete');
  await flush();
  assert.equal(r.calls.length, 0, 'Delete does not dismiss a Locked card');
  const more = $<HTMLButtonElement>(card, '[aria-haspopup="menu"]')!;
  click(more);
  assert.equal(more.getAttribute('aria-expanded'), 'true');
  const menuItem = $<HTMLButtonElement>(card, '[role="menuitem"]')!;
  assert.ok(doc.activeElement === menuItem, 'focus');
  // A background update while the menu is open keeps the card.
  assert.ok(updateNotificationCard(card, { ...n, title: 'changed', updatedAt: 9 }, { mode: 'list', actions: r.actions }) === card, 'kept while the menu is open');
  click(menuItem);
  const confirm = $<HTMLButtonElement>(card, '.aura-confirm [data-confirm="yes"], .aura-confirm button')!;
  assert.ok(confirm, 'inline confirm shown');
  assert.match(card.textContent ?? '', /The sender will be told/);
  key($(card, '.aura-ntf-menu')!, 'Escape');
  assert.equal(more.getAttribute('aria-expanded'), 'false');
  assert.ok(doc.activeElement === more, 'Escape returns focus to ⋯');
  click(more);
  click($(card, '[role="menuitem"]'));
  const yes = [...card.querySelectorAll<HTMLButtonElement>('.aura-ntf-menu button')].find((b) => b.textContent === 'Remove')!;
  click(yes);
  await flush();
  assert.deepEqual(r.calls, [['forceRemove', 'ntf_00000000dox000004']]);
});

test('card: a draft typed in one rendering is restored in the next (and synced live between two)', () => {
  resetDom();
  const n = item({ id: 'ntf_00000000dox000005', type: 'dialogue', components: [{ kind: 'input', id: 'why', label: 'Why' }] as Notification['components'] });
  const a = renderNotificationCard(n, { mode: 'dialog', actions: recorder().actions });
  const b = renderNotificationCard(n, { mode: 'list', actions: recorder().actions, expanded: true });
  doc.body.append(a, b);
  type($<HTMLInputElement>(a, '[data-ntf-input="why"]')!, 'because');
  assert.equal($<HTMLInputElement>(b, '[data-ntf-input="why"]')!.value, 'because', 'synced to the other rendering');
  a.remove(); b.remove();
  const c = renderNotificationCard(n, { mode: 'dialog', actions: recorder().actions });
  assert.equal($<HTMLInputElement>(c, '[data-ntf-input="why"]')!.value, 'because', 'restored after a re-open');
});

// ── Dialogue frame / window dialogue ────────────────────────────────────────

test('dialogue frame: takeFocus focuses the first field and gives focus back on dispose; Escape = Later', () => {
  resetDom('<button id="before">x</button>');
  const before = doc.getElementById('before') as HTMLButtonElement;
  before.focus();
  let later = 0;
  const f = buildDialogFrame(item({ type: 'dialogue', components: FORM }), { actions: recorder().actions, takeFocus: true, onLater: () => later++ });
  doc.body.appendChild(f.root);
  f.focus();
  assert.ok(doc.activeElement === $(f.root, '[data-ntf-input="name"]'), 'first field focused');
  assert.equal(f.root.getAttribute('role'), 'dialog');
  assert.ok($(f.root, '.aura-dlg-close[aria-label="Close (answer later)"]'), 'header ✕');
  key(doc.activeElement!, 'Escape');
  assert.equal(later, 1);
  f.dispose();
  assert.ok(doc.activeElement === before, 'focus');
});

test('dialogue frame: without takeFocus nothing is focused; without onLater no ✕ and Escape does nothing', () => {
  resetDom('<input id="typing">');
  const typing = doc.getElementById('typing') as HTMLInputElement;
  typing.focus();
  const f = buildDialogFrame(item({ type: 'dialogue' }), { actions: recorder().actions, takeFocus: false, modal: true });
  doc.body.appendChild(f.root);
  assert.ok(doc.activeElement === typing, 'a forced pop-up never steals focus');
  assert.ok($(f.root, '.aura-dlg-close') === null, 'element');
  assert.equal(f.root.getAttribute('role'), 'alertdialog');
  assert.equal(f.root.dataset['open'], 'true');
});

test('window dialogue: blocking covers and inerts only its own window, released on dispose', async () => {
  resetDom(`
    <div class="app-slot" id="s1"><div class="slot-body"><iframe id="f1"></iframe></div></div>
    <div class="app-slot" id="s2"><div class="slot-body"><iframe id="f2"></iframe></div></div>`);
  const s1 = doc.getElementById('s1')!;
  const f1 = doc.getElementById('f1') as HTMLIFrameElement;
  const f2 = doc.getElementById('f2') as HTMLIFrameElement;
  const m = mountWindowDialog(s1, item({ type: 'dialogue', blocking: true }), { blocking: true, takeFocus: true, actions: recorder().actions, onLater: () => {} })!;
  const host = $(s1, '.slot-body > .aura-dlg-host')!;
  assert.equal(host.dataset['blocking'], 'true');
  assert.ok(host.classList.contains('aura-dlg') && host.dataset['open'] === 'true', 'the cover occludes native surfaces');
  assert.equal(f1.inert, true);
  assert.equal(f2.inert, false, 'other windows stay usable');
  assert.ok($(host, '.aura-dlg-close') === null, 'blocking has no Later ✕');
  m.dispose();
  assert.equal(f1.inert, false, 'inert is released at once');
  const panel = $(host, '.aura-dlg-window');
  if (panel) panel.dispatchEvent(new dom.Event('animationend') as unknown as Event);
  await new Promise((r) => setTimeout(r, EXIT_FALLBACK_MS + 30));
  assert.ok($(s1, '.aura-dlg-host') === null, 'the host goes when empty');
});

test('window dialogue: non-blocking is a collapsible panel; the app stays usable', () => {
  resetDom('<div class="app-slot" id="s1"><div class="slot-body"><iframe id="f1"></iframe></div></div>');
  const s1 = doc.getElementById('s1')!;
  mountWindowDialog(s1, item({ type: 'dialogue' }), { blocking: false, takeFocus: false, actions: recorder().actions, onLater: () => {} });
  const host = $(s1, '.aura-dlg-host')!;
  assert.equal(host.dataset['blocking'], 'false');
  assert.equal((doc.getElementById('f1') as HTMLIFrameElement).inert, false);
  const toggle = $<HTMLButtonElement>(host, '.aura-dlg-btn[aria-expanded]')!;
  click(toggle);
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal($(host, '.aura-dlg-window')!.dataset['collapsed'], 'true');
});

test('exit animation: slide-out marks data-exit, removes on animationend or the fallback; instant for lock; once only', async () => {
  resetDom();
  const a = doc.createElement('section');
  a.dataset['open'] = 'true';
  doc.body.appendChild(a);
  let removed = 0;
  playExit(a, () => { removed++; a.remove(); });
  assert.equal(a.dataset['exit'], 'true');
  assert.equal(a.dataset['open'], 'false', 'stops occluding native surfaces at once');
  playExit(a, () => { removed += 10; });
  a.dispatchEvent(new dom.Event('animationend') as unknown as Event);
  assert.equal(removed, 1);
  assert.equal(a.isConnected, false);

  const b = doc.createElement('section');
  doc.body.appendChild(b);
  playExit(b, () => b.remove());
  await new Promise((r) => setTimeout(r, EXIT_FALLBACK_MS + 30));
  assert.equal(b.isConnected, false, 'fallback when animationend never fires');

  const c = doc.createElement('section');
  doc.body.appendChild(c);
  playExit(c, () => c.remove(), { instant: true });
  assert.equal(c.isConnected, false, 'lock / wipe: instant');
});

// ── Dock button view ────────────────────────────────────────────────────────

test('button view: counts 0/0, 0/n, n/n; priority tint; caps; aria-label and tooltip', () => {
  const env = { bodyWidth: 1280, locked: false, senderOf: (n: Notification) => n.sender.name ?? '?' };
  const snap = (o: Record<string, unknown> = {}) => ({ unseenCount: 0, totalCount: 0, highestUnseenPriority: null, mostImportant: null, error: null, ...o }) as Parameters<typeof buttonView>[0];
  const empty = buttonView(snap(), env);
  assert.deepEqual([empty.newText, empty.totalText, empty.prio, empty.tierMax, empty.latest], ['0', '/0', 'none', 'compact', null]);
  assert.equal(empty.ariaLabel, 'Notifications: 0 new, 0 total');
  const top = item({ title: 'Approve deploy?', priority: 'high', pinned: true });
  const seenOnly = buttonView(snap({ totalCount: 4, mostImportant: { ...top, seenAt: 5 } }), env);
  assert.deepEqual([seenOnly.newText, seenOnly.totalText, seenOnly.prio, seenOnly.tierMax], ['0', '/4', 'none', 'wide']);
  assert.equal(seenOnly.latest!.unseen, false);
  const fresh = buttonView(snap({ unseenCount: 1, totalCount: 4, highestUnseenPriority: 'high', mostImportant: top }), env);
  assert.deepEqual([fresh.newText, fresh.prio, fresh.latest!.text, fresh.latest!.pinned], ['1', 'high', 'CI: Approve deploy?', true]);
  assert.equal(fresh.ariaLabel, 'Notifications: 1 new, 4 total. Most important: CI — Approve deploy?');
  assert.equal(fresh.title, '1 new · 4 total\nMost important: CI — Approve deploy?');
  const many = buttonView(snap({ unseenCount: 120, totalCount: 1200, highestUnseenPriority: 'urgent', mostImportant: top }), env);
  assert.deepEqual([many.newText, many.totalText, many.prio], ['99+', '/999+', 'urgent']);
  const locked = buttonView(snap({ unseenCount: 1, totalCount: 1, mostImportant: top }), { ...env, locked: true });
  assert.equal(locked.ariaLabel, 'Notifications: 1 new, 1 total', 'no snippet while locked');
  const err = buttonView(snap({ error: { status: 401, message: 'nope' } }), env);
  assert.equal(err.title, 'Notifications unavailable: nope');
});

test('button tiers: compact at phone width (body px) and with nothing active, wide otherwise', () => {
  const some = { mostImportant: item() };
  assert.equal(buttonTierMax(some, 390), 'compact');
  assert.equal(buttonTierMax(some, 639), 'compact');
  assert.equal(buttonTierMax(some, 640), 'wide');
  assert.equal(buttonTierMax({ mostImportant: null }, 1280), 'compact');
  assert.equal(buttonTierMax(null, 1280), 'compact');
});

// ── Native-surface overlays ─────────────────────────────────────────────────

test('native surface: the open list and visible pop-up cards occlude a surface they overlap', () => {
  resetDom(`
    <div id="notif-center" hidden></div>
    <div id="notif-toasts" class="notif-toasts" hidden><article class="aura-ntf" id="t1"></article></div>`);
  const names = OVERLAY_SELECTORS.map((o) => o.name);
  assert.ok(names.includes('notificationCenter') && names.includes('notificationToast') && names.includes('notificationDialog'));
  const surface = { x: 800, y: 300, width: 400, height: 400 };
  const center = doc.getElementById('notif-center')!;
  const region = doc.getElementById('notif-toasts')!;
  const toast = doc.getElementById('t1')!;
  setRect(center, { left: 900, top: 200, width: 360, height: 500 });
  setRect(toast, { left: 900, top: 600, width: 360, height: 90 });
  assert.equal(occluderOf(surface), null, 'closed list + hidden region occlude nothing');
  center.hidden = false;
  assert.equal(occluderOf(surface), 'notificationCenter');
  center.hidden = true;
  region.hidden = false;
  assert.equal(occluderOf(surface), 'notificationToast');
  assert.equal(occluderOf({ x: 0, y: 0, width: 300, height: 200 }), null, 'a surface elsewhere stays visible');
  toast.remove();
  assert.equal(occluderOf(surface), null);
});

// ── Pop-up stack: max 3, sticky slots, eviction, the overflow queue ─────────

test('pop-up stack: never more than 3; high evicts the oldest non-sticky; sticky holds its slot; overflow queues and refills by priority', async () => {
  const { admitToast, ToastQueue, MAX_TOASTS } = await import('../src/lib/notifications/toasts.ts');
  type T = { id: string; priority: Notification['priority']; popupDurationMs?: number };
  const stack: T[] = [];
  const queue = new ToastQueue(() => 0);
  const arrive = (t: T) => {
    const a = admitToast(stack, t);
    if (!a.admit) { queue.enqueue(t); return 'queued'; }
    if (a.evict) stack.splice(stack.findIndex((s) => s.id === a.evict), 1);
    stack.push(t);
    assert.ok(stack.length <= MAX_TOASTS);
    return a.evict ? `evicted ${a.evict}` : 'shown';
  };
  const free = (id: string) => {
    stack.splice(stack.findIndex((s) => s.id === id), 1);
    const next = queue.next();
    if (next) stack.push(queued.get(next)!);
  };
  const queued = new Map<string, T>();
  const mk = (id: string, priority: T['priority'], popupDurationMs?: number): T => {
    const t = { id, priority, ...(popupDurationMs !== undefined ? { popupDurationMs } : {}) };
    queued.set(id, t);
    return t;
  };
  assert.equal(arrive(mk('a', 'low', -1)), 'shown');          // sticky
  assert.equal(arrive(mk('b', 'medium')), 'shown');
  assert.equal(arrive(mk('c', 'low')), 'shown');
  assert.equal(arrive(mk('d', 'medium')), 'queued', 'full: low / medium wait');
  assert.equal(arrive(mk('e', 'high')), 'evicted b', 'high pushes out the oldest NON-sticky low/medium');
  assert.equal(arrive(mk('f', 'urgent')), 'evicted c');
  assert.deepEqual(stack.map((s) => s.id), ['a', 'e', 'f']);
  assert.equal(arrive(mk('g', 'low')), 'queued');
  assert.equal(arrive(mk('h', 'high')), 'evicted e', 'then the oldest non-sticky high');
  free('a');                                                  // the sticky one is dismissed
  assert.deepEqual(stack.map((s) => s.id), ['f', 'h', 'd'], 'FIFO within the same priority');
  free('d');
  assert.deepEqual(stack.map((s) => s.id), ['f', 'h', 'g']);
  assert.equal(queue.size, 0);
  // Three sticky pop-ups: even urgent goes to the list (queue) only.
  stack.splice(0, 3, mk('s1', 'low', 0), mk('s2', 'medium', -1), mk('s3', 'high', -1));
  assert.equal(arrive(mk('u', 'urgent')), 'queued');
  queue.clear();                                              // the list opened
  assert.equal(queue.next(), undefined);
});
