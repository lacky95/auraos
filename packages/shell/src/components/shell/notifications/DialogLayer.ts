/**
 * DialogLayer — the DOM side of the dialogue controller (phase 4).
 *
 * Wires `lib/notifications/dialogs.ts` to the page:
 *   - the shared store (`getNotifications()`) feeds the controller;
 *   - window state comes from `window.auraViewDetail` (pages/index.astro),
 *     changes from `aura:views.changed` (end of every renderLayout) plus a
 *     MutationObserver on `.app-slot` additions as a safety net;
 *   - "Answer" reveals through `window.auraRevealInstance`;
 *   - mounts WindowDialog / FloatingDialog / DesktopDecision;
 *   - markers: `data-ntf-pending` on the minimized-strip chip
 *     (`[data-aura-strip] [data-action="restore"][data-view-id]`) and on the
 *     workspace pill (`.ws-pill[data-ws-id]`), re-applied after re-renders;
 *   - lock screen: `watchLock`.
 * Exposes `window.__auraDialogs` ({ answer, autoPlacement, isOpen }) for the
 * list and the pop-ups. One disposer for everything.
 */
import { getNotifications, type NotificationsRuntime } from '../../../lib/notifications/shared.ts';
import {
  DialogController, workspaceMarkerHint, workspaceNavMarkers, type DialogHost, type ViewDetail,
} from '../../../lib/notifications/dialogs.ts';
import * as workspaceClient from '../../../lib/workspaceClient';
import type { Notification } from '../../../lib/notifications/api.ts';
import { mountWindowDialog, syncWindowBadge } from './WindowDialog.ts';
import { mountFloatingDialog } from './FloatingDialog.ts';
import { mountDesktopDecision } from './DesktopDecision.ts';
import { Disposer, PHONE_MAX_WIDTH, isLocked, watchLock } from './placement.ts';
import { getDrafts } from '../../../lib/notifications/drafts.ts';
import { CollapseMemory, badgeAction, badgeHint, type StorageLike as CollapseStorage } from '../../../lib/notifications/activityLinks.ts';

/** Draft garbage collection: on start (once the store is loaded) and every 30 min. */
const DRAFT_GC_INTERVAL_MS = 30 * 60_000;

export interface DialogsApi {
  /** "Answer": open the dialogue (reveals its window if needed). */
  answer(id: string): Promise<boolean>;
  /** "Go to activity": reveal the linked window and expand its panel. */
  goToActivity(id: string): Promise<boolean>;
  /** What the item would do on its own ('window' | 'floating' | 'desktop' | 'wait' | 'none'). */
  autoPlacement(n: Notification): string;
  isOpen(id: string): boolean;
}

declare global {
  interface Window {
    __auraDialogs?: DialogsApi;
    auraViewDetail?: (instanceId: string, activityId?: string) => ViewDetail | null;
    auraRevealInstance?: (instanceId: string, activityId?: string) => unknown;
  }
}

function slotOf(viewId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`#dynamic-layout > .app-slot[data-view-id="${CSS.escape(viewId)}"]`)
    ?? document.querySelector<HTMLElement>(`.app-slot[data-view-id="${CSS.escape(viewId)}"]`);
}

export function mountDialogLayer(): () => void {
  const d = new Disposer();
  let rt: NotificationsRuntime | null = null;
  let disposed = false;
  let markView: ReadonlyMap<string, number> = new Map();
  let markWs: ReadonlyMap<string, number> = new Map();

  const applyMarkers = () => {
    const chips = document.querySelectorAll<HTMLElement>('[data-aura-strip] [data-action="restore"][data-view-id]');
    chips.forEach((c) => { const n = markView.get(c.dataset['viewId'] ?? '') ?? 0; setMark(c, n, badgeHint(n)); });
    applyWindowBadges();
    document.querySelectorAll<HTMLElement>('.ws-pill[data-ws-id]').forEach((p) => setMark(p, markWs.get(p.dataset['wsId'] ?? '') ?? 0));
    applyNavMarkers();
  };
  // Activity-linked items: a yellow badge with the count in the window's
  // title bar + a warning edge on the slot (lib/notifications/activityLinks.ts).
  function applyWindowBadges() {
    document.querySelectorAll<HTMLElement>('#dynamic-layout > .app-slot[data-view-id]').forEach((slot) => {
      const viewId = slot.dataset['viewId'] ?? '';
      const n = markView.get(viewId) ?? 0;
      const ids = n ? ctl.linkedFor(viewId) : [];
      const unseen = ids.some((id) => rt?.store.get(id)?.seenAt === undefined);
      syncWindowBadge(slot, n, {
        unseen, hint: badgeHint(n),
        onClick: () => {
          const act = badgeAction(ctl.linkedFor(viewId));
          if (!act) return;
          if (act.kind === 'open') { void ctl.answer(act.id).then((ok) => { if (!ok) document.dispatchEvent(new CustomEvent('aura:notifications.open', { detail: { id: act.id } })); }); }
          else document.dispatchEvent(new CustomEvent('aura:notifications.open', { detail: { id: act.id } }));
        },
      });
    });
  }
  // Marked workspaces whose pill is not shown: mark the ‹ / › arrow or the
  // ▦ trigger that leads there. StatusBar re-renders its pills on every
  // scrub / fit / workspace change, which the #ws-pills observer catches.
  function applyNavMarkers() {
    const pillsEl = document.getElementById('ws-pills');
    const order = (workspaceClient.getCached()?.workspaces ?? []).map((w) => w.id);
    const folded = document.getElementById('ws-bundle')?.dataset['fold'] === 'all';
    const visible = pillsEl ? [...pillsEl.querySelectorAll<HTMLElement>('.ws-pill[data-ws-id]')].map((p) => p.dataset['wsId'] ?? '') : [];
    const nav = workspaceNavMarkers(order, visible, markWs, folded);
    const prev = pillsEl?.querySelector<HTMLElement>('.ws-pill-nav[data-ws-action="prev"]');
    const next = pillsEl?.querySelector<HTMLElement>('.ws-pill-nav[data-ws-action="next"]');
    const trigger = document.getElementById('ws-collapse-btn');
    const mark = (el: HTMLElement | null | undefined, ids: string[]) => {
      if (!el) return;
      // A disabled arrow has nothing beyond it.
      const n = el instanceof HTMLButtonElement && el.disabled ? 0 : ids.length;
      setMark(el, n, workspaceMarkerHint(ids, order));
    };
    mark(prev, nav.prev);
    mark(next, nav.next);
    mark(trigger, nav.trigger);
  }
  function setMark(el: HTMLElement, count: number, hint?: string) {
    if (count > 0) {
      el.dataset['ntfPending'] = String(count);
      if (el.dataset['ntfTitle'] === undefined) el.dataset['ntfTitle'] = el.title ?? '';
      const text = hint || `${count} question${count === 1 ? '' : 's'} waiting`;
      el.title = `${el.dataset['ntfTitle']}${el.dataset['ntfTitle'] ? ' · ' : ''}${text}`;
      el.setAttribute('aria-description', text);
    } else if (el.dataset['ntfPending'] !== undefined) {
      delete el.dataset['ntfPending'];
      if (el.dataset['ntfTitle'] !== undefined) { el.title = el.dataset['ntfTitle']; delete el.dataset['ntfTitle']; }
      el.removeAttribute('aria-description');
    }
  }

  const host: DialogHost = {
    viewDetail: (ctx) => {
      try { return window.auraViewDetail?.(ctx.instanceId, ctx.activityId) ?? null; } catch { return null; }
    },
    reveal: async (ctx) => {
      try { await window.auraRevealInstance?.(ctx.instanceId, ctx.activityId); } catch (err) { console.warn('[notifications] reveal failed', err); }
    },
    phone: () => document.body.clientWidth < PHONE_MAX_WIDTH,
    locked: () => isLocked(),
    focusInWindowOrNowhere: (viewId) => {
      const a = document.activeElement;
      if (!a || a === document.body || a === document.documentElement) return true;
      return a instanceof HTMLIFrameElement && !!a.closest(`.app-slot[data-view-id="${CSS.escape(viewId)}"]`);
    },
    mount: (n, p, opts) => {
      if (!rt) return null;
      // Reopened mid-exit: drop the leaving copy at once (no double dialogue).
      document.querySelectorAll<HTMLElement & { __exit?: { hide(fn: () => void, o: { instant: boolean }): boolean } }>(`section.aura-dlg[data-exit="true"][data-id="${CSS.escape(n.id)}"]`)
        .forEach((el) => el.__exit?.hide(() => el.remove(), { instant: true }));
      const common = { actions: rt.actions, appLookup: rt.appLookup };
      if (p.kind === 'desktop') return mountDesktopDecision(n, common);
      if (p.kind === 'window') {
        const slot = slotOf(p.viewId);
        if (!slot) return null;
        return mountWindowDialog(slot, n, {
          ...common, blocking: p.blocking, takeFocus: opts.takeFocus, onLater: opts.onLater,
          ...(opts.collapsed ? { collapsed: true } : {}), ...(opts.onAnswer ? { onAnswer: opts.onAnswer } : {}),
          ...(opts.onCollapseChange ? { onCollapseChange: opts.onCollapseChange } : {}),
        });
      }
      return mountFloatingDialog(n, {
        ...common, layout: p.layout, takeFocus: opts.takeFocus, onLater: opts.onLater,
        ...(p.blockViewId ? { blockSlot: slotOf(p.blockViewId) } : {}),
      });
    },
    setMarkers: (byView, byWs) => {
      markView = byView;
      markWs = byWs;
      applyMarkers();
    },
  };
  // Collapsed in-window panels survive re-mounts and reloads (per tab).
  let session: CollapseStorage | null = null;
  try { session = window.sessionStorage; } catch { session = null; }
  host.collapseMemory = new CollapseMemory(session);
  const ctl = new DialogController(host);

  let raf = 0;
  const viewsChanged = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; ctl.onViewsChanged(); applyMarkers(); });
  };
  d.add(() => { if (raf) cancelAnimationFrame(raf); });
  d.listen(document, 'aura:views.changed', viewsChanged);
  // Safety net: `.app-slot` added / removed outside renderLayout.
  const layout = document.getElementById('dynamic-layout');
  if (layout) {
    const mo = new MutationObserver((recs) => {
      for (const r of recs) {
        for (const nd of [...r.addedNodes, ...r.removedNodes]) {
          if (nd instanceof HTMLElement && (nd.classList.contains('app-slot') || nd.hasAttribute('data-aura-strip'))) { viewsChanged(); return; }
        }
      }
    });
    mo.observe(layout, { childList: true });
    d.add(() => mo.disconnect());
  }
  // Workspace pills are re-rendered by the StatusBar: re-apply markers.
  const pills = document.getElementById('ws-pills');
  if (pills) {
    const mo = new MutationObserver(() => applyMarkers());
    mo.observe(pills, { childList: true });
    d.add(() => mo.disconnect());
  }
  // Fold level changes (inline ↔ dropdown) and workspace list / active changes.
  const bundle = document.getElementById('ws-bundle');
  if (bundle) {
    const mo = new MutationObserver(() => applyNavMarkers());
    mo.observe(bundle, { attributes: true, attributeFilter: ['data-fold'] });
    d.add(() => mo.disconnect());
  }
  try { d.add(workspaceClient.subscribe(() => { applyMarkers(); })); } catch { /* older client */ }
  // Workspace switches and phone/desktop changes move windows without a slot change.
  d.listen(window, 'resize', viewsChanged);
  d.add(watchLock((locked) => ctl.onLock(locked)));

  const api: DialogsApi = {
    answer: (id) => ctl.answer(id),
    goToActivity: (id) => ctl.goToActivity(id),
    autoPlacement: (n) => ctl.autoPlacement(n),
    isOpen: (id) => ctl.isOpen(id),
  };
  window.__auraDialogs = api;
  d.add(() => { if (window.__auraDialogs === api) delete window.__auraDialogs; });

  getNotifications().then((runtime) => {
    if (disposed) return;
    rt = runtime;
    let gcDone = false;
    d.add(runtime.store.subscribe((snap, changes) => {
      ctl.onStore(snap, changes);
      // Drafts: resolved / removed by anyone → gone. NOT on 'gone' — that is
      // a lock wipe or an item hidden from a locked view, not an ending.
      for (const ch of changes) if (ch.kind === 'removed' && ch.reason !== 'gone') getDrafts().clear(ch.id);
      // GC once loaded — never from a locked view (it lists fewer items).
      if (snap.ready && !gcDone && !snap.error && !isLocked()) {
        gcDone = true;
        getDrafts().gc(new Set(snap.items.map((n) => n.id)));
      }
    }));
    const gc = setInterval(() => {
      const snap = runtime.store.snapshot();
      if (snap.ready && !snap.error && !isLocked()) getDrafts().gc(new Set(snap.items.map((n) => n.id)));
    }, DRAFT_GC_INTERVAL_MS);
    d.add(() => clearInterval(gc));
  }).catch((err) => console.warn('[notifications] dialog layer: runtime failed', err));

  return () => {
    if (disposed) return;
    disposed = true;
    ctl.dispose();
    d.dispose();
    applyMarkers();
  };
}
