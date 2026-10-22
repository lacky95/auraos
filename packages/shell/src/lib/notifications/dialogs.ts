/**
 * Dialogue placement and lifecycle (phase 4), DOM-free.
 *
 * Asking is not interrupting. A dialogue opens on its own only when the
 * sender may force it (`popup`, granted + rate limited server-side) or when
 * it is an AuraOS desktop decision (`scope:'desktop'`, SYSTEM_CALLER only).
 * Everything else waits in the list with "Answer".
 *
 *   situation                                            → placement
 *   ───────────────────────────────────────────────────────────────────────
 *   scope 'desktop' from AuraOS                          → desktop modal
 *   own context window visible, Answer or popup          → overlay in that window
 *   own context window minimized / other workspace,
 *     popup, no user action                              → wait (marker on the
 *                                                          strip chip / workspace
 *                                                          pill; "Answer" stays)
 *   … and the user presses Answer                        → reveal the window,
 *                                                          then the overlay
 *   no window (background app, agent), or a window of
 *     ANOTHER app: Answer or popup                       → floating, non-modal
 *   phone                                                → bottom sheet, or a
 *                                                          full view when complex
 *
 * `blocking` (server-checked: own window only) makes only that window inert,
 * and only once the dialogue is actually shown over it. A dialogue is never
 * placed over a window its sender does not own (no phishing over other apps).
 * The window is never fetched without a user action.
 *
 * The controller keeps per-dialogue state: open ones, ones waiting for their
 * window, and ones the user put off ("Later"). Slots of minimized windows are
 * destroyed, so an open overlay is re-attached when its window comes back.
 * While the screen is locked nothing is shown; desktop decisions wait for
 * the unlock.
 *
 * The DOM side is injected (`DialogHost`) — see
 * components/shell/notifications/DialogLayer.ts.
 */
import type { Notification } from './api.ts';
import type { StoreChange, StoreSnapshot } from './store.ts';

export type ViewState = 'visible' | 'other-workspace' | 'minimized' | 'none';

/** A window as the shell page reports it (`window.auraViewDetail`). */
export interface ViewDetail {
  state: ViewState;
  viewId: string;
  appId: string;
  instanceId: string;
  activityId?: string;
  /** Workspace that holds the window (for the pill marker). */
  workspaceId?: string;
}

/** Who opened it: the user (Answer, restore) or the sender (forced pop-up / desktop decision). */
export type DialogIntent = 'user' | 'auto';

export type DialogLayout = 'panel' | 'sheet' | 'full';

export type Placement =
  | { kind: 'desktop' }
  | { kind: 'window'; viewId: string; blocking: boolean; layout: DialogLayout }
  | { kind: 'floating'; layout: DialogLayout; blockViewId?: string }
  | { kind: 'wait'; viewId: string; reason: 'minimized' | 'other-workspace'; workspaceId?: string }
  | { kind: 'none'; reason: string };

export interface PlacementInput {
  intent: DialogIntent;
  /** The context window, if the context names one and it exists. */
  view: ViewDetail | null;
  phone: boolean;
}

/** Window contexts (activity / instance). */
export function windowContext(n: Pick<Notification, 'context'>): { instanceId: string; activityId?: string } | null {
  const c = n.context;
  if (!c) return null;
  if (c.kind === 'activity') return { instanceId: '', activityId: c.id };
  if (c.kind === 'instance') return { instanceId: c.id };
  return null;
}

/** A verified app (or AuraOS) that owns the window may draw over it. */
export function ownsWindow(n: Pick<Notification, 'sender'>, view: Pick<ViewDetail, 'appId'>): boolean {
  const s = n.sender;
  if (s.kind === 'auraos' && s.attribution === 'internal') return true;
  return s.attribution === 'verified' && (s.kind === 'app') && s.id === view.appId;
}

/** AuraOS desktop decision (scope is only ever kept for SYSTEM_CALLER server-side). */
export function isDesktopDecision(n: Pick<Notification, 'scope' | 'sender' | 'type'>): boolean {
  return n.type === 'dialogue' && n.scope === 'desktop' && n.sender.kind === 'auraos' && n.sender.attribution === 'internal';
}

/** Inputs, options, selects or comboboxes (buttons alone are not a form). */
export function hasFormFields(n: Pick<Notification, 'components'>): boolean {
  return (n.components ?? []).some((c) => c.kind === 'input' || c.kind === 'options' || c.kind === 'select' || c.kind === 'combobox');
}

/** Complex content gets a dedicated full view on the phone. */
export function isComplex(n: Pick<Notification, 'components'>): boolean {
  const comps = n.components ?? [];
  const fields = comps.filter((c) => c.kind === 'input' || c.kind === 'options' || c.kind === 'select' || c.kind === 'combobox').length;
  return fields > 3 || comps.some((c) => c.kind === 'input' && !!c.multiline);
}

/**
 * Clicking a Dialogue card (list or pop-up) opens its dialogue, like
 * "Answer" — except clicks on its own controls (links, buttons, fields,
 * the ⋯ menu). Simple and Locked cards never do this.
 */
export const CARD_CONTROL_SELECTOR = 'button, a, input, textarea, select, label, fieldset, [role="menu"], [data-own-escape]';
export function opensDialogOnActivate(n: Pick<Notification, 'type' | 'state'>): boolean {
  return n.type === 'dialogue' && n.state === 'active';
}

export function decidePlacement(n: Notification, inp: PlacementInput): Placement {
  if (n.state !== 'active') return { kind: 'none', reason: n.state };
  if (n.type !== 'dialogue') {
    // A Simple item with a form opens as a floating dialogue / sheet — only
    // because the user asked (pop-up click); never on its own.
    if (inp.intent === 'user' && hasFormFields(n)) return { kind: 'floating', layout: inp.phone ? (isComplex(n) ? 'full' : 'sheet') : 'panel' };
    return { kind: 'none', reason: 'not a dialogue' };
  }
  if (isDesktopDecision(n)) return { kind: 'desktop' };
  if (inp.intent === 'auto' && !n.popup) return { kind: 'none', reason: 'waits for Answer' };
  const layout: DialogLayout = inp.phone ? (isComplex(n) ? 'full' : 'sheet') : 'panel';
  const v = inp.view;
  if (v && v.state !== 'none' && ownsWindow(n, v)) {
    if (v.state === 'visible') {
      const blocking = !!n.blocking;
      // Phone: the dialogue is a sheet / full view; a blocking one still
      // makes its window inert behind it.
      if (inp.phone) return { kind: 'floating', layout, ...(blocking ? { blockViewId: v.viewId } : {}) };
      return { kind: 'window', viewId: v.viewId, blocking, layout };
    }
    // Hidden window: never fetched on the sender's behalf.
    return { kind: 'wait', viewId: v.viewId, reason: v.state, ...(v.workspaceId ? { workspaceId: v.workspaceId } : {}) };
  }
  return { kind: 'floating', layout };
}

/**
 * May the user put this dialogue off (header ✕ / Escape → it stays in the
 * list with Answer)? Not a blocking one (asking was allowed to block its
 * window) and not an AuraOS desktop decision (only resolving closes it).
 */
export function canPutOff(p: Placement): boolean {
  if (p.kind === 'desktop') return false;
  if (p.kind === 'window') return !p.blocking;
  if (p.kind === 'floating') return !p.blockViewId;
  return false;
}
/** The header close button of a dialogue that can be put off. */
export const CLOSE_LATER = { label: 'Close (answer later)', title: 'Close — answer later' } as const;

// ---------------------------------------------------------------------------
// Workspace switcher markers
// ---------------------------------------------------------------------------

export interface WorkspaceNavMarkers {
  /** Marked workspaces before the visible pill window (‹ arrow). */
  prev: string[];
  /** Marked workspaces after it (› arrow). */
  next: string[];
  /** Pills folded away completely: the ▦ trigger carries them all. */
  trigger: string[];
}

/**
 * Which switcher control leads to a marked workspace whose pill is not shown.
 * `order` = every workspace id in pill order, `visible` = the ids whose pill
 * is rendered inline, `folded` = the pills sit in the closed-or-open dropdown.
 */
export function workspaceNavMarkers(
  order: readonly string[], visible: readonly string[], marked: ReadonlyMap<string, number>, folded: boolean,
): WorkspaceNavMarkers {
  const out: WorkspaceNavMarkers = { prev: [], next: [], trigger: [] };
  const ids = order.filter((id) => (marked.get(id) ?? 0) > 0);
  if (!ids.length) return out;
  if (folded) { out.trigger = ids; return out; }
  const idx = visible.map((id) => order.indexOf(id)).filter((i) => i >= 0);
  if (!idx.length) { out.trigger = ids; return out; }
  const first = Math.min(...idx);
  const last = Math.max(...idx);
  for (const id of ids) {
    const i = order.indexOf(id);
    if (i < first) out.prev.push(id);
    else if (i > last) out.next.push(id);
  }
  return out;
}

/** "Workspace 5 has a pending dialogue" / "Workspaces 2 and 5 have pending dialogues". */
export function workspaceMarkerHint(ids: readonly string[], order: readonly string[]): string {
  const nums = ids.map((id) => order.indexOf(id) + 1).filter((n) => n > 0);
  if (!nums.length) return '';
  if (nums.length === 1) return `Workspace ${nums[0]} has a pending dialogue`;
  const list = `${nums.slice(0, -1).join(', ')} and ${nums[nums.length - 1]}`;
  return `Workspaces ${list} have pending dialogues`;
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export interface MountOptions {
  /** Move focus into the dialogue (user-opened, blocking, desktop). */
  takeFocus: boolean;
  /** The user put it off ("Later" / Escape) — it stays in the list. */
  onLater: () => void;
}

export interface MountedDialog {
  update(n: Notification): void;
  /** Bring it forward / expand it (Answer pressed again). */
  focus(): void;
  /**
   * Hide it. Animated (slide right + fade) by default; `instant` for lock /
   * wipe / detach (privacy, or the slot is gone anyway).
   */
  dispose(opts?: { instant?: boolean }): void;
}

export interface DialogHost {
  /** The context window (null when the context names none or it is gone). */
  viewDetail(ctx: { instanceId: string; activityId?: string }): ViewDetail | null;
  /** Reveal the window (switch workspace / restore). The user asked for it. */
  reveal(ctx: { instanceId: string; activityId?: string }): Promise<void>;
  phone(): boolean;
  locked(): boolean;
  /** True when focus is inside that window's iframe (or nowhere in particular). */
  focusInWindowOrNowhere(viewId: string): boolean;
  mount(n: Notification, placement: Exclude<Placement, { kind: 'wait' } | { kind: 'none' }>, opts: MountOptions): MountedDialog | null;
  /** Pending-dialogue markers: count per minimized view / per workspace. */
  setMarkers(byView: ReadonlyMap<string, number>, byWorkspace: ReadonlyMap<string, number>): void;
}

interface OpenDialog {
  n: Notification;
  intent: DialogIntent;
  placement: Placement;
  mounted: MountedDialog;
}

interface Waiting {
  n: Notification;
  intent: DialogIntent;
}

export class DialogController {
  private readonly open = new Map<string, OpenDialog>();
  /** Will open over their window once it is visible (forced, or opened before). */
  private readonly waiting = new Map<string, Waiting>();
  /** The user put these off; nothing re-opens them on its own. */
  private readonly later = new Set<string>();
  private readonly items = new Map<string, Notification>();
  private disposed = false;
  private primed = false;

  constructor(private readonly host: DialogHost) {}

  /** Feed every store notification here (`store.subscribe`). */
  onStore(snap: StoreSnapshot, changes: readonly StoreChange[]): void {
    if (this.disposed) return;
    this.items.clear();
    for (const n of snap.items) this.items.set(n.id, n);
    if (!this.primed && snap.ready) {
      // First look at an already-loaded store (e.g. after a hot reload): a
      // pending desktop decision must be answered.
      this.primed = true;
      for (const n of snap.items) if (isDesktopDecision(n)) this.consider(n, 'auto');
    }
    for (const ch of changes) {
      const n = this.items.get(ch.id);
      // A 'gone' removal is a lock wipe / an item hidden from a locked view: instant.
      if (ch.kind === 'removed' || !n || n.state !== 'active') { this.close(ch.id, ch.kind === 'removed' && ch.reason === 'gone'); continue; }
      if (ch.kind === 'added') {
        // Forced dialogues open on arrival; a desktop decision also after a
        // reload (it must be answered).
        if (ch.source === 'live' || isDesktopDecision(n)) this.consider(n, 'auto');
      } else {
        const o = this.open.get(n.id);
        if (o) { o.n = n; o.mounted.update(n); }
        const w = this.waiting.get(n.id);
        if (w) w.n = n;
      }
    }
    // Anything open that is no longer active (missed change) closes.
    for (const id of [...this.open.keys()]) if (!this.items.has(id)) this.close(id, true);
    for (const id of [...this.waiting.keys()]) if (!this.items.has(id)) this.waiting.delete(id);
    this.refreshMarkers();
  }

  /** The user pressed "Answer" (list, pop-up). */
  async answer(id: string): Promise<boolean> {
    const n = this.items.get(id);
    if (!n || n.state !== 'active' || !(n.type === 'dialogue' || hasFormFields(n))) return false;
    this.later.delete(id);
    const o = this.open.get(id);
    if (o) { o.mounted.focus(); return true; }
    const ctx = windowContext(n);
    const view = ctx ? this.host.viewDetail(ctx) : null;
    const p = decidePlacement(n, { intent: 'user', view, phone: this.host.phone() });
    if (p.kind === 'wait' && ctx) {
      // The user asked: reveal the window, then attach when it is visible.
      this.waiting.set(id, { n, intent: 'user' });
      this.refreshMarkers();
      await this.host.reveal(ctx);
      this.onViewsChanged();
      return true;
    }
    return this.mountFor(n, 'user', p);
  }

  /** Window layout changed (slot added / removed, workspace switch, restore). */
  onViewsChanged(): void {
    if (this.disposed) return;
    // Open window overlays whose slot went away (minimized → slot destroyed)
    // or got hidden: detach; they re-attach when the window is back.
    for (const [id, o] of [...this.open]) {
      if (o.placement.kind !== 'window' && !(o.placement.kind === 'floating' && o.placement.blockViewId)) continue;
      const ctx = windowContext(o.n);
      const v = ctx ? this.host.viewDetail(ctx) : null;
      const viewId = o.placement.kind === 'window' ? o.placement.viewId : o.placement.blockViewId;
      // Still on screen, and still the right shape (overlay on desktop, sheet on phone)?
      const shapeOk = this.host.phone() ? o.placement.kind === 'floating' : o.placement.kind === 'window';
      if (v && v.state === 'visible' && v.viewId === viewId && shapeOk) continue;
      o.mounted.dispose({ instant: true });
      this.open.delete(id);
      if (v && v.state !== 'none') this.waiting.set(id, { n: o.n, intent: o.intent });
    }
    for (const [id, w] of [...this.waiting]) {
      const n = this.items.get(id) ?? w.n;
      const ctx = windowContext(n);
      const v = ctx ? this.host.viewDetail(ctx) : null;
      if (!v || v.state === 'none') { this.waiting.delete(id); continue; }   // window closed: list only
      if (v.state !== 'visible') continue;
      this.waiting.delete(id);
      // Back on screen — restored by the user, or revealed by Answer.
      this.consider(n, w.intent === 'user' ? 'user' : 'auto', true);
    }
    this.refreshMarkers();
  }

  /** Lock screen: hide everything; re-open on unlock. */
  onLock(locked: boolean): void {
    if (this.disposed) return;
    if (locked) {
      for (const [id, o] of [...this.open]) {
        o.mounted.dispose({ instant: true });   // privacy: never animate under a lock
        this.open.delete(id);
        this.waiting.set(id, { n: o.n, intent: o.intent });
      }
      this.refreshMarkers();
      return;
    }
    for (const [id, w] of [...this.waiting]) {
      const n = this.items.get(id);
      if (!n) { this.waiting.delete(id); continue; }
      const ctx = windowContext(n);
      const v = ctx ? this.host.viewDetail(ctx) : null;
      // Window ones that are still hidden keep waiting.
      if (v && v.state !== 'visible' && v.state !== 'none' && ownsWindow(n, v) && !isDesktopDecision(n)) continue;
      this.waiting.delete(id);
      this.consider(n, w.intent, true);
    }
    // Desktop decisions that arrived while locked.
    for (const n of this.items.values()) {
      if (isDesktopDecision(n) && !this.open.has(n.id)) this.consider(n, 'auto');
    }
    this.refreshMarkers();
  }

  isOpen(id: string): boolean { return this.open.has(id); }
  isWaiting(id: string): boolean { return this.waiting.has(id); }

  /**
   * What an arriving item would do on its own — the pop-ups skip dialogues
   * that open by themselves (no duplicate pop-up next to the dialogue).
   */
  autoPlacement(n: Notification): Placement['kind'] {
    const ctx = windowContext(n);
    const view = ctx ? this.host.viewDetail(ctx) : null;
    return decidePlacement(n, { intent: 'auto', view, phone: this.host.phone() }).kind;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const o of this.open.values()) { try { o.mounted.dispose({ instant: true }); } catch { /* ignore */ } }
    this.open.clear();
    this.waiting.clear();
    this.host.setMarkers(new Map(), new Map());
  }

  // ---- internals ------------------------------------------------------------

  private consider(n: Notification, intent: DialogIntent, reattach = false): void {
    if (this.open.has(n.id)) return;
    if (!reattach && intent === 'auto' && this.later.has(n.id)) return;
    const ctx = windowContext(n);
    const view = ctx ? this.host.viewDetail(ctx) : null;
    // A re-attach (opened before / forced, now visible again) counts as allowed.
    const p = decidePlacement(reattach ? { ...n, popup: true } : n, { intent, view, phone: this.host.phone() });
    if (p.kind === 'none') return;
    if (p.kind === 'wait') { this.waiting.set(n.id, { n, intent }); return; }
    this.mountFor(n, intent, p);
  }

  private mountFor(n: Notification, intent: DialogIntent, p: Placement): boolean {
    if (p.kind === 'none' || p.kind === 'wait') return false;
    if (this.host.locked()) { this.waiting.set(n.id, { n, intent }); return false; }
    const blocks = (p.kind === 'window' && p.blocking) || (p.kind === 'floating' && !!p.blockViewId);
    const viewId = p.kind === 'window' ? p.viewId : p.kind === 'floating' ? p.blockViewId : undefined;
    const takeFocus = intent === 'user' || p.kind === 'desktop'
      || (blocks && !!viewId && this.host.focusInWindowOrNowhere(viewId));
    const mounted = this.host.mount(n, p, {
      takeFocus,
      onLater: () => this.putOff(n.id),
    });
    if (!mounted) return false;
    this.open.set(n.id, { n, intent, placement: p, mounted });
    this.waiting.delete(n.id);
    this.refreshMarkers();
    return true;
  }

  private putOff(id: string): void {
    const o = this.open.get(id);
    if (!o) return;
    if (!canPutOff(o.placement)) return;   // blocking / desktop decision: only resolving closes it
    o.mounted.dispose();
    this.open.delete(id);
    this.later.add(id);
    this.refreshMarkers();
  }

  private close(id: string, instant = false): void {
    const o = this.open.get(id);
    if (o) { try { o.mounted.dispose({ instant }); } catch { /* ignore */ } this.open.delete(id); }
    this.waiting.delete(id);
    this.later.delete(id);
  }

  private refreshMarkers(): void {
    const byView = new Map<string, number>();
    const byWs = new Map<string, number>();
    for (const [id, w] of this.waiting) {
      const n = this.items.get(id) ?? w.n;
      const ctx = windowContext(n);
      const v = ctx ? this.host.viewDetail(ctx) : null;
      if (!v || v.state === 'visible' || v.state === 'none') continue;
      if (v.state === 'minimized') byView.set(v.viewId, (byView.get(v.viewId) ?? 0) + 1);
      if (v.state === 'other-workspace' && v.workspaceId) byWs.set(v.workspaceId, (byWs.get(v.workspaceId) ?? 0) + 1);
    }
    this.host.setMarkers(byView, byWs);
  }
}
