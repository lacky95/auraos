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
import { CollapseMemory, isActivityLinked, linkCounts, linkedView } from './activityLinks.ts';

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
  /** Phase 6: an APP-requested desktop modal (granted desktopModal): blocks the shell, force-hideable. */
  | { kind: 'appModal' }
  | { kind: 'window'; viewId: string; blocking: boolean; layout: DialogLayout }
  | { kind: 'floating'; layout: DialogLayout; blockViewId?: string; centred?: boolean }
  | { kind: 'wait'; viewId: string; reason: 'minimized' | 'other-workspace'; workspaceId?: string }
  | { kind: 'none'; reason: string };

export interface PlacementInput {
  intent: DialogIntent;
  /** The context window, if the context names one and it exists. */
  view: ViewDetail | null;
  phone: boolean;
  /** Phase 6: the user force-hid a modal of this sender recently (this tab) — no more blocking from it. */
  suppressed?: boolean;
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

/**
 * Phase 6: an APP (or agent / API key) dialogue that blocks the whole shell —
 * the server keeps scope desktop + blocking only with the desktopModal grant.
 * AuraOS's own decisions are `isDesktopDecision` instead.
 */
export function isAppDesktopModal(n: Pick<Notification, 'scope' | 'sender' | 'type' | 'blocking' | 'state'>): boolean {
  return n.type === 'dialogue' && n.state === 'active' && n.scope === 'desktop' && !!n.blocking
    && !(n.sender.kind === 'auraos' && n.sender.attribution === 'internal');
}

/** Phase 6: a non-blocking desktop dialogue of an app — a centred floating dialogue. */
export function isCentredDesktop(n: Pick<Notification, 'scope' | 'sender' | 'type' | 'blocking'>): boolean {
  return n.type === 'dialogue' && n.scope === 'desktop' && !n.blocking && !(n.sender.kind === 'auraos' && n.sender.attribution === 'internal');
}

/** How long one force-hide suppresses that sender's desktop modals in this tab. */
export const FORCE_HIDE_SUPPRESS_MS = 10 * 60_000;

/** The protected shortcut that force-hides an app desktop modal (shell capture phase). */
export function isForceHideShortcut(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>): boolean {
  return e.key === 'Escape' && e.ctrlKey && e.altKey && e.shiftKey;
}

/** Inputs, options, selects, comboboxes or editable markdown (buttons alone are not a form). */
export function hasFormFields(n: Pick<Notification, 'components'>): boolean {
  return (n.components ?? []).some((c) => c.kind === 'input' || c.kind === 'options' || c.kind === 'select' || c.kind === 'combobox' || (c.kind === 'markdown' && !!c.editable));
}

/** Phase 6: markdown components (the full area renders only in a dialogue). */
export function hasMarkdown(n: Pick<Notification, 'components'>): boolean {
  return (n.components ?? []).some((c) => c.kind === 'markdown');
}

/** Complex content gets a dedicated full view on the phone (markdown too). */
export function isComplex(n: Pick<Notification, 'components'>): boolean {
  const comps = n.components ?? [];
  const fields = comps.filter((c) => c.kind === 'input' || c.kind === 'options' || c.kind === 'select' || c.kind === 'combobox').length;
  return fields > 3 || comps.some((c) => (c.kind === 'input' && !!c.multiline) || c.kind === 'markdown');
}

/**
 * Clicking a Dialogue card (list or pop-up) opens its dialogue, like
 * "Answer" — except clicks on its own controls (links, buttons, fields,
 * the ⋯ menu). Simple and Locked cards never do this.
 */
export const CARD_CONTROL_SELECTOR = 'button, a, input, textarea, select, label, fieldset, [role="menu"], [role="toolbar"], [data-own-escape]';
export function opensDialogOnActivate(n: Pick<Notification, 'type' | 'state'>): boolean {
  return n.type === 'dialogue' && n.state === 'active';
}

export function decidePlacement(n: Notification, inp: PlacementInput): Placement {
  if (n.state !== 'active') return { kind: 'none', reason: n.state };
  if (n.type !== 'dialogue') {
    // A Simple item with a form (or markdown, phase 6: "Show") opens as a
    // floating dialogue / sheet — only because the user asked; never on its own.
    if (inp.intent === 'user' && (hasFormFields(n) || hasMarkdown(n))) return { kind: 'floating', layout: inp.phone ? (isComplex(n) ? 'full' : 'sheet') : 'panel' };
    return { kind: 'none', reason: 'not a dialogue' };
  }
  if (isDesktopDecision(n)) return { kind: 'desktop' };
  if (isAppDesktopModal(n)) {
    // A desktop modal ALWAYS opens at once (popup is irrelevant). The one
    // exception: after a force-hide the sender may not take over by itself in
    // this tab for a while (suppressed) — it shows as a pop-up, and the user
    // opening it on purpose still gets the real modal.
    if (inp.intent === 'auto' && inp.suppressed) return { kind: 'none', reason: 'suppressed after a force-hide' };
    return { kind: 'appModal' };
  }
  // A centred (non-blocking) desktop dialogue also always opens at once.
  if (isCentredDesktop(n)) return { kind: 'floating', layout: inp.phone ? (isComplex(n) ? 'full' : 'sheet') : 'panel', centred: !inp.phone };
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
  if (p.kind === 'desktop' || p.kind === 'appModal') return false;   // appModal: only Force hide
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
  /** Activity-linked dock (phase 4): start as the compact yellow bar. */
  collapsed?: boolean;
  /** The collapsed bar's Answer / a click on it (the controller decides how to open). */
  onAnswer?: () => void;
  /** The user collapsed / expanded the panel (its chevron) — the controller remembers it. */
  onCollapseChange?: (collapsed: boolean) => void;
  /** Phase 6 (appModal): the user confirmed Force hide. Resolves true when the server released it. */
  onForceHide?: () => Promise<boolean>;
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
  /** Collapse to / expand from the compact bar (activity-linked panels). */
  setCollapsed?(c: boolean): void;
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
  /** Where the collapsed state of in-window panels is kept (per tab). Optional. */
  collapseMemory?: CollapseMemory;
  /** Phase 6: ask the server to release an app desktop modal (force-hidden). */
  forceHide?(id: string): Promise<boolean>;
  /** Clock (tests). */
  now?(): number;
  /** Pending-dialogue markers: count per minimized view / per workspace. */
  setMarkers(byView: ReadonlyMap<string, number>, byWorkspace: ReadonlyMap<string, number>): void;
}

interface OpenDialog {
  n: Notification;
  intent: DialogIntent;
  placement: Placement;
  mounted: MountedDialog;
  /** The activity-linked compact bar (auto-mounted, collapsed, never blocking). */
  docked?: boolean;
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
  /** Phase 6: sender key → suppressed until (ms), after a force-hide in this tab. */
  private readonly suppressedUntil = new Map<string, number>();
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
      for (const n of snap.items) if (isDesktopDecision(n) || isAppDesktopModal(n)) this.consider(n, 'auto');
    }
    for (const ch of changes) {
      const n = this.items.get(ch.id);
      // A 'gone' removal is a lock wipe / an item hidden from a locked view: instant.
      if (ch.kind === 'removed' || !n || n.state !== 'active') { this.close(ch.id, ch.kind === 'removed' && ch.reason === 'gone'); continue; }
      if (ch.kind === 'added') {
        // Forced dialogues open on arrival; a desktop decision also after a
        // reload (it must be answered).
        if (ch.source === 'live' || isDesktopDecision(n) || isAppDesktopModal(n)) this.consider(n, 'auto');
      } else {
        const o = this.open.get(n.id);
        // Phase 6: released server-side (revoked / force-hidden / admin): stop blocking NOW.
        if (o && o.placement.kind === 'appModal' && !isAppDesktopModal(n)) { this.close(n.id, true); this.later.add(n.id); continue; }
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
    if (!n || n.state !== 'active') return false;
    // An activity-linked banner (any type) expands in place.
    if (!(n.type === 'dialogue' || hasFormFields(n)) && !this.open.get(id)?.docked) return false;
    this.later.delete(id);
    const o = this.open.get(id);
    if (o) {
      // The docked bar of a BLOCKING dialogue becomes the real (blocking) one.
      if (o.docked && n.blocking && n.type === 'dialogue') {
        o.mounted.dispose({ instant: true });
        this.open.delete(id);
      } else {
        o.docked = false;
        this.memory.set(id, false);
        o.mounted.setCollapsed?.(false);
        o.mounted.focus();
        return true;
      }
    }
    const ctx = windowContext(n);
    const view = ctx ? this.host.viewDetail(ctx) : null;
    const p = decidePlacement(n, { intent: 'user', view, phone: this.host.phone(), suppressed: this.isSuppressed(n) });
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

  /**
   * "Go to activity" (list / pop-up): reveal the linked window (the user
   * asked), then open its in-window panel expanded. False when not linked.
   */
  async goToActivity(id: string): Promise<boolean> {
    const n = this.items.get(id);
    if (!n) return false;
    const ctx = windowContext(n);
    if (!ctx || !isActivityLinked(n, (c) => this.host.viewDetail(c))) return false;
    await this.host.reveal(ctx);
    this.onViewsChanged();
    const o = this.open.get(id);
    if (o) {
      if (o.docked && n.blocking && n.type === 'dialogue') return this.answer(id);
      o.docked = false;
      this.memory.set(id, false);
      o.mounted.setCollapsed?.(false);
      o.mounted.focus();
      return true;
    }
    if (n.type === 'dialogue' || hasFormFields(n)) return this.answer(id);
    return true;
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
      // A docked bar comes back by itself (ensureDocked); an opened panel re-attaches.
      if (!o.docked && v && v.state !== 'none') this.waiting.set(id, { n: o.n, intent: o.intent });
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
        if (!o.docked) this.waiting.set(id, { n: o.n, intent: o.intent });
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
      if ((isDesktopDecision(n) || isAppDesktopModal(n)) && !this.open.has(n.id)) this.consider(n, 'auto');
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
    return decidePlacement(n, { intent: 'auto', view, phone: this.host.phone(), suppressed: this.isSuppressed(n) }).kind;
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
    const p = decidePlacement(reattach ? { ...n, popup: true } : n, { intent, view, phone: this.host.phone(), suppressed: this.isSuppressed(n) });
    if (p.kind === 'none') return;
    if (p.kind === 'wait') { this.waiting.set(n.id, { n, intent }); return; }
    this.mountFor(n, intent, p);
  }

  private mountFor(n: Notification, intent: DialogIntent, p: Placement): boolean {
    if (p.kind === 'none' || p.kind === 'wait') return false;
    if (this.host.locked()) { this.waiting.set(n.id, { n, intent }); return false; }
    const blocks = (p.kind === 'window' && p.blocking) || (p.kind === 'floating' && !!p.blockViewId);
    const viewId = p.kind === 'window' ? p.viewId : p.kind === 'floating' ? p.blockViewId : undefined;
    const takeFocus = intent === 'user' || p.kind === 'desktop' || p.kind === 'appModal'
      || (blocks && !!viewId && this.host.focusInWindowOrNowhere(viewId));
    // A re-attached (not user-opened) window panel keeps the collapsed state the user left it in.
    const remembered = p.kind === 'window' && intent !== 'user' && !p.blocking ? this.memory.get(n.id) === true : false;
    if (intent === 'user') this.memory.set(n.id, false);
    const mounted = this.host.mount(n, p, {
      takeFocus: takeFocus && !remembered,
      onLater: () => this.putOff(n.id),
      onAnswer: () => { void this.answer(n.id); },
      onCollapseChange: (c) => this.collapseChanged(n.id, c),
      ...(remembered ? { collapsed: true } : {}),
      ...(p.kind === 'appModal' ? { onForceHide: () => this.forceHide(n.id) } : {}),
    });
    if (!mounted) return false;
    this.open.set(n.id, { n, intent, placement: p, mounted, ...(remembered ? { docked: true } : {}) });
    this.waiting.delete(n.id);
    this.refreshMarkers();
    return true;
  }

  private clock(): number { return this.host.now?.() ?? Date.now(); }

  /** Phase 6: is this sender's blocking suppressed in this tab (after a force-hide)? */
  isSuppressed(n: Pick<Notification, 'senderKey'>): boolean {
    const until = this.suppressedUntil.get(n.senderKey);
    if (until === undefined) return false;
    if (until <= this.clock()) { this.suppressedUntil.delete(n.senderKey); return false; }
    return true;
  }

  /**
   * Phase 6: the user confirmed "Force hide" on an app desktop modal (link or
   * the protected shortcut). The blocking goes away at once, whatever the
   * server says; the server releases it (reason force-hidden, the app is
   * told) and it stays a normal dialogue in the list. That sender's modals
   * may not open by themselves in this tab for FORCE_HIDE_SUPPRESS_MS (they
 * wait as pop-ups / in the list; the user opening one still gets the modal).
   */
  async forceHide(id: string): Promise<boolean> {
    const o = this.open.get(id);
    const n = o?.n ?? this.items.get(id);
    if (!n || !isAppDesktopModal(n)) return false;
    this.suppressedUntil.set(n.senderKey, this.clock() + FORCE_HIDE_SUPPRESS_MS);
    this.close(id, false);
    this.later.add(id);
    // Any other blocking modal of the same sender goes too.
    for (const [oid, other] of [...this.open]) {
      if (other.placement.kind === 'appModal' && other.n.senderKey === n.senderKey) { this.close(oid, true); this.later.add(oid); }
    }
    this.refreshMarkers();
    try { return (await this.host.forceHide?.(id)) ?? false; } catch { return false; }
  }

  private putOff(id: string): void {
    const o = this.open.get(id);
    if (!o) return;
    if (!canPutOff(o.placement)) return;   // blocking / desktop decision: only resolving closes it
    // Activity-linked window panel: Later / ✕ collapse it to the yellow bar —
    // it stays until the item is handled.
    if (o.placement.kind === 'window' && o.mounted.setCollapsed && isActivityLinked(o.n, (c) => this.host.viewDetail(c))) {
      o.mounted.setCollapsed(true);
      o.docked = true;
      this.memory.set(id, true);
      return;
    }
    o.mounted.dispose();
    this.open.delete(id);
    this.later.add(id);
    this.refreshMarkers();
  }

  /** The user toggled the panel's chevron: remember it; a collapsed one is the docked bar. */
  private collapseChanged(id: string, collapsed: boolean): void {
    this.memory.set(id, collapsed);
    const o = this.open.get(id);
    if (o) o.docked = collapsed;
  }

  private get memory(): CollapseMemory {
    return (this.host.collapseMemory ??= new CollapseMemory());
  }

  private close(id: string, instant = false): void {
    this.memory.clear(id);
    const o = this.open.get(id);
    if (o) { try { o.mounted.dispose({ instant }); } catch { /* ignore */ } this.open.delete(id); }
    this.waiting.delete(id);
    this.later.delete(id);
  }

  /**
   * Markers: every activity-linked item counts for its window (title-bar
   * badge, minimized-strip chip) and, when the window is on another
   * workspace, for that workspace (pill / ‹ › arrows). Also docks the
   * compact bars into visible windows.
   */
  private refreshMarkers(): void {
    const lc = linkCounts([...this.items.values()], (c) => this.host.viewDetail(c));
    this.linkedIds = lc.idsByView;
    this.host.setMarkers(lc.byView, lc.byWorkspace);
    this.ensureDocked();
  }

  private linkedIds = new Map<string, string[]>();
  /** Linked item ids of a window (badge click). */
  linkedFor(viewId: string): string[] { return [...(this.linkedIds.get(viewId) ?? [])]; }

  /**
   * Activity-linked items always have a panel in their visible window
   * (desktop): the compact yellow bar unless opened. Never while locked.
   */
  private ensureDocked(): void {
    if (this.docking || this.disposed || this.host.locked() || this.host.phone()) return;
    this.docking = true;
    try {
      for (const n of this.items.values()) {
        if (this.open.has(n.id) || this.waiting.has(n.id)) continue;
        const v = linkedView(n, (c) => this.host.viewDetail(c));
        if (!v || v.state !== 'visible') continue;
        // Collapsed unless the user expanded it before (remembered per tab).
        // (A blocking dialogue always docks as the bar: blocking starts with Answer.)
        const asBar = (this.memory.get(n.id) ?? true) || (n.blocking && n.type === 'dialogue');
        const mounted = this.host.mount(n, { kind: 'window', viewId: v.viewId, blocking: false, layout: 'panel' }, {
          takeFocus: false, collapsed: asBar,
          onLater: () => this.putOff(n.id),
          onAnswer: () => { void this.answer(n.id); },
          onCollapseChange: (c) => this.collapseChanged(n.id, c),
        });
        if (mounted) this.open.set(n.id, { n, intent: 'auto', placement: { kind: 'window', viewId: v.viewId, blocking: false, layout: 'panel' }, mounted, docked: asBar });
      }
    } finally { this.docking = false; }
  }
  private docking = false;
}
