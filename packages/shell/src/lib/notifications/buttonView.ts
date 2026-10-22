/**
 * What the Dock notification button shows (phase 3 design, phase 6
 * extraction) — DOM-free, so the count states, tiers and labels are unit
 * tested. NotificationButton.astro applies it to its elements.
 *
 *   counter   `new/total` (99+ / 999+), the new number glows in the tint of
 *             the highest unseen priority
 *   tier      the ceiling `data-tier-max`: compact on phone width (body px)
 *             and with nothing active; wide (plus the most important item
 *             as "sender: title") otherwise. Dock.fitDockItems steps it down.
 *   label     "Notifications: 1 new, 4 total[. Most important: who — title]"
 *             — the snippet is left out while the screen is locked.
 */
import type { Notification } from './api.ts';
import type { StoreSnapshot } from './store.ts';
import { isUnseen } from './store.ts';

export const PHONE_MAX_WIDTH = 640;

export type ButtonTier = 'compact' | 'wide';

export interface ButtonViewEnv {
  /** `document.body.clientWidth` (not vw: the shell zooms <body>). */
  bodyWidth: number;
  locked: boolean;
  /** Display name of a sender (format.senderLabel(...).label). */
  senderOf: (n: Notification) => string;
}

export interface ButtonView {
  newCount: number;
  /** data-prio: the highest unseen priority, or 'none' with nothing new. */
  prio: string;
  newText: string;
  totalText: string;
  tierMax: ButtonTier;
  /** The wide-tier snippet (most important active item), or null. */
  latest: { text: string; prio: string; unseen: boolean; locked: boolean; pinned: boolean } | null;
  ariaLabel: string;
  title: string;
}

type Snap = Pick<StoreSnapshot, 'unseenCount' | 'totalCount' | 'highestUnseenPriority' | 'mostImportant' | 'error'>;

export function buttonTierMax(snap: Pick<StoreSnapshot, 'mostImportant'> | null, bodyWidth: number): ButtonTier {
  if (bodyWidth < PHONE_MAX_WIDTH) return 'compact';
  return snap?.mostImportant ? 'wide' : 'compact';
}

export function buttonView(snap: Snap, env: ButtonViewEnv): ButtonView {
  const n = snap.unseenCount;
  const t = snap.totalCount;
  const top = snap.mostImportant;
  let topLabel = '';
  let latest: ButtonView['latest'] = null;
  if (top) {
    const who = env.senderOf(top);
    topLabel = `${who} — ${top.title}`;
    latest = { text: `${who}: ${top.title}`, prio: top.priority, unseen: isUnseen(top), locked: top.type === 'locked', pinned: !!top.pinned };
  }
  const showTop = !!top && !env.locked;
  const label = `Notifications: ${n} new, ${t} total`;
  return {
    newCount: n,
    prio: n > 0 ? (snap.highestUnseenPriority ?? 'medium') : 'none',
    newText: n > 99 ? '99+' : String(n),
    totalText: `/${t > 999 ? '999+' : t}`,
    tierMax: buttonTierMax(snap, env.bodyWidth),
    latest,
    ariaLabel: showTop ? `${label}. Most important: ${topLabel}` : label,
    title: snap.error ? `Notifications unavailable: ${snap.error.message}`
      : showTop ? `${n} new · ${t} total\nMost important: ${topLabel}` : `${n} new · ${t} total`,
  };
}
