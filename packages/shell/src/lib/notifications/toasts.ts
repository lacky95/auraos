/**
 * Pop-up (toast) policy — DOM-free, so any surface can reuse it.
 *
 *   - at most MAX_TOASTS at once;
 *   - duration (`toastDuration`, null = stays):
 *       `popupDurationMs` > 0      → that long (the item stays in the list)
 *       `popupDurationMs` 0 / -1   → a STICKY pop-up: stays until dismissed,
 *                                    opened, answered, removed or expired
 *       absent                     → the default: until the notification's own
 *                                    expiry when `timeoutMs` is set, else 8 s for
 *                                    low / medium; high / urgent stay until
 *                                    handled or pushed out
 *   - when full: a new low / medium one goes only to the list; a new high /
 *     urgent one pushes out the oldest NON-STICKY pop-up (low / medium
 *     first). Sticky pop-ups are never pushed out; with three sticky ones,
 *     new items go to the list only.
 */
import type { Notification } from './api.ts';
import { planCardUpdate } from './cardPatch.ts';
import { hasFormFields } from './dialogs.ts';

export const MAX_TOASTS = 3;
export const DEFAULT_TOAST_MS = 8_000;
/** Shortest time a pop-up stays, even when the notification expires sooner. */
export const MIN_TOAST_MS = 1_500;

/** High / urgent: by default these stay until handled (and are announced assertively). */
export function isSticky(n: Pick<Notification, 'priority'>): boolean {
  return n.priority === 'high' || n.priority === 'urgent';
}

/** The sender asked for a pop-up that stays (`popupDurationMs` 0 or -1): never pushed out. */
export function isStickyPopup(n: Pick<Notification, 'popupDurationMs'>): boolean {
  return typeof n.popupDurationMs === 'number' && n.popupDurationMs <= 0;
}

type ToastFields = Pick<Notification, 'priority' | 'expiresAt' | 'timeoutMs'> & Partial<Pick<Notification, 'popupDurationMs'>>;

/** Milliseconds until the pop-up hides, or null to stay. */
export function toastDuration(n: ToastFields, now: number = Date.now()): number | null {
  if (typeof n.popupDurationMs === 'number') return n.popupDurationMs > 0 ? n.popupDurationMs : null;
  if (n.expiresAt !== undefined) return Math.max(MIN_TOAST_MS, n.expiresAt - now);
  if (isSticky(n)) return null;
  return DEFAULT_TOAST_MS;
}

export interface Admission {
  admit: boolean;
  /** Id of the visible pop-up to push out first. */
  evict?: string;
}

/**
 * Whether `n` gets a pop-up given the visible ones (oldest first).
 */
type AdmitFields = Pick<Notification, 'id' | 'priority'> & Partial<Pick<Notification, 'popupDurationMs'>>;

export function admitToast(visible: ReadonlyArray<AdmitFields>, n: AdmitFields, max = MAX_TOASTS): Admission {
  if (visible.some((v) => v.id === n.id)) return { admit: false };
  if (visible.length < max) return { admit: true };
  if (!isSticky(n)) return { admit: false };
  // Sticky pop-ups are never pushed out: the oldest non-sticky low / medium,
  // else the oldest non-sticky one; none → the list only.
  const evictable = visible.filter((v) => !isStickyPopup(v));
  const victim = evictable.find((v) => !isSticky(v)) ?? evictable[0];
  return victim ? { admit: true, evict: victim.id } : { admit: false };
}

/**
 * A click on a pop-up acknowledges it (phase 4, the user's final rules): it
 * is marked seen at once (the Dock count drops). Hovering never marks it.
 *   body, no dialogue and no form (inputs / options; buttons alone are not
 *        a form): seen, and ONLY this pop-up hides. The list does not open.
 *   body, a Dialogue or a pop-up with a form: seen, it opens as a dialogue
 *        (a Simple one as a floating dialogue / sheet from its card) with
 *        focus in its first field or primary button, and the pop-up closes.
 *   button  seen; the button does its own thing.
 *   link / field / menu   handled by the control; nothing extra.
 *   ✕ (hide)  never reaches this: it hides and keeps the item UNREAD.
 * Sticky pop-ups follow the same rules.
 */
export type ToastClickTarget = 'body' | 'button' | 'link' | 'field' | 'menu';
/**
 * `activate` (user's rule, supersedes "open as a dialogue"): a Dialogue or
 * form pop-up stays IN PLACE and becomes the active surface — expanded,
 * focused (first field / primary button), timer stopped, never evicted.
 * It ends only on submit / cancel success, ✕ / Later / Escape, resolved /
 * removed elsewhere, the list opening, or a lock.
 */
export interface ToastClickEffect { markSeen: boolean; activate: boolean; hide: boolean }
export function toastClickEffect(n: Pick<Notification, 'type' | 'components'>, target: ToastClickTarget): ToastClickEffect {
  const form = n.type === 'dialogue' || hasFormFields(n);
  // Phase 6 fix: the FIRST click on any control of a dialogue / form pop-up
  // (chip, radio, checkbox, select, combobox, input, button, menu) activates
  // it too — timer stopped, marked seen, never evicted — without moving focus
  // (the control keeps it). Before, a field click left the timer running, so
  // the pop-up could time out while the user was still picking.
  if (form && target !== 'link') return { markSeen: true, activate: true, hide: false };
  if (target === 'button') return { markSeen: true, activate: false, hide: false };
  if (target !== 'body') return { markSeen: false, activate: false, hide: false };
  return { markSeen: true, activate: false, hide: true };
}

/** Does the user's own interaction belong to an active pop-up (never evicted / hidden by arrivals)? */
export function admissionItem<T extends Pick<Notification, 'id' | 'priority'> & { popupDurationMs?: number }>(n: T, active: boolean): T {
  // An active pop-up holds its slot like a sticky one: never pushed out.
  return active ? { ...n, popupDurationMs: 0 } : n;
}

/**
 * Hide a pop-up because its item became seen? Only when that happened
 * ELSEWHERE (another tab / surface) and the pop-up is not active — this
 * tab's own click / button already decided what happens to it.
 */
export function hidesOnSeen(t: { active: boolean; seenHere: boolean }): boolean {
  return !t.active && !t.seenHere;
}

/**
 * The pop-up ✕ hides it for this tab and keeps the item unread. A hidden
 * pop-up comes back only for a genuine sender update (newer `updatedAt`,
 * a visible change — not the echo of the user's own interaction) of a
 * high / urgent item.
 */
export function mayReshowHidden(hidden: Notification, next: Notification): boolean {
  if (next.updatedAt <= hidden.updatedAt) return false;
  if (!isSticky(next)) return false;
  return planCardUpdate(hidden, next) !== 'none';
}

// ---------------------------------------------------------------------------
// Hide animation (phase 4)
// ---------------------------------------------------------------------------

/** Why a pop-up hides. */
export type ToastHideReason =
  | 'click' | 'close' | 'timeout' | 'dialog' | 'ended' | 'seen' | 'evicted'
  | 'lock' | 'wipe' | 'list' | 'teardown';

/**
 * Pop-ups slide out like dialogues (exit.ts timing) — except for lock /
 * lock-screen wipe / the list opening / teardown, which hide at once
 * (privacy, and the list takes over).
 */
export function toastHideAnimates(reason: ToastHideReason): boolean {
  return !(reason === 'lock' || reason === 'wipe' || reason === 'list' || reason === 'teardown');
}

/**
 * Slots: a pop-up in its exit still holds its slot (the queue refills only
 * after the exit), but it no longer counts for admission / eviction.
 */
export function slotsUsed(stack: ReadonlyArray<{ exiting: boolean }>): number { return stack.length; }
export function admissionList<T extends { exiting: boolean }>(stack: readonly T[]): T[] { return stack.filter((t) => !t.exiting); }

// ---------------------------------------------------------------------------
// Pending queue (phase 4): overflow waits instead of being dropped
// ---------------------------------------------------------------------------

const PRIO: Record<string, number> = { urgent: 3, high: 2, medium: 1, low: 0 };
/** Stagger between pop-ups when several slots free at once. */
export const QUEUE_STAGGER_MS = 250;
/** On unlock, queued items older than this are dropped (no stale flood). */
export const QUEUE_MAX_AGE_ON_UNLOCK_MS = 60_000;

interface Queued { id: string; rank: number; at: number; seq: number }

/**
 * Per-tab, in-memory queue of live notifications that could not pop up
 * because MAX_TOASTS were showing. They are in the list anyway; the queue
 * only decides what pops up next when a slot frees (✕, click, timeout,
 * resolved / removed / expired). Highest priority first, FIFO within one.
 *   - drop on seen / resolved / removed / lock-hidden (`remove`);
 *   - `clear()` when the list opens — never restored;
 *   - while locked the caller does not pull; on unlock `dropOlderThan`;
 *   - an evicted pop-up and one hidden with ✕ are never (re-)queued.
 */
export class ToastQueue {
  private items: Queued[] = [];
  private seq = 0;
  constructor(private readonly now: () => number = Date.now) {}

  get size(): number { return this.items.length; }
  has(id: string): boolean { return this.items.some((q) => q.id === id); }

  enqueue(n: Pick<Notification, 'id' | 'priority'>): void {
    if (this.has(n.id)) return;
    this.items.push({ id: n.id, rank: PRIO[n.priority] ?? 1, at: this.now(), seq: this.seq++ });
  }

  remove(id: string): void { this.items = this.items.filter((q) => q.id !== id); }
  clear(): void { this.items = []; }

  /** The next id to pop up (removed from the queue), or undefined. */
  next(): string | undefined {
    if (!this.items.length) return undefined;
    let best = 0;
    for (let i = 1; i < this.items.length; i++) {
      const a = this.items[i]!;
      const b = this.items[best]!;
      if (a.rank > b.rank || (a.rank === b.rank && a.seq < b.seq)) best = i;
    }
    return this.items.splice(best, 1)[0]!.id;
  }

  dropOlderThan(ms: number): number {
    const cut = this.now() - ms;
    const before = this.items.length;
    this.items = this.items.filter((q) => q.at >= cut);
    return before - this.items.length;
  }
}

/** Short screen-reader announcement for a new pop-up. */
export function announcement(n: Pick<Notification, 'title' | 'priority'>, sender: string): string {
  const p = n.priority === 'urgent' ? 'Urgent notification' : n.priority === 'high' ? 'Important notification' : 'Notification';
  return `${p} from ${sender}: ${n.title}`;
}
