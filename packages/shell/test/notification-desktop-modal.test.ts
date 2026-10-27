// App desktop modals (phase 6): placement, the controller's force-hide /
// suppression / server-side release, and the DOM of the modal (identity bar,
// Force hide link + confirm, the protected shortcut). AuraOS decisions keep
// their behaviour (no force-hide).
//
//   cd packages/shell && npx tsx --test test/notification-desktop-modal.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dom, flush, resetDom } from './dom.ts';
import {
  DialogController, FORCE_HIDE_SUPPRESS_MS, canPutOff, decidePlacement, isAppDesktopModal, isCentredDesktop, isForceHideShortcut,
  type DialogHost, type MountedDialog, type Placement, type ViewDetail,
} from '../src/lib/notifications/dialogs.ts';
import type { Notification } from '../src/lib/notifications/api.ts';
import type { StoreChange, StoreSnapshot } from '../src/lib/notifications/store.ts';

const { mountDesktopDecision } = await import('../src/components/shell/notifications/DesktopDecision.ts');
const doc = dom.document as unknown as Document;

const APP = { kind: 'app', id: 'com.example.notes', name: 'Notes', attribution: 'verified' } as const;
const AURAOS = { kind: 'auraos', id: 'auraos', attribution: 'internal' } as const;
let seq = 0;
const ntf = (p: Partial<Notification> = {}): Notification => ({
  id: `ntf_00000000dsk${String(++seq).padStart(6, '0')}`, type: 'dialogue', title: 'Approve deploy?', text: '', priority: 'high', visibility: 'private',
  pinned: false, popup: false, blocking: true, scope: 'desktop',
  caller: { kind: 'instance', appId: 'com.example.notes', instanceId: 'com.example.notes-1', verification: 'verified' },
  sender: APP, senderKey: 'app:com.example.notes', state: 'active', createdAt: 1, updatedAt: 1, history: [], ...p,
} as Notification);

test('placement: an app modal always opens at once (popup irrelevant); suppressed → only when the user opens it; AuraOS stays desktop', () => {
  const auto = (n: Notification, suppressed = false) => decidePlacement(n, { intent: 'auto', view: null, phone: false, suppressed });
  const user = (n: Notification, suppressed = false) => decidePlacement(n, { intent: 'user', view: null, phone: false, suppressed });
  assert.equal(isAppDesktopModal(ntf()), true);
  assert.equal(isAppDesktopModal(ntf({ sender: AURAOS, senderKey: 'auraos' })), false);
  assert.equal(auto(ntf({ popup: true })).kind, 'appModal');
  assert.equal(auto(ntf({ popup: false })).kind, 'appModal', 'no waits-in-the-list mode');
  assert.equal(user(ntf()).kind, 'appModal');
  assert.equal(auto(ntf({ popup: true }), true).kind, 'none', 'suppressed after a force-hide');
  assert.equal(user(ntf(), true).kind, 'appModal', 'suppressed: only auto-open is held back; the user opening it gets the modal');
  assert.equal(auto(ntf({ sender: AURAOS, senderKey: 'auraos' })).kind, 'desktop');
  assert.equal(canPutOff({ kind: 'appModal' }), false);
  // Non-blocking desktop: a centred floating dialogue (no grant needed server-side).
  const c = ntf({ blocking: false });
  assert.equal(isCentredDesktop(c), true);
  assert.deepEqual(user(c), { kind: 'floating', layout: 'panel', centred: true });
  assert.deepEqual(auto(c), { kind: 'floating', layout: 'panel', centred: true }, 'it also opens at once');
  assert.equal(isForceHideShortcut({ key: 'Escape', ctrlKey: true, altKey: true, shiftKey: true, metaKey: false }), true);
  assert.equal(isForceHideShortcut({ key: 'Escape', ctrlKey: true, altKey: false, shiftKey: true, metaKey: false }), false);
});

class Host implements DialogHost {
  t = 1_000_000;
  mounted: Array<{ id: string; p: Placement; disposed: boolean; instant: boolean; forceHide?: () => Promise<boolean> }> = [];
  hidden: string[] = [];
  viewDetail(): ViewDetail | null { return null; }
  async reveal() {}
  phone() { return false; }
  locked() { return false; }
  focusInWindowOrNowhere() { return true; }
  now() { return this.t; }
  async forceHide(id: string) { this.hidden.push(id); return true; }
  mount(n: Notification, p: Placement, opts: { onForceHide?: () => Promise<boolean> }): MountedDialog {
    const rec = { id: n.id, p, disposed: false, instant: false, ...(opts.onForceHide ? { forceHide: opts.onForceHide } : {}) };
    this.mounted.push(rec);
    return { update() {}, focus() {}, dispose: (o) => { rec.disposed = true; rec.instant = !!o?.instant; } };
  }
  setMarkers() {}
  live(id?: string) { return this.mounted.filter((m) => !m.disposed && (!id || m.id === id)); }
}
const snap = (items: Notification[]) => ({ items, ready: true } as unknown as StoreSnapshot);
const added = (id: string): StoreChange => ({ kind: 'added', id, source: 'live' });
const updated = (id: string): StoreChange => ({ kind: 'updated', id } as StoreChange);

test('controller: force-hide releases the blocking at once, tells the server, suppresses the sender ~10 min (re-requests do not block)', async () => {
  const h = new Host();
  const c = new DialogController(h);
  const a = ntf({ popup: true });
  c.onStore(snap([a]), [added(a.id)]);
  const m = h.live(a.id)[0]!;
  assert.equal(m.p.kind, 'appModal');
  assert.ok(m.forceHide, 'the modal gets a force-hide hook');
  assert.equal(await m.forceHide!(), true);
  assert.equal(m.disposed, true);
  assert.deepEqual(h.hidden, [a.id], 'server release requested (reason force-hidden)');
  // The app re-requests in a loop: suppressed in this tab.
  for (let i = 0; i < 3; i++) {
    const again = ntf({ popup: true });
    c.onStore(snap([again]), [added(again.id)]);
    assert.equal(h.live(again.id).length, 0, `re-request ${i + 1} does not block`);
  }
  // The user can still open one on purpose.
  const b = ntf();
  c.onStore(snap([b]), [added(b.id)]);
  await c.answer(b.id);
  assert.equal(h.live(b.id)[0]!.p.kind, 'appModal');
  // Another sender is not suppressed.
  const other = ntf({ popup: true, senderKey: 'app:com.example.other', sender: { kind: 'app', id: 'com.example.other', attribution: 'verified' } as never });
  c.onStore(snap([other]), [added(other.id)]);
  assert.equal(h.live(other.id)[0]!.p.kind, 'appModal');
  // After the suppression window the sender may block again.
  h.t += FORCE_HIDE_SUPPRESS_MS + 1;
  const later = ntf({ popup: true });
  c.onStore(snap([later]), [added(later.id)]);
  assert.equal(h.live(later.id)[0]!.p.kind, 'appModal');
});

test('controller: a server-side release (revoke / admin / another tab) stops the blocking immediately; the item stays in the list', () => {
  const h = new Host();
  const c = new DialogController(h);
  const a = ntf({ popup: true });
  c.onStore(snap([a]), [added(a.id)]);
  assert.equal(h.live(a.id).length, 1);
  const released = { ...a, scope: 'auto', blocking: false, popup: false, updatedAt: 2 } as Notification;
  c.onStore(snap([released]), [updated(a.id)]);
  assert.equal(h.live(a.id).length, 0);
  assert.equal(h.mounted[0]!.instant, true, 'instant — no blocking exit animation');
  assert.equal(c.isOpen(a.id), false);
});

// ── DOM ─────────────────────────────────────────────────────────────────────

const actions = {
  resolve: async () => ({ ok: true as const }), dismiss: async () => ({ ok: true as const }),
  interact: async () => ({ ok: true as const }), forceRemove: async () => ({ ok: true as const }),
};
const key = (el: EventTarget, init: Record<string, unknown>) =>
  el.dispatchEvent(new dom.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init } as never) as unknown as Event);

test('DOM: app modal shows "Requested by <App>" (verified / unverified), Force hide → confirm → onForceHide; blocks the rest', async () => {
  resetDom('<nav id="dock"><button id="outside">x</button></nav>');
  let hides = 0;
  const m = mountDesktopDecision(ntf(), { actions, appLookup: (id) => (id === 'com.example.notes' ? { name: 'Notes', icon: 'NT' } : undefined) as never, appModal: { onForceHide: async () => { hides++; return true; } } });
  const overlay = doc.querySelector<HTMLElement>('.aura-dlg-desktop')!;
  assert.equal(overlay.dataset['kind'], 'app');
  assert.ok(overlay.querySelector('.aura-dlg-appmodal') && !overlay.querySelector('.aura-dlg-decision'), 'not the AuraOS look');
  const bar = overlay.querySelector<HTMLElement>('.aura-dlg-appbar')!;
  assert.match(bar.textContent!, /Requested by\s*Notes/);
  assert.equal(bar.querySelector<HTMLElement>('.aura-dlg-appbar-att')!.dataset['verified'], 'true');
  assert.equal((doc.getElementById('dock') as HTMLElement).inert, true, 'the rest of the shell is inert');
  const link = bar.querySelector<HTMLButtonElement>('.aura-dlg-forcehide')!;
  assert.equal(link.getAttribute('aria-keyshortcuts'), 'Control+Alt+Shift+Escape');
  link.click();
  assert.match(overlay.textContent!, /Hide this dialogue from Notes\? The app will be told/);
  const yes = [...overlay.querySelectorAll<HTMLButtonElement>('.aura-dlg-forcehide-confirm button')].find((b) => b.textContent === 'Hide')!;
  yes.click();
  await flush();
  assert.equal(hides, 1);
  m.dispose();
  assert.equal((doc.getElementById('dock') as HTMLElement).inert, false, 'released');
});

test('DOM: the protected shortcut Ctrl+Alt+Shift+Esc opens the force-hide confirm (capture phase, before anything else)', () => {
  resetDom();
  let reached = 0;
  dom.addEventListener('keydown', () => { reached++; });
  const m = mountDesktopDecision(ntf({ sender: { kind: 'app', id: 'com.x', attribution: 'unverified' } as never }), { actions, appModal: { onForceHide: async () => true } });
  const overlay = doc.querySelector<HTMLElement>('.aura-dlg-desktop')!;
  assert.equal(overlay.querySelector<HTMLElement>('.aura-dlg-appbar-att')!.dataset['verified'], 'false', 'unverified attribution shown');
  key(doc.body, { key: 'Escape', ctrlKey: true, altKey: true, shiftKey: true });
  assert.ok(overlay.querySelector('.aura-dlg-forcehide-confirm'), 'confirm shown');
  assert.equal(reached, 0, 'nobody else saw the shortcut');
  m.dispose();
});

test('DOM: an AuraOS decision keeps its look — no identity bar, no Force hide, the shortcut does nothing', () => {
  resetDom();
  const m = mountDesktopDecision(ntf({ sender: AURAOS as never, senderKey: 'auraos' }), { actions });
  const overlay = doc.querySelector<HTMLElement>('.aura-dlg-desktop')!;
  assert.equal(overlay.dataset['kind'], 'auraos');
  assert.ok(overlay.querySelector('.aura-dlg-decision'));
  assert.equal(overlay.querySelector('.aura-dlg-forcehide'), null);
  key(doc.body, { key: 'Escape', ctrlKey: true, altKey: true, shiftKey: true });
  assert.equal(overlay.querySelector('.aura-dlg-forcehide-confirm'), null);
  m.dispose();
});
