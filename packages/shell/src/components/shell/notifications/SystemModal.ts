/**
 * SystemModal — the desktop-wide modal for AuraOS system decisions
 * (phase 4; `scope:'system'`, which the core keeps only for SYSTEM_CALLER).
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
 *
 * Phase 6 — APP system modals (`systemModal`, granted notifications.systemModal)
 * use the same blocking shell, but are visibly NOT AuraOS: an identity bar
 * "Requested by <App>" with its glyph and verified / unverified attribution,
 * a different frame colour, and an always-available "Hide this dialogue"
 * link (plus the protected shortcut Ctrl+Alt+Shift+Escape, caught here in
 * the capture phase before anything else) behind a confirm: "Hide this
 * dialogue from <App>? The app will be told." Force hide releases the
 * blocking; the item stays a normal dialogue in the list. AuraOS's own
 * decisions have none of this.
 */
import type { Notification } from '../../../lib/notifications/api.ts';
import type { MountedDialog } from '../../../lib/notifications/dialogs.ts';
import type { AppLookup } from '../../../lib/notifications/format.ts';
import type { CardActions } from './NotificationCard.ts';
import { buildDialogFrame, focusFirst } from './DialogFrame.ts';
import { createConfirmInline, type ConfirmInline } from './ConfirmInline.ts';
import { senderLabel } from '../../../lib/notifications/format.ts';
import { isForceHideShortcut } from '../../../lib/notifications/dialogs.ts';

export interface SystemModalOptions {
  actions: CardActions;
  appLookup?: AppLookup;
  /** Phase 6: an app-requested modal — identity bar + Force hide (resolves true when released). */
  systemModal?: { onForceHide: () => Promise<boolean> };
}

export const FORCE_HIDE_SHORTCUT_LABEL = 'Ctrl+Alt+Shift+Esc';

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

export function mountSystemModal(n: Notification, opts: SystemModalOptions): MountedDialog {
  const overlay = document.createElement('div');
  overlay.className = 'aura-dlg-system';
  overlay.setAttribute('data-ntf-decision', n.id);
  // Select / combobox lists open inside the overlay: its siblings are inert.
  overlay.dataset['ntfPopupHost'] = 'true';
  const app = opts.systemModal;
  const frame = buildDialogFrame(n, {
    actions: opts.actions,
    ...(opts.appLookup ? { appLookup: opts.appLookup } : {}),
    takeFocus: true,
    modal: true,
    kicker: app ? 'Requested by' : 'AuraOS decision',
  });
  frame.root.classList.add(app ? 'aura-dlg-systemmodal' : 'aura-dlg-decision');
  overlay.dataset['kind'] = app ? 'app' : 'auraos';
  let confirm: ConfirmInline | null = null;
  let hideLink: HTMLButtonElement | null = null;
  const sender = senderLabel(n, opts.appLookup);
  if (app) {
    // Identity first: who asks (never AuraOS styling), and the way out.
    const bar = document.createElement('div');
    bar.className = 'aura-dlg-appbar';
    const glyph = document.createElement('span');
    glyph.className = 'aura-dlg-appbar-glyph';
    glyph.setAttribute('aria-hidden', 'true');
    glyph.textContent = sender.glyph;
    const who = document.createElement('span');
    who.className = 'aura-dlg-appbar-who';
    who.append('Requested by ');
    const b = document.createElement('b');
    b.textContent = sender.label;
    who.appendChild(b);
    const att = document.createElement('span');
    att.className = 'aura-dlg-appbar-att';
    att.dataset['verified'] = String(!sender.unverified);
    att.textContent = sender.unverified ? 'unverified' : 'verified app';
    att.title = sender.unverified ? 'The sender identity is not verified' : 'Sent by a verified app — not AuraOS';
    hideLink = document.createElement('button');
    hideLink.type = 'button';
    hideLink.className = 'aura-dlg-forcehide';
    hideLink.textContent = 'Hide this dialogue';
    hideLink.title = `Force hide (${FORCE_HIDE_SHORTCUT_LABEL}) — it stays in the notification list`;
    hideLink.setAttribute('aria-keyshortcuts', 'Control+Alt+Shift+Escape');
    bar.append(glyph, who, att, hideLink);
    frame.root.prepend(bar);
    hideLink.addEventListener('click', () => askHide());
  }
  function askHide(): void {
    if (!app || confirm) { confirm?.focus(); return; }
    confirm = createConfirmInline({
      message: `Hide this dialogue from ${sender.label}? The app will be told; it stays in your notification list.`,
      confirmLabel: 'Hide',
      onConfirm: async () => {
        const ok = await app.onForceHide();
        return ok || true;   // the blocking is released locally either way
      },
      onCancel: () => { confirm?.el.remove(); confirm?.dispose(); confirm = null; hideLink?.focus({ preventScroll: true }); },
    });
    confirm.el.classList.add('aura-dlg-forcehide-confirm');
    frame.root.querySelector('.aura-dlg-appbar')?.after(confirm.el);
    confirm.focus();
  }
  overlay.appendChild(frame.root);
  // Mark the overlay itself too: it covers the whole screen.
  overlay.classList.add('aura-dlg');
  overlay.dataset['open'] = 'true';
  document.body.appendChild(overlay);

  const lock = document.getElementById('lockscreen');
  const restoreInert = inertSiblings([overlay, ...(lock ? [lock] : []), ...Array.from(document.querySelectorAll('.aura-dlg-system')).filter((e) => e !== overlay)]);

  const inside = (e: Event) => {
    const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
    return path.includes(overlay) || (!!lock && path.includes(lock));
  };
  const guard = (e: Event) => {
    // Phase 6: the protected force-hide shortcut wins over everything (apps never see it).
    if (app && e.type === 'keydown' && isForceHideShortcut(e as KeyboardEvent)) {
      e.preventDefault();
      e.stopPropagation();
      askHide();
      return;
    }
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
      confirm?.dispose();
      frame.dispose();
      restoreInert();
      overlay.remove();
    },
  };
}
