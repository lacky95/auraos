// End to end in the DOM (phase 6 bug): a store item → the REAL dialogue layer
// (DialogLayer: controller + DesktopDecision) and the REAL pop-up stack
// (toastStack) on one shared runtime. An app desktop modal must open as the
// desktop-wide modal (no corner pop-up) when it may open by itself, and
// otherwise wait as a pop-up whose click opens the desktop modal.
//
//   cd packages/shell && npx tsx --test test/notification-desktop-modal-e2e.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dom, flush, resetDom } from './dom.ts';
import type { Notification } from '../src/lib/notifications/api.ts';

const { mountDialogLayer } = await import('../src/components/shell/notifications/DialogLayer.ts');
const { mountToasts } = await import('../src/components/shell/notifications/toastStack.ts');
const doc = dom.document as unknown as Document;

function runtime() {
  const items = new Map<string, Notification>();
  const subs: Array<(snap: unknown, changes: unknown[]) => void> = [];
  const snapshot = () => ({ items: [...items.values()], ready: true, error: null, unseenCount: 0, totalCount: items.size, highestUnseenPriority: null, newestUnseen: null, mostImportant: null });
  const emit = (changes: unknown[]) => { for (const s of [...subs]) s(snapshot(), changes); };
  const ok = async () => ({ ok: true as const });
  const calls: string[] = [];
  const rt = {
    store: {
      subscribe(fn: (snap: unknown, changes: unknown[]) => void) { subs.push(fn); fn(snapshot(), []); return () => {}; },
      get: (id: string) => items.get(id) ?? null,
      snapshot,
      isDisposed: false,
    },
    appLookup: (id: string) => (id === 'com.example.notifp4' ? { name: 'Notification Tester', icon: 'NT' } : undefined),
    onAppsChanged: () => () => {},
    actions: {
      markDisplayed: () => {}, markSeen: (ids: string[]) => { calls.push(`seen:${ids.join(',')}`); },
      interact: ok, dismiss: ok, forceRemove: ok, resolve: async (id: string) => { calls.push(`resolve:${id}`); return { ok: true as const }; },
      forceHide: async (id: string) => { calls.push(`forceHide:${id}`); return { ok: true as const }; },
    },
  };
  const put = (n: Notification, kind: 'added' | 'updated' = 'added') => { items.set(n.id, n); emit([{ kind, id: n.id, source: 'live' }]); };
  return { rt, put, calls };
}

let seq = 0;
const modal = (over: Partial<Notification> = {}): Notification => ({
  id: `ntf_00000000e2e${String(++seq).padStart(6, '0')}`, type: 'dialogue', title: 'Confirm the database migration', text: 'Run migration 42 now?',
  priority: 'high', visibility: 'private', pinned: false, popup: true, blocking: true, scope: 'desktop',
  caller: { kind: 'instance', appId: 'com.example.notifp4', instanceId: 'com.example.notifp4', verification: 'verified' },
  sender: { kind: 'app', id: 'com.example.notifp4', attribution: 'verified' }, senderKey: 'app:com.example.notifp4',
  state: 'active', createdAt: 1, updatedAt: 1, history: [],
  components: [{ kind: 'input', id: 'note', label: 'Note' }],
  ...over,
} as Notification);

async function setup(t: { after(fn: () => void): void }) {
  resetDom('<div id="dock"></div><div id="notif-toasts" class="notif-toasts" hidden></div>');
  // happy-dom has no layout: a desktop-width body (the shell's phone check reads body px).
  Object.defineProperty(doc.body, 'clientWidth', { configurable: true, get: () => 1280 });
  const f = runtime();
  (dom as unknown as { __auraNotifications: unknown }).__auraNotifications = f.rt;
  const offDialogs = mountDialogLayer();
  const offToasts = mountToasts(doc.getElementById('notif-toasts')!, async () => f.rt as never);
  await flush(); await flush();
  let done = false;
  const cleanup = () => { if (done) return; done = true; offToasts(); offDialogs(); delete (dom as unknown as { __auraNotifications?: unknown }).__auraNotifications; };
  t.after(cleanup);   // also when an assertion fails (the layer's timers would keep the process alive)
  return { ...f, done: cleanup };
}
const desktop = () => doc.querySelector<HTMLElement>('.aura-dlg-desktop');
const toastCards = () => doc.querySelectorAll('#notif-toasts > .aura-ntf');

test('e2e: scope desktop + blocking + popup → the desktop-wide app modal opens at once, app-identified; NO corner pop-up', async (t) => {
  const s = await setup(t);
  s.put(modal());
  await flush(); await flush();
  const o = desktop();
  assert.ok(o, 'desktop modal mounted');
  assert.equal(o!.dataset['kind'], 'app');
  assert.match(o!.querySelector('.aura-dlg-appbar')!.textContent!, /Requested by\s*Notification Tester/);
  assert.equal((doc.getElementById('dock') as HTMLElement).inert, true, 'the shell is blocked');
  assert.equal(toastCards().length, 0, 'no corner pop-up for it');
  s.done();
});

test('e2e: popup:false → a corner pop-up first; clicking it opens the desktop modal (not the in-place pop-up)', async (t) => {
  const s = await setup(t);
  const n = modal({ popup: false });
  s.put(n);
  await flush(); await flush();
  assert.equal(desktop(), null, 'does not take over by itself');
  const card = doc.querySelector<HTMLElement>('#notif-toasts > .aura-ntf')!;
  assert.ok(card, 'waits as a pop-up');
  card.querySelector<HTMLElement>('.aura-ntf-title')!.click();
  await flush(); await flush();
  assert.ok(desktop(), 'the click opened the desktop modal');
  assert.equal(desktop()!.dataset['kind'], 'app');
  s.done();
});

test('e2e: after a force-hide the sender is held back — its next modal waits as a pop-up (the user bug), and opening it gives the real modal', async (t) => {
  const s = await setup(t);
  s.put(modal());
  await flush(); await flush();
  const link = doc.querySelector<HTMLButtonElement>('.aura-dlg-forcehide')!;
  link.click();
  [...doc.querySelectorAll<HTMLButtonElement>('.aura-dlg-forcehide-confirm button')].find((b) => b.textContent === 'Hide')!.click();
  await flush(); await flush();
  assert.equal(desktop(), null, 'force-hidden');
  assert.ok(s.calls.some((c) => c.startsWith('forceHide:')));
  const next = modal();
  s.put(next);
  await flush(); await flush();
  assert.equal(desktop(), null, 'suppressed: no take-over by itself');
  const card = [...doc.querySelectorAll<HTMLElement>('#notif-toasts > .aura-ntf')].find((c) => c.dataset['id'] === next.id)!;
  assert.ok(card, 'it waits as a pop-up');
  card.querySelector<HTMLElement>('.aura-ntf-title')!.click();
  await flush(); await flush();
  assert.ok(desktop(), 'the user opening it gets the desktop modal');
  s.done();
});

test('e2e: scope desktop without blocking → a centred dialogue when opened (Answer), not the corner panel', async (t) => {
  const s = await setup(t);
  const n = modal({ blocking: false, popup: false, title: 'A centred question' });
  s.put(n);
  await flush(); await flush();
  assert.equal(desktop(), null);
  await (dom as unknown as { __auraDialogs: { answer(id: string): Promise<boolean> } }).__auraDialogs.answer(n.id);
  await flush();
  assert.ok(doc.querySelector('.aura-dlg-centred-host > .aura-dlg-centred'), 'centred');
  assert.equal((doc.getElementById('dock') as HTMLElement).inert, false, 'nothing blocked');
  s.done();
});
