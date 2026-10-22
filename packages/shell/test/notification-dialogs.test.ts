// Dialogue placement + controller (phase 4). DOM-free — fake host.
//
//   cd packages/shell && npx tsx --test test/notification-dialogs.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DialogController, decidePlacement, isComplex, ownsWindow, isDesktopDecision,
  CARD_CONTROL_SELECTOR, opensDialogOnActivate, workspaceNavMarkers, workspaceMarkerHint, canPutOff, CLOSE_LATER,
  type DialogHost, type MountedDialog, type Placement, type ViewDetail,
} from '../src/lib/notifications/dialogs.ts';
import type { Notification } from '../src/lib/notifications/api.ts';
import { ExitMachine, EXIT_FALLBACK_MS } from '../src/lib/notifications/exit.ts';
import type { StoreChange, StoreSnapshot } from '../src/lib/notifications/store.ts';

let seq = 0;
const APP = { kind: 'app', id: 'com.example.notes', attribution: 'verified' } as const;
const AGENT = { kind: 'agent', id: 'com.aura.aurashelld', attribution: 'verified' } as const;
const AURAOS = { kind: 'auraos', id: 'auraos', attribution: 'internal' } as const;
const ACT = { kind: 'activity', id: 'com.example.notes-1#a1' } as const;

function ntf(p: Partial<Notification> & { id: string }): Notification {
  return {
    type: 'dialogue', title: p.id, text: '', priority: 'medium', visibility: 'private', pinned: false, popup: false,
    blocking: false, scope: 'auto',
    caller: { kind: 'anonymous', verification: 'unverified' }, sender: APP,
    senderKey: 'app:com.example.notes', state: 'active', createdAt: 1000 + (seq++), updatedAt: 1000, history: [],
    ...p,
  } as Notification;
}
const view = (state: ViewDetail['state'], over: Partial<ViewDetail> = {}): ViewDetail => ({
  state, viewId: 'v1', appId: 'com.example.notes', instanceId: 'com.example.notes-1', activityId: 'com.example.notes-1#a1', workspaceId: 'ws2', ...over,
});

test('decidePlacement: the rules table', () => {
  const auto = (n: Notification, v: ViewDetail | null, phone = false) => decidePlacement(n, { intent: 'auto', view: v, phone });
  const user = (n: Notification, v: ViewDetail | null, phone = false) => decidePlacement(n, { intent: 'user', view: v, phone });
  // Asking is not interrupting: without popup nothing opens on its own.
  assert.equal(auto(ntf({ id: 'a', context: ACT }), view('visible')).kind, 'none');
  // Desktop decision (AuraOS only).
  assert.equal(auto(ntf({ id: 'd', scope: 'desktop', sender: AURAOS }), null).kind, 'desktop');
  assert.notEqual(auto(ntf({ id: 'd2', scope: 'desktop', sender: APP, popup: true }), null).kind, 'desktop', 'a forged scope from an app is not a desktop decision');
  // Own visible window: overlay (Answer or popup); blocking carried.
  assert.deepEqual(user(ntf({ id: 'w', context: ACT }), view('visible')), { kind: 'window', viewId: 'v1', blocking: false, layout: 'panel' });
  assert.deepEqual(auto(ntf({ id: 'w2', context: ACT, popup: true, blocking: true }), view('visible')), { kind: 'window', viewId: 'v1', blocking: true, layout: 'panel' });
  // Hidden own window + popup: wait (never fetched); Answer → wait too (the controller reveals).
  assert.deepEqual(auto(ntf({ id: 'm', context: ACT, popup: true }), view('minimized')), { kind: 'wait', viewId: 'v1', reason: 'minimized', workspaceId: 'ws2' });
  assert.equal(auto(ntf({ id: 'o', context: ACT, popup: true }), view('other-workspace')).kind, 'wait');
  // No window (agent / background) → floating.
  assert.deepEqual(user(ntf({ id: 'f', sender: AGENT }), null), { kind: 'floating', layout: 'panel' });
  assert.equal(auto(ntf({ id: 'f2', sender: AGENT, popup: true }), null).kind, 'floating');
  // Never over a window the sender does not own.
  assert.deepEqual(user(ntf({ id: 'x', context: ACT, sender: { kind: 'app', id: 'com.evil', attribution: 'verified' } }), view('visible')), { kind: 'floating', layout: 'panel' });
  assert.equal(user(ntf({ id: 'x2', context: ACT, sender: { kind: 'app', id: 'com.example.notes', attribution: 'unverified' } }), view('visible')).kind, 'floating');
  // Phone: sheet / full view; blocking keeps the window covered.
  assert.deepEqual(user(ntf({ id: 'p', context: ACT, blocking: true }), view('visible'), true), { kind: 'floating', layout: 'sheet', blockViewId: 'v1' });
  const complex = ntf({ id: 'c', components: [{ kind: 'input', id: 'a', multiline: true }] as Notification['components'] });
  assert.deepEqual(user(complex, null, true), { kind: 'floating', layout: 'full' });
  // Not active / not a dialogue.
  assert.equal(user(ntf({ id: 's', type: 'simple' }), null).kind, 'none');
  assert.equal(user(ntf({ id: 'r', state: 'resolved' }), null).kind, 'none');
});

test('isComplex / ownsWindow / isDesktopDecision', () => {
  const inputs = (k: number) => Array.from({ length: k }, (_, i) => ({ kind: 'input', id: `i${i}` })) as Notification['components'];
  assert.equal(isComplex({ components: inputs(3) }), false);
  assert.equal(isComplex({ components: inputs(4) }), true);
  assert.equal(ownsWindow({ sender: AURAOS } as Notification, { appId: 'anything' }), true);
  assert.equal(ownsWindow({ sender: AGENT } as Notification, { appId: 'com.aura.aurashelld' }), false, 'agents have no window');
  assert.equal(isDesktopDecision(ntf({ id: 'q', scope: 'desktop', sender: { kind: 'auraos', id: 'auraos', attribution: 'unverified' as never } })), false);
});

// ---------------------------------------------------------------------------

class FakeHost implements DialogHost {
  views = new Map<string, ViewDetail>();
  isPhone = false;
  isLocked = false;
  focusOk = true;
  mounted: Array<{ id: string; p: Placement; takeFocus: boolean; disposed: boolean; later: () => void; updates: number; focused: number; collapsed: boolean; instant?: boolean }> = [];
  revealed: string[] = [];
  markers: { view: Map<string, number>; ws: Map<string, number> } = { view: new Map(), ws: new Map() };
  viewDetail(ctx: { instanceId: string; activityId?: string }) { return this.views.get(ctx.activityId ?? ctx.instanceId) ?? null; }
  async reveal(ctx: { instanceId: string; activityId?: string }) {
    const k = ctx.activityId ?? ctx.instanceId;
    this.revealed.push(k);
    const v = this.views.get(k);
    if (v) this.views.set(k, { ...v, state: 'visible' });
  }
  phone() { return this.isPhone; }
  locked() { return this.isLocked; }
  focusInWindowOrNowhere() { return this.focusOk; }
  mount(n: Notification, p: Placement, opts: { takeFocus: boolean; onLater: () => void; collapsed?: boolean }): MountedDialog {
    const rec: FakeHost['mounted'][number] = { id: n.id, p, takeFocus: opts.takeFocus, disposed: false, later: opts.onLater, updates: 0, focused: 0, collapsed: !!opts.collapsed };
    this.mounted.push(rec);
    return {
      update: () => { rec.updates++; }, focus: () => { rec.focused++; },
      dispose: (o) => { rec.disposed = true; rec.instant = !!o?.instant; },
      setCollapsed: (c) => { rec.collapsed = c; },
    };
  }
  setMarkers(v: ReadonlyMap<string, number>, w: ReadonlyMap<string, number>) { this.markers = { view: new Map(v), ws: new Map(w) }; }
  live(id: string) { return this.mounted.filter((m) => m.id === id && !m.disposed); }
}

function snap(items: Notification[]): StoreSnapshot {
  return { items, unseenCount: 0, totalCount: items.length, highestUnseenPriority: null, newestUnseen: null, mostImportant: null, ready: true, error: null } as StoreSnapshot;
}
const added = (id: string, source: StoreChange['source'] = 'live'): StoreChange => ({ kind: 'added', id, source });

test('controller: forced pop-up over the visible own window, without focus; blocking takes focus only from its window', () => {
  const h = new FakeHost();
  h.views.set(ACT.id, view('visible'));
  const c = new DialogController(h);
  const pop = ntf({ id: 'p1', context: ACT, popup: true });
  c.onStore(snap([pop]), [added('p1')]);
  assert.equal(h.live('p1').length, 1);
  assert.equal(h.live('p1')[0]!.p.kind, 'window');
  assert.equal(h.live('p1')[0]!.takeFocus, false, 'forced pop-ups never take focus');
  // A blocking forced one: focus moves only if focus was in that window (or nowhere).
  h.focusOk = false;
  const b = ntf({ id: 'b1', context: ACT, popup: true, blocking: true });
  c.onStore(snap([pop, b]), [added('b1')]);
  assert.equal(h.live('b1')[0]!.takeFocus, false);
  // Non-popup: nothing opens — an activity-linked item only docks as the compact
  // (collapsed) yellow bar in its window; initial (reload) arrivals never pop.
  const q = ntf({ id: 'q1', context: ACT });
  const old = ntf({ id: 'o1', context: ACT, popup: true });
  c.onStore(snap([pop, b, q, old]), [added('q1'), added('o1', 'initial')]);
  assert.equal(h.live('q1').length, 1);
  assert.equal(h.live('q1')[0]!.collapsed, true, 'docked bar, not opened');
  assert.equal(h.live('q1')[0]!.takeFocus, false);
  assert.equal(h.live('o1')[0]!.collapsed, true, 'a reload re-docks, never re-pops');
});

test('controller: hidden window → wait + marker (never fetched); restore re-attaches; Answer reveals', async () => {
  const h = new FakeHost();
  h.views.set(ACT.id, view('minimized'));
  const c = new DialogController(h);
  const pop = ntf({ id: 'p1', context: ACT, popup: true });
  c.onStore(snap([pop]), [added('p1')]);
  assert.equal(h.live('p1').length, 0, 'not opened');
  assert.equal(h.revealed.length, 0, 'the window is not fetched');
  assert.equal(h.markers.view.get('v1'), 1, 'strip chip marker');
  assert.equal(c.isWaiting('p1'), true);
  // The user restores the window → it opens over it.
  h.views.set(ACT.id, view('visible'));
  c.onViewsChanged();
  assert.equal(h.live('p1').length, 1);
  assert.equal(h.markers.view.get('v1'), 1, 'the title-bar badge stays while the item is active');
  // Minimize again (slot destroyed) → detached, waits; restore → re-attached.
  h.views.set(ACT.id, view('minimized'));
  c.onViewsChanged();
  assert.equal(h.live('p1').length, 0);
  assert.equal(h.markers.view.get('v1'), 1);
  h.views.set(ACT.id, view('visible'));
  c.onViewsChanged();
  assert.equal(h.live('p1').length, 1);

  // Other workspace: pill marker; Answer reveals, then the overlay (with focus).
  const q = ntf({ id: 'q1', context: { kind: 'activity', id: 'other#a1' } });
  h.views.set('other#a1', view('other-workspace', { viewId: 'v2', activityId: 'other#a1', workspaceId: 'ws3' }));
  c.onStore(snap([pop, q]), [added('q1')]);
  assert.equal(h.markers.ws.get('ws3'), 1, 'an activity-linked item marks its workspace');
  assert.equal(await c.answer('q1'), true);
  assert.deepEqual(h.revealed, ['other#a1']);
  assert.equal(h.live('q1').length, 1);
  assert.equal(h.live('q1')[0]!.p.kind, 'window');
  assert.equal(h.live('q1')[0]!.takeFocus, true, 'user-opened dialogues take focus');
  // Answer again focuses the open one.
  await c.answer('q1');
  assert.equal(h.live('q1')[0]!.focused, 1);
});

test('controller: pill marker for a forced dialogue on another workspace; window closed → list only', () => {
  const h = new FakeHost();
  h.views.set(ACT.id, view('other-workspace'));
  const c = new DialogController(h);
  c.onStore(snap([ntf({ id: 'p', context: ACT, popup: true })]), [added('p')]);
  assert.equal(h.markers.ws.get('ws2'), 1);
  h.views.delete(ACT.id);
  c.onViewsChanged();
  assert.equal(c.isWaiting('p'), false);
  assert.equal(h.markers.ws.size, 0);
});

test('controller: Later keeps it in the list; blocking and desktop cannot be put off; resolve / remove close', () => {
  const h = new FakeHost();
  h.views.set(ACT.id, view('visible'));
  const c = new DialogController(h);
  const a = ntf({ id: 'a', sender: AGENT, popup: true });
  const b = ntf({ id: 'b', context: ACT, popup: true, blocking: true });
  const d = ntf({ id: 'd', sender: AURAOS, scope: 'desktop' });
  c.onStore(snap([a, b, d]), [added('a'), added('b'), added('d')]);
  assert.equal(h.live('a')[0]!.p.kind, 'floating');
  assert.equal(h.live('d')[0]!.p.kind, 'desktop');
  assert.equal(h.live('d')[0]!.takeFocus, true);
  h.live('a')[0]!.later();
  h.live('b')[0]!.later();
  h.live('d')[0]!.later();
  assert.equal(h.live('a').length, 0, 'Later hides it');
  assert.equal(h.live('b').length, 1, 'blocking has no Later');
  assert.equal(h.live('d').length, 1, 'desktop decisions only close by being resolved');
  // An update does not re-open a put-off one; an update to an open one re-renders.
  c.onStore(snap([{ ...a, title: 'x' }, { ...b, title: 'y' }, d]), [{ kind: 'updated', id: 'a', source: 'live' }, { kind: 'updated', id: 'b', source: 'live' }]);
  assert.equal(h.live('a').length, 0);
  assert.equal(h.live('b')[0]!.updates, 1);
  // Resolved / removed → closed (inert is released by the mount's dispose).
  c.onStore(snap([d]), [{ kind: 'removed', id: 'b', source: 'live', reason: 'resolved' }]);
  assert.equal(h.live('b').length, 0);
  c.onStore(snap([]), []);
  assert.equal(h.live('d').length, 0, 'missing from the snapshot → closed');
});

test('controller: lock screen hides everything; desktop decisions wait for the unlock; reload re-shows a pending decision', () => {
  const h = new FakeHost();
  h.views.set(ACT.id, view('visible'));
  const c = new DialogController(h);
  const w = ntf({ id: 'w', context: ACT, popup: true });
  c.onStore(snap([w]), [added('w')]);
  c.onLock(true);
  h.isLocked = true;
  assert.equal(h.live('w').length, 0);
  const d = ntf({ id: 'd', sender: AURAOS, scope: 'desktop' });
  c.onStore(snap([w, d]), [added('d')]);
  assert.equal(h.live('d').length, 0, 'waits while locked');
  h.isLocked = false;
  c.onLock(false);
  assert.equal(h.live('w').length, 1);
  assert.equal(h.live('d').length, 1);

  // A fresh controller on an already-loaded store (hot reload / page load).
  const h2 = new FakeHost();
  const c2 = new DialogController(h2);
  c2.onStore(snap([d, w]), []);
  assert.equal(h2.live('d').length, 1);
  assert.equal(h2.live('w').length, 0, 'forced pop-ups do not re-pop after a reload');
  c2.dispose();
  assert.equal(h2.live('d').length, 0);
});

test('controller: phone sheet; desktop ↔ phone switch re-places an open window dialogue', () => {
  const h = new FakeHost();
  h.views.set(ACT.id, view('visible'));
  const c = new DialogController(h);
  const b = ntf({ id: 'b', context: ACT, popup: true, blocking: true });
  c.onStore(snap([b]), [added('b')]);
  assert.equal(h.live('b')[0]!.p.kind, 'window');
  h.isPhone = true;
  c.onViewsChanged();
  assert.deepEqual(h.live('b').map((m) => m.p), [{ kind: 'floating', layout: 'sheet', blockViewId: 'v1' }]);
  assert.equal(c.autoPlacement(ntf({ id: 'z', sender: AGENT, popup: true })), 'floating');
});

test('card activation: only active Dialogue cards open on click / Enter; their own controls are excluded', () => {
  assert.equal(opensDialogOnActivate(ntf({ id: 'd' })), true);
  assert.equal(opensDialogOnActivate(ntf({ id: 's', type: 'simple' })), false);
  assert.equal(opensDialogOnActivate(ntf({ id: 'l', type: 'locked' })), false);
  assert.equal(opensDialogOnActivate(ntf({ id: 'r', state: 'resolved' })), false);
  for (const sel of ['button', 'a', 'input', 'textarea', 'label', 'fieldset', '[role="menu"]', '[data-own-escape]']) {
    assert.ok(CARD_CONTROL_SELECTOR.split(',').map((x) => x.trim()).includes(sel), sel);
  }
});

test('card activation uses the Answer path: a hidden own window is revealed, then the overlay opens with focus', async () => {
  const h = new FakeHost();
  h.views.set(ACT.id, view('minimized'));
  const c = new DialogController(h);
  c.onStore(snap([ntf({ id: 'q', context: ACT })]), [added('q')]);
  assert.equal(await c.answer('q'), true);
  assert.deepEqual(h.revealed, [ACT.id]);
  assert.equal(h.live('q')[0]!.p.kind, 'window');
  assert.equal(h.live('q')[0]!.takeFocus, true);
  h.isPhone = true;
  c.onStore(snap([ntf({ id: 'q' }), ntf({ id: 'f', sender: AGENT })]), [added('f')]);
  assert.equal(await c.answer('f'), true);
  assert.deepEqual(h.live('f')[0]!.p, { kind: 'floating', layout: 'sheet' });
});

test('workspace switcher markers: ‹ / › for marked workspaces outside the pill window, ▦ when folded', () => {
  const order = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6'];
  const marked = new Map([['w1', 1], ['w5', 2], ['w6', 1]]);
  assert.deepEqual(workspaceNavMarkers(order, ['w2', 'w3', 'w4'], marked, false), { prev: ['w1'], next: ['w5', 'w6'], trigger: [] });
  assert.deepEqual(workspaceNavMarkers(order, ['w1', 'w2', 'w3'], marked, false), { prev: [], next: ['w5', 'w6'], trigger: [] });
  assert.deepEqual(workspaceNavMarkers(order, order, marked, false), { prev: [], next: [], trigger: [] }, 'all pills visible: the pills carry it');
  assert.deepEqual(workspaceNavMarkers(order, ['w2'], marked, true), { prev: [], next: [], trigger: ['w1', 'w5', 'w6'] });
  assert.deepEqual(workspaceNavMarkers(order, [], new Map([['w3', 0]]), false), { prev: [], next: [], trigger: [] });
  assert.equal(workspaceMarkerHint(['w5'], order), 'Workspace 5 has a pending dialogue');
  assert.equal(workspaceMarkerHint(['w1', 'w5', 'w6'], order), 'Workspaces 1, 5 and 6 have pending dialogues');
});

test('header ✕ (answer later): only on dialogues that can be put off', () => {
  assert.equal(canPutOff({ kind: 'window', viewId: 'v', blocking: false, layout: 'panel' }), true);
  assert.equal(canPutOff({ kind: 'floating', layout: 'panel' }), true);
  assert.equal(canPutOff({ kind: 'floating', layout: 'sheet' }), true);
  assert.equal(canPutOff({ kind: 'floating', layout: 'full' }), true);
  assert.equal(canPutOff({ kind: 'window', viewId: 'v', blocking: true, layout: 'panel' }), false);
  assert.equal(canPutOff({ kind: 'floating', layout: 'sheet', blockViewId: 'v' }), false);
  assert.equal(canPutOff({ kind: 'desktop' }), false);
  assert.deepEqual(CLOSE_LATER, { label: 'Close (answer later)', title: 'Close — answer later' });
});

test('a Simple item with a form opens as a floating dialogue / sheet on the user\'s click only', async () => {
  const form = [{ kind: 'input', id: 'a' }] as Notification['components'];
  const simple = ntf({ id: 's', type: 'simple', components: form });
  assert.deepEqual(decidePlacement(simple, { intent: 'user', view: null, phone: false }), { kind: 'floating', layout: 'panel' });
  assert.deepEqual(decidePlacement(simple, { intent: 'user', view: null, phone: true }), { kind: 'floating', layout: 'sheet' });
  assert.equal(decidePlacement({ ...simple, popup: true }, { intent: 'auto', view: null, phone: false }).kind, 'none', 'never on its own');
  assert.equal(decidePlacement(ntf({ id: 'b', type: 'simple' }), { intent: 'user', view: null, phone: false }).kind, 'none', 'no form, no dialogue');
  const h = new FakeHost();
  const c = new DialogController(h);
  c.onStore(snap([simple]), [added('s')]);
  assert.equal(h.live('s').length, 0);
  assert.equal(await c.answer('s'), true);
  assert.equal(h.live('s')[0]!.p.kind, 'floating');
  assert.equal(h.live('s')[0]!.takeFocus, true, 'focus moves because the user clicked');
});

test('exit animation state machine: double hide ignored, reopen mid-exit cancels, instant (lock / wipe), fallback timeout', () => {
  const pending: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  const timers = { set: (fn: () => void, ms: number) => { const t = { fn, ms, live: true }; pending.push(t); return t; }, clear: (h: unknown) => { (h as { live: boolean }).live = false; } };
  const fire = () => { for (const t of pending.splice(0)) if (t.live) t.fn(); };
  let gone = 0;
  const m = new ExitMachine(timers);
  assert.equal(m.hide(() => gone++), true);
  assert.equal(m.state, 'exiting');
  assert.equal(m.hide(() => gone++), false, 'a second hide during the exit is ignored');
  m.end();
  assert.equal(m.state, 'gone');
  assert.equal(gone, 1);
  fire();
  assert.equal(gone, 1, 'onGone runs once');
  // Reopened mid-exit.
  const r = new ExitMachine(timers);
  r.hide(() => gone++);
  assert.equal(r.cancel(), true);
  assert.equal(r.state, 'open');
  fire();
  assert.equal(gone, 1, 'a cancelled exit never removes');
  // Lock / wipe: instant, also overtaking a running exit.
  const w = new ExitMachine(timers);
  w.hide(() => gone++, { instant: true });
  assert.equal(w.state, 'gone');
  assert.equal(gone, 2);
  const x = new ExitMachine(timers);
  x.hide(() => gone++);
  assert.equal(x.hide(() => gone++, { instant: true }), true);
  assert.equal(gone, 3);
  // animationend never comes: the fallback timeout finishes it.
  const y = new ExitMachine(timers);
  y.hide(() => gone++);
  assert.ok(pending.some((t) => t.live && t.ms === EXIT_FALLBACK_MS));
  fire();
  assert.equal(y.state, 'gone');
  assert.equal(gone, 4);
});

test('activity-linked: badge counts per window / workspace; Later collapses (not gone); re-dock after re-mount; removal only via store', async () => {
  const { linkCounts, badgeAction, badgeHint, stickyPopupView, isActivityLinked } = await import('../src/lib/notifications/activityLinks.ts');
  const h = new FakeHost();
  h.views.set(ACT.id, view('visible'));
  h.views.set('o#a1', view('other-workspace', { viewId: 'v2', activityId: 'o#a1', workspaceId: 'ws9' }));
  const lookup = (c: { instanceId: string; activityId?: string }) => h.viewDetail(c);
  const a = ntf({ id: 'a', context: ACT, type: 'simple' });
  const b = ntf({ id: 'b', context: ACT });
  const o = ntf({ id: 'o', context: { kind: 'activity', id: 'o#a1' } });
  const foreign = ntf({ id: 'f', context: ACT, sender: { kind: 'app', id: 'com.evil', attribution: 'verified' } });
  const agent = ntf({ id: 'g', sender: AGENT });
  const lc = linkCounts([a, b, o, foreign, agent, ntf({ id: 'r', context: ACT, state: 'resolved' })], lookup);
  assert.deepEqual([...lc.byView], [['v1', 2], ['v2', 1]], 'foreign senders / agents / ended items do not count');
  assert.deepEqual([...lc.byWorkspace], [['ws9', 1]]);
  assert.equal(badgeHint(2), '2 notifications for this window');
  assert.deepEqual(badgeAction(['a']), { kind: 'open', id: 'a' });
  assert.deepEqual(badgeAction(['a', 'b']), { kind: 'list', id: 'a' });
  // Sticky pop-up: popupDurationMs from the sender is ignored.
  assert.equal(isActivityLinked(a, lookup), true);
  assert.equal(stickyPopupView({ id: 'a', priority: 'low', popupDurationMs: 5000 }, true).popupDurationMs, 0);
  assert.equal(stickyPopupView({ id: 'x', priority: 'low', popupDurationMs: 5000 }, false).popupDurationMs, 5000);

  const c = new DialogController(h);
  c.onStore(snap([a, b, o]), [added('a'), added('b'), added('o')]);
  assert.equal(h.live('a')[0]!.collapsed, true, 'even a Simple item docks as a banner');
  assert.equal(h.live('b')[0]!.collapsed, true);
  assert.equal(h.live('o').length, 0, 'not visible: no bar (badge / pill only)');
  assert.deepEqual(c.linkedFor('v1'), ['a', 'b']);
  // Answer expands in place; Later collapses again — it never goes away.
  assert.equal(await c.answer('b'), true);
  assert.equal(h.live('b')[0]!.collapsed, false);
  h.live('b')[0]!.later();
  assert.equal(h.live('b').length, 1);
  assert.equal(h.live('b')[0]!.collapsed, true);
  // No timeout / seen / update makes it go: only store removal.
  c.onStore(snap([a, { ...b, seenAt: 5, updatedAt: 9 }, o]), [{ kind: 'updated', id: 'b', source: 'live' }]);
  assert.equal(h.live('b').length, 1);
  // Re-mount (minimize → restore): re-docked.
  h.views.set(ACT.id, view('minimized'));
  c.onViewsChanged();
  assert.equal(h.live('a').length, 0);
  assert.equal(h.markers.view.get('v1'), 2, 'strip chip keeps the count');
  h.views.set(ACT.id, view('visible'));
  c.onViewsChanged();
  assert.equal(h.live('a').length, 1);
  assert.equal(h.live('a')[0]!.collapsed, true);
  // The user / sender handles it → gone.
  c.onStore(snap([b, o]), [{ kind: 'removed', id: 'a', source: 'live', reason: 'removed' }]);
  assert.equal(h.live('a').length, 0);
  assert.equal(h.markers.view.get('v1'), 1);
  // Lock: everything hidden at once; unlock re-docks.
  h.isLocked = true; c.onLock(true);
  assert.equal(h.live('b').length, 0);
  assert.equal(h.mounted.filter((m) => m.id === 'b').every((m) => m.instant || !m.disposed || m.collapsed !== undefined), true);
  h.isLocked = false; c.onLock(false);
  assert.equal(h.live('b').length, 1);
});
