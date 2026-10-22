/**
 * DesktopDecision — the desktop-wide modal for AuraOS system decisions
 * (phase 4; `scope:'desktop'`, which the core keeps only for SYSTEM_CALLER).
 *
 * Built on the lock-screen template (LockScreenOverlay.astro): body root,
 * z-index 1900 — above every shell surface, below the lock screen (2000).
 *   - everything else on the page is `inert` while it is up (Dock, windows,
 *     their iframes), so focus and clicks cannot leave it;
 *   - capture-phase keydown / mousedown / touchstart guards swallow input
 *     aimed outside it (belt and braces next to `inert`);
 *   - `document.activeElement` is blurred (pulls focus out of app iframes)
 *     and the modal is focused.
 * It closes only by being resolved (or removed by AuraOS) — no Later, no
 * Escape. The controller suspends it while the screen is locked.
 */
import type { Notification } from '../../../lib/notifications/api.ts';
import type { MountedDialog } from '../../../lib/notifications/dialogs.ts';
import type { AppLookup } from '../../../lib/notifications/format.ts';
import type { CardActions } from './NotificationCard.ts';
import { buildDialogFrame, focusFirst } from './DialogFrame.ts';

export interface DesktopDecisionOptions {
  actions: CardActions;
  appLookup?: AppLookup;
}

/** Make every body child except `keep` inert; returns the restore. */
function inertSiblings(keep: Element[]): () => void {
  const changed: HTMLElement[] = [];
  for (const child of Array.from(document.body.children)) {
    if (!(child instanceof HTMLElement)) continue;
    if (keep.includes(child) || child.tagName === 'SCRIPT' || child.tagName === 'STYLE') continue;
    if (child.inert) continue;
    child.inert = true;
    child.dataset['ntfDecisionInert'] = 'true';
    changed.push(child);
  }
  return () => {
    for (const c of changed) {
      if (c.dataset['ntfDecisionInert'] === 'true') { c.inert = false; delete c.dataset['ntfDecisionInert']; }
    }
  };
}

export function mountDesktopDecision(n: Notification, opts: DesktopDecisionOptions): MountedDialog {
  const overlay = document.createElement('div');
  overlay.className = 'aura-dlg-desktop';
  overlay.setAttribute('data-ntf-decision', n.id);
  // Select / combobox lists open inside the overlay: its siblings are inert.
  overlay.dataset['ntfPopupHost'] = 'true';
  const frame = buildDialogFrame(n, {
    actions: opts.actions,
    ...(opts.appLookup ? { appLookup: opts.appLookup } : {}),
    takeFocus: true,
    modal: true,
    kicker: 'AuraOS decision',
  });
  frame.root.classList.add('aura-dlg-decision');
  overlay.appendChild(frame.root);
  // Mark the overlay itself too: it covers the whole screen.
  overlay.classList.add('aura-dlg');
  overlay.dataset['open'] = 'true';
  document.body.appendChild(overlay);

  const lock = document.getElementById('lockscreen');
  const restoreInert = inertSiblings([overlay, ...(lock ? [lock] : []), ...Array.from(document.querySelectorAll('.aura-dlg-desktop')).filter((e) => e !== overlay)]);

  const inside = (e: Event) => {
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    return path.includes(overlay) || (!!lock && path.includes(lock));
  };
  const guard = (e: Event) => {
    if (inside(e)) return;
    e.preventDefault();
    e.stopPropagation();
  };
  const trapTab = (e: KeyboardEvent) => {
    if (e.key !== 'Tab' || !overlay.contains(document.activeElement)) return;
    const f = [...overlay.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]')]
      .filter((x) => x.offsetParent !== null);
    if (!f.length) return;
    const first = f[0]!;
    const last = f[f.length - 1]!;
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  window.addEventListener('keydown', guard, { capture: true });
  window.addEventListener('mousedown', guard, { capture: true });
  window.addEventListener('touchstart', guard, { capture: true, passive: false });
  overlay.addEventListener('keydown', trapTab);

  try { (document.activeElement as HTMLElement | null)?.blur?.(); } catch { /* ignore */ }
  if (!focusFirst(frame.root)) frame.root.focus({ preventScroll: true });

  let disposed = false;
  return {
    update: (next) => frame.update(next),
    focus: () => frame.focus(),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      window.removeEventListener('keydown', guard, { capture: true });
      window.removeEventListener('mousedown', guard, { capture: true });
      window.removeEventListener('touchstart', guard, { capture: true });
      overlay.removeEventListener('keydown', trapTab);
      frame.dispose();
      restoreInert();
      overlay.remove();
    },
  };
}
