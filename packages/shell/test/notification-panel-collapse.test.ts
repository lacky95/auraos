// In-window panel collapse (phase 4 bug fix): the collapsed state is the
// controller's view state, persisted per tab, and the chevron owns its click.
//
//   cd packages/shell && npx tsx --test test/notification-panel-collapse.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dom, flush, resetDom } from './dom.ts';
import type { Notification } from '../src/lib/notifications/api.ts';

const { mountWindowDialog, syncWindowBadge } = await import('../src/components/shell/notifications/WindowDialog.ts');
import { readFileSync } from 'node:fs';
const { CollapseMemory, linkPresentation } = await import('../src/lib/notifications/activityLinks.ts');
const { renderNotificationCard } = await import('../src/components/shell/notifications/NotificationCard.ts');
const { DialogController } = await import('../src/lib/notifications/dialogs.ts');

const doc = dom.document as unknown as Document;
let seq = 0;
const item = (over: Partial<Notification> = {}): Notification => ({
  id: `ntf_00000000pnl${String(++seq).padStart(6, '0')}`, type: 'dialogue', title: 'Overwrite?', text: '',
  priority: 'medium', visibility: 'private', pinned: false, popup: false, blocking: false, scope: 'auto',
  caller: { kind: 'instance', appId: 'com.example.notes', instanceId: 'com.example.notes-1', verification: 'verified' },
  sender: { kind: 'app', id: 'com.example.notes', attribution: 'verified' },
  senderKey: 'app:com.example.notes', state: 'active', createdAt: 1, updatedAt: 1, history: [],
  context: { kind: 'activity', id: 'com.example.notes-1#a1' },
  ...over,
} as Notification);
const actions = {
  resolve: async () => ({ ok: true as const }), dismiss: async () => ({ ok: true as const }),
  interact: async () => ({ ok: true as const }), forceRemove: async () => ({ ok: true as const }),
};

function makeSlot(): HTMLElement {
  const slot = doc.createElement('div');
  slot.className = 'app-slot';
  slot.dataset['viewId'] = 'v1';
  slot.innerHTML = '<div class="slot-chrome"></div><div class="slot-body"><iframe></iframe></div>';
  doc.body.appendChild(slot);
  return slot;
}
const panel = (slot: HTMLElement) => slot.querySelector<HTMLElement>('section.aura-dlg')!;
const toggle = (slot: HTMLElement) => panel(slot).querySelector<HTMLButtonElement>('.aura-dlg-toggle')!;
const isCollapsed = (slot: HTMLElement) => panel(slot).dataset['collapsed'] === 'true';
const click = (el: Element) => {
  el.dispatchEvent(new dom.PointerEvent('pointerdown', { bubbles: true }) as unknown as Event);
  el.dispatchEvent(new dom.MouseEvent('click', { bubbles: true }) as unknown as Event);
};

test('one click on the chevron collapses (aria-expanded follows); the slot bring-to-front pointerdown does not steal it', async () => {
  resetDom();
  const slot = makeSlot();
  let fronted = 0;
  slot.addEventListener('pointerdown', () => { fronted++; slot.style.zIndex = '99'; });   // like bringToFrontStack
  let slotClicks = 0;
  slot.addEventListener('click', () => { slotClicks++; });
  const changes: boolean[] = [];
  mountWindowDialog(slot, item(), { actions, blocking: false, takeFocus: false, onLater: () => {}, onCollapseChange: (c) => changes.push(c) });
  click(toggle(slot));
  assert.equal(isCollapsed(slot), true);
  assert.equal(toggle(slot).getAttribute('aria-expanded'), 'false');
  assert.equal(fronted, 1, 'z-order still updates');
  assert.equal(slotClicks, 0, 'the chevron owns its click');
  assert.deepEqual(changes, [true], 'the controller is told');
});

test('rapid double click: two flips, state and aria stay consistent; clicking the collapsed bar expands', () => {
  resetDom();
  const slot = makeSlot();
  mountWindowDialog(slot, item(), { actions, blocking: false, takeFocus: false, onLater: () => {} });
  click(toggle(slot)); click(toggle(slot));
  assert.equal(isCollapsed(slot), false);
  assert.equal(toggle(slot).getAttribute('aria-expanded'), 'true');
  click(toggle(slot));
  assert.equal(isCollapsed(slot), true);
  const bar = panel(slot).querySelector<HTMLElement>('.aura-dlg-bar')!;
  bar.dispatchEvent(new dom.MouseEvent('click', { bubbles: true }) as unknown as Event);
  assert.equal(isCollapsed(slot), false, 'the bar expands it');
});

test('collapse, then a store update (patch) or an entrance animation still running: it stays collapsed', async () => {
  resetDom();
  const slot = makeSlot();
  const n = item();
  const m = mountWindowDialog(slot, n, { actions, blocking: false, takeFocus: false, onLater: () => {} })!;
  click(toggle(slot));            // during the 150 ms entrance animation
  m.update({ ...n, title: 'Overwrite now?', updatedAt: 2 });
  m.update({ ...n, title: 'Overwrite now?', updatedAt: 3, seenAt: 3 });
  await flush();
  assert.equal(isCollapsed(slot), true);
});

// Controller level: the collapsed state is view state that survives re-mounts and reloads.
type Mounted = { id: string; collapsed: boolean; disposed: boolean; onCollapse?: (c: boolean) => void };
function fakeHost(memory: InstanceType<typeof CollapseMemory>, state: { view: 'visible' | 'minimized' }) {
  const mounted: Mounted[] = [];
  const host = {
    viewDetail: () => ({ state: state.view, viewId: 'v1', appId: 'com.example.notes', instanceId: 'com.example.notes-1', activityId: 'com.example.notes-1#a1' }),
    reveal: async () => {}, phone: () => false, locked: () => false, focusInWindowOrNowhere: () => true,
    collapseMemory: memory,
    mount: (n: Notification, _p: unknown, o: { collapsed?: boolean; onCollapseChange?: (c: boolean) => void }) => {
      const rec: Mounted = { id: n.id, collapsed: !!o.collapsed, disposed: false, ...(o.onCollapseChange ? { onCollapse: o.onCollapseChange } : {}) };
      mounted.push(rec);
      return { update() {}, focus() {}, dispose() { rec.disposed = true; }, setCollapsed(c: boolean) { rec.collapsed = c; } };
    },
    setMarkers: () => {},
  };
  return { host, mounted, live: (id: string) => mounted.filter((m) => m.id === id && !m.disposed) };
}
const snap = (items: Notification[]) => ({ items, unseenCount: 0, totalCount: items.length, highestUnseenPriority: null, newestUnseen: null, mostImportant: null, ready: true, error: null }) as never;

test('controller: expanded / collapsed survives minimize → restore and a reload (per-tab memory)', async () => {
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } };
  const state = { view: 'visible' as 'visible' | 'minimized' };
  const n = item();
  const f = fakeHost(new CollapseMemory(storage), state);
  const c = new DialogController(f.host as never);
  c.onStore(snap([n]), [{ kind: 'added', id: n.id, source: 'live' }]);
  assert.equal(f.live(n.id)[0]!.collapsed, true, 'docks as the bar');
  await c.answer(n.id);                              // the user expands it
  assert.equal(f.live(n.id)[0]!.collapsed, false);
  f.live(n.id)[0]!.onCollapse?.(true);               // …and collapses it with the chevron
  state.view = 'minimized'; c.onViewsChanged();
  state.view = 'visible'; c.onViewsChanged();
  assert.equal(f.live(n.id)[0]!.collapsed, true, 'stays collapsed after minimize / restore');
  await c.answer(n.id);
  // "Reload": a new controller + memory on the same per-tab storage.
  const f2 = fakeHost(new CollapseMemory(storage), state);
  const c2 = new DialogController(f2.host as never);
  c2.onStore(snap([n]), []);
  assert.equal(f2.live(n.id)[0]!.collapsed, false, 'the expanded state survives a reload');
  // Handled → the memory is cleared.
  c2.onStore(snap([]), [{ kind: 'removed', id: n.id, source: 'live', reason: 'resolved' }]);
  assert.equal(store.size, 0);
});

test('window badge: yellow (warning) — and its CSS outranks the chrome button style that painted it black', () => {
  resetDom();
  const slot = doc.createElement('div');
  slot.className = 'app-slot';
  slot.innerHTML = '<div class="slot-chrome"><div class="slot-controls"><button data-action="close">x</button></div></div><div class="slot-body"></div>';
  doc.body.appendChild(slot);
  let clicks = 0;
  const b = syncWindowBadge(slot, 2, { unseen: true, hint: '2 notifications for this window', onClick: () => clicks++ })!;
  assert.equal(b.className, 'aura-ntf-win-badge');
  assert.equal(b.dataset['tone'], 'warning');
  assert.equal(b.dataset['unseen'], 'true');
  assert.equal(b.dataset['pulse'], 'true', 'pulses once on arrival');
  assert.equal(b.getAttribute('aria-label'), '2 notifications for this window');
  assert.equal(slot.dataset['ntfLinked'], '2');
  assert.equal(slot.querySelector('.slot-controls')!.firstElementChild, b, 'first in the controls');
  b.click();
  assert.equal(clicks, 1);
  syncWindowBadge(slot, 0);
  assert.equal(slot.querySelector('.aura-ntf-win-badge'), null);
  assert.equal(slot.dataset['ntfLinked'], undefined);
  const css = readFileSync(new URL('../src/components/shell/notifications/NotificationStyles.astro', import.meta.url), 'utf8');
  const rule = /\.app-slot \.slot-controls > button\.aura-ntf-win-badge,\s*\.aura-ntf-win-badge \{([^}]*)\}/.exec(css);
  assert.ok(rule, 'a selector stronger than `.app-slot .slot-controls button`');
  assert.match(rule![1]!, /background: var\(--aura-color-warning\)/);
});

test('global surfaces: linked → yellow accent + "Go to activity · <app · window>"; unlinked → "Go to task"; redacted → no window name', () => {
  resetDom();
  const visible = { state: 'visible' as const, viewId: 'v1', appId: 'com.example.notes', instanceId: 'com.example.notes-1', activityId: 'com.example.notes-1#a1' };
  const host = { auraViewDetail: (_i: string, a?: string) => (a === 'com.example.notes-1#a1' ? visible : null) };
  const appLookup = (id: string) => (id === 'com.example.notes' ? { name: 'Notepad', glyph: 'N' } : undefined);
  const linked = item({ type: 'simple', context: { kind: 'activity', id: 'com.example.notes-1#a1', label: 'Window 2' } });
  const card = renderNotificationCard(linked, { mode: 'list', actions, host, appLookup } as never);
  assert.equal(card.dataset['linked'], 'true', 'yellow accent');
  const go = card.querySelector<HTMLButtonElement>('.aura-ntf-goto-activity')!;
  assert.ok(go, 'the Go-to button is the yellow element');
  assert.equal(go.textContent, 'Go to activity', 'compact: the label only');
  assert.equal(go.title, 'Go to activity · Notepad · Window 2', 'app · window in the tooltip');
  assert.ok(go.classList.contains('aura-ntf-link-btn'), 'same size class as Answer');
  assert.match(go.getAttribute('aria-label')!, /linked to that window/);
  for (const mode of ['toast'] as const) {
    const t = renderNotificationCard(linked, { mode, actions, host, appLookup } as never);
    assert.ok(t.querySelector('.aura-ntf-goto-activity'), 'pop-ups too');
  }
  // Unlinked: another app's window, a task context, a missing window.
  for (const ctx of [{ kind: 'task', id: 't1' }, { kind: 'activity', id: 'gone#a1' }]) {
    const c = renderNotificationCard(item({ type: 'simple', context: ctx as Notification['context'] }), { mode: 'list', actions, host, appLookup } as never);
    assert.equal(c.dataset['linked'], undefined);
    assert.equal(c.querySelector('.aura-ntf-goto-activity'), null);
  }
  const foreign = renderNotificationCard(item({ type: 'simple', sender: { kind: 'app', id: 'com.evil', attribution: 'verified' }, context: linked.context }), { mode: 'list', actions, host, appLookup } as never);
  assert.equal(foreign.dataset['linked'], undefined, 'never for another app\'s window');
  const task = renderNotificationCard(item({ type: 'simple', context: { kind: 'activity', id: 'gone#a1' } }), { mode: 'list', actions, host, appLookup } as never);
  assert.match(task.textContent ?? '', /Go to task/, 'a missing window keeps Go to task');
  // Lock-screen views: never the window name; redacted (private) → nothing.
  assert.equal(linkPresentation({ ...linked, lockscreen: true } as never, visible, 'Notepad')!.detail, null);
  assert.equal(linkPresentation({ ...linked, lockscreen: true, redacted: true } as never, visible, 'Notepad'), null);
  assert.equal(linkPresentation(linked, null, 'Notepad'), null);
});
