/**
 * WindowDialog — a dialogue over ITS OWN window (phase 4).
 *
 * Lives in the window's `.slot-body` (`position:relative`) in a per-slot
 * host (`.aura-dlg-host`, `position:absolute; inset:0; z-index:10` — above
 * the loading skeleton's 5). The title bar is outside, so the window can
 * always be closed, moved and minimized.
 *
 *   non-blocking  a panel docked at the bottom, collapsible to a bar; the
 *                 host lets clicks through, so the app above stays usable.
 *                 "Later" / Escape hide it (it stays in the list).
 *   blocking      a dimmed full cover; the window's iframe is `inert` and
 *                 blurred if it had focus. No "Later". `inert` is removed
 *                 when the dialogue is resolved / removed / detached, and
 *                 the whole host goes with a destroyed slot.
 *
 * Several dialogues for one window stack in the same host; `inert` is
 * reference-counted per iframe (`lockWindowFrame`).
 */
import type { Notification } from '../../../lib/notifications/api.ts';
import type { MountedDialog } from '../../../lib/notifications/dialogs.ts';
import type { AppLookup } from '../../../lib/notifications/format.ts';
import type { CardActions } from './NotificationCard.ts';
import { buildDialogFrame, focusFirst, playExit } from './DialogFrame.ts';

const inertCount = new WeakMap<HTMLIFrameElement, number>();

/**
 * Make the window's iframe inert until the returned release runs (ref-counted).
 * Blurs the iframe when it has focus, so typing stops reaching the app.
 */
export function lockWindowFrame(slot: HTMLElement): () => void {
  const frame = slot.querySelector<HTMLIFrameElement>('.slot-body iframe, iframe');
  if (!frame) return () => {};
  const n = (inertCount.get(frame) ?? 0) + 1;
  inertCount.set(frame, n);
  if (n === 1) {
    frame.inert = true;
    frame.setAttribute('data-ntf-inert', 'true');
    if (document.activeElement === frame) frame.blur();
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (inertCount.get(frame) ?? 1) - 1;
    if (left <= 0) {
      inertCount.delete(frame);
      frame.inert = false;
      frame.removeAttribute('data-ntf-inert');
    } else {
      inertCount.set(frame, left);
    }
  };
}

/** The slot's dialogue host (created on demand). */
function hostOf(slot: HTMLElement): HTMLElement | null {
  const body = slot.querySelector<HTMLElement>(':scope > .slot-body') ?? slot.querySelector<HTMLElement>('.slot-body');
  if (!body) return null;
  let host = body.querySelector<HTMLElement>(':scope > .aura-dlg-host');
  if (!host) {
    host = document.createElement('div');
    host.className = 'aura-dlg-host';
    body.appendChild(host);
  }
  return host;
}

function syncHost(host: HTMLElement): void {
  const blocking = host.querySelector(':scope > [data-blocking="true"]') !== null
    || host.dataset['covers'] !== undefined && Number(host.dataset['covers']) > 0;
  host.dataset['blocking'] = String(blocking);
  // The blocking cover itself occludes native surfaces over this window.
  host.classList.toggle('aura-dlg', blocking);
  if (blocking) host.dataset['open'] = 'true'; else delete host.dataset['open'];
  if (!host.childElementCount && !Number(host.dataset['covers'] ?? 0)) host.remove();
}

/**
 * Phone: the dialogue is a sheet at body level, but a blocking one still
 * covers + inerts its window behind it. Returns the release.
 */
export function coverWindow(slot: HTMLElement): () => void {
  const host = hostOf(slot);
  if (!host) return () => {};
  host.dataset['covers'] = String(Number(host.dataset['covers'] ?? 0) + 1);
  syncHost(host);
  const unlock = lockWindowFrame(slot);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    unlock();
    const left = Math.max(0, Number(host.dataset['covers'] ?? 1) - 1);
    if (left) host.dataset['covers'] = String(left); else delete host.dataset['covers'];
    syncHost(host);
  };
}

/**
 * The yellow title-bar badge of a window with activity-linked items
 * (count; `unseen` adds a glow, a rise in count pulses once). Created at
 * runtime in `.slot-controls`; styled by NotificationStyles (is:global) with
 * a selector that outranks the chrome's `.app-slot .slot-controls button`.
 */
export function syncWindowBadge(slot: HTMLElement, count: number, opts: { unseen?: boolean; hint?: string; onClick?: () => void } = {}): HTMLButtonElement | null {
  const controls = slot.querySelector<HTMLElement>(':scope > .slot-chrome .slot-controls');
  let badge = controls?.querySelector<HTMLButtonElement>(':scope > .aura-ntf-win-badge') ?? null;
  if (count <= 0) {
    delete slot.dataset['ntfLinked'];
    badge?.remove();
    return null;
  }
  slot.dataset['ntfLinked'] = String(count);
  if (!controls) return null;
  if (!badge) {
    badge = document.createElement('button');
    badge.type = 'button';
    badge.className = 'aura-ntf-win-badge';
    badge.dataset['tone'] = 'warning';
    badge.addEventListener('click', (e) => { e.stopPropagation(); (badge as HTMLButtonElement & { __onClick?: () => void }).__onClick?.(); });
    controls.prepend(badge);
  }
  (badge as HTMLButtonElement & { __onClick?: () => void }).__onClick = opts.onClick;
  const prev = Number(badge.textContent || '0');
  badge.textContent = String(count);
  if (opts.hint) { badge.title = opts.hint; badge.setAttribute('aria-label', opts.hint); }
  if (opts.unseen) badge.dataset['unseen'] = 'true'; else delete badge.dataset['unseen'];
  if (count > prev) {
    // One gentle pulse on arrival (CSS; none under reduced motion).
    delete badge.dataset['pulse'];
    void badge.offsetWidth;
    badge.dataset['pulse'] = 'true';
    badge.addEventListener('animationend', () => { delete badge!.dataset['pulse']; }, { once: true });
  }
  return badge;
}

export interface WindowDialogOptions {
  /** Activity-linked: start as the compact yellow bar (phase 4). */
  collapsed?: boolean;
  onAnswer?: () => void;
  onCollapseChange?: (collapsed: boolean) => void;
  blocking: boolean;
  takeFocus: boolean;
  actions: CardActions;
  appLookup?: AppLookup;
  onLater: () => void;
}

export function mountWindowDialog(slot: HTMLElement, n: Notification, opts: WindowDialogOptions): MountedDialog | null {
  const host = hostOf(slot);
  if (!host) return null;
  const frame = buildDialogFrame(n, {
    actions: opts.actions,
    ...(opts.appLookup ? { appLookup: opts.appLookup } : {}),
    takeFocus: opts.takeFocus,
    modal: opts.blocking,
    collapsible: !opts.blocking,
    ...(opts.blocking ? {} : { onLater: opts.onLater }),
    ...(opts.onAnswer ? { onAnswer: opts.onAnswer } : {}),
    ...(opts.onCollapseChange ? { onCollapseChange: opts.onCollapseChange } : {}),
    // A panel inside its own window is always activity-linked: yellow accent.
    linked: true,
    kicker: opts.blocking ? 'Answer to continue' : n.type === 'dialogue' ? 'Question' : 'Notification',
  });
  if (opts.collapsed) frame.setCollapsed(true);
  frame.root.classList.add('aura-dlg-window');
  frame.root.dataset['blocking'] = String(opts.blocking);
  host.appendChild(frame.root);
  syncHost(host);
  const unlock = opts.blocking ? lockWindowFrame(slot) : () => {};
  if (opts.takeFocus) focusFirst(frame.root) || frame.root.focus({ preventScroll: true });

  let disposed = false;
  return {
    update: (next) => frame.update(next),
    focus: () => frame.focus(),
    setCollapsed: (c) => { frame.setCollapsed(c); if (!c) focusFirst(frame.root); },
    dispose: (o) => {
      if (disposed) return;
      disposed = true;
      // Focus and inert come back right away; the panel then slides out.
      frame.dispose();
      unlock();
      frame.root.dataset['blocking'] = 'false';
      if (host.isConnected) syncHost(host);
      playExit(frame.root, () => { frame.root.remove(); if (host.isConnected) syncHost(host); }, o);
    },
  };
}
