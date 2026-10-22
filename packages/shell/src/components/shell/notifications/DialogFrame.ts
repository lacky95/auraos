/**
 * The frame every notification dialogue shares (window overlay, floating,
 * phone sheet / full view, desktop decision): a bar with the sender, an
 * optional collapse toggle and a ✕ close ("answer later"), and the NotificationCard in
 * 'dialog' mode as its body.
 *
 * Focus: `takeFocus` moves focus to the first field (else the primary
 * button) and remembers where it was; `dispose()` gives it back when focus
 * was still inside. Without `takeFocus` nothing is focused — forced pop-ups
 * never steal the keyboard.
 *
 * Every root carries `aura-dlg` + `data-open="true"` while shown — the
 * native-surface occlusion check (lib/nativeSurface.ts) keys on that.
 */
import type { Notification } from '../../../lib/notifications/api.ts';
import { senderLabel, type AppLookup } from '../../../lib/notifications/format.ts';
import { renderNotificationCard, updateNotificationCard, spriteIcon, type CardActions } from './NotificationCard.ts';
import { CLOSE_LATER } from '../../../lib/notifications/dialogs.ts';
import { ExitMachine } from '../../../lib/notifications/exit.ts';

/**
 * Exit animation (slide right + fade, NotificationStyles `[data-exit]`),
 * then `remove()`. Instant for lock / wipe. A second call while exiting is
 * ignored; `animationend` or the fallback timeout finishes it.
 */
export function playExit(el: HTMLElement, remove: () => void, opts: { instant?: boolean } = {}): void {
  const m = ((el as HTMLElement & { __exit?: ExitMachine }).__exit ??= new ExitMachine());
  const started = m.hide(() => { el.removeEventListener('animationend', onEnd); remove(); }, opts);
  if (!started || m.state !== 'exiting') return;
  el.dataset['exit'] = 'true';
  el.dataset['open'] = 'false';
  function onEnd(e: AnimationEvent) { if (e.target === el) m.end(); }
  el.addEventListener('animationend', onEnd);
}

export interface FrameOptions {
  actions: CardActions;
  appLookup?: AppLookup;
  /** Shows the header ✕ "Close (answer later)" (Escape does the same). Absent: no ✕. */
  onLater?: () => void;
  /** Adds a collapse-to-bar toggle (non-blocking window panel). */
  collapsible?: boolean;
  /** aria-modal (blocking / desktop / full view). */
  modal?: boolean;
  /** Label before the sender, e.g. "Question" / "AuraOS decision". */
  kicker?: string;
  takeFocus: boolean;
}

export interface DialogFrame {
  root: HTMLElement;
  update(n: Notification): void;
  focus(): void;
  setCollapsed(c: boolean): void;
  /** Remove listeners; restore focus if it was inside. Does not detach `root`. */
  dispose(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** First field, else the primary button, else any control. */
export function focusFirst(root: HTMLElement): boolean {
  const target = root.querySelector<HTMLElement>('.aura-ntf-body input:not([disabled]), .aura-ntf-body textarea:not([disabled]), .aura-ntf-body [data-ntf-field]:not(:disabled)')
    ?? root.querySelector<HTMLElement>('.aura-ntf-btn[data-variant="primary"]:not(:disabled)')
    ?? root.querySelector<HTMLElement>('button:not(:disabled), input, textarea, [tabindex="0"]');
  if (!target) return false;
  target.focus({ preventScroll: true });
  return true;
}

export function buildDialogFrame(n: Notification, opts: FrameOptions): DialogFrame {
  const root = el('section', 'aura-dlg');
  root.dataset['id'] = n.id;
  root.dataset['open'] = 'true';
  root.setAttribute('role', opts.modal ? 'alertdialog' : 'dialog');
  root.setAttribute('aria-modal', String(!!opts.modal));
  root.tabIndex = -1;

  const bar = el('header', 'aura-dlg-bar');
  const kicker = el('span', 'aura-dlg-kicker');
  const label = () => `${opts.kicker ?? 'Question'} · ${senderLabel(n, opts.appLookup).label}`;
  kicker.textContent = label();
  bar.appendChild(kicker);
  const barTitle = el('span', 'aura-dlg-bar-title', n.title);
  bar.appendChild(barTitle);

  let collapsed = false;
  let toggle: HTMLButtonElement | null = null;
  if (opts.collapsible) {
    toggle = el('button', 'aura-dlg-btn');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'true');
    toggle.title = 'Collapse';
    toggle.setAttribute('aria-label', 'Collapse the question');
    toggle.appendChild(spriteIcon('lucide-chevron-down'));
    toggle.addEventListener('click', () => setCollapsed(!collapsed));
    bar.appendChild(toggle);
  }
  if (opts.onLater) {
    // Window-style close, top-right in the header — never in the sender's button row.
    const later = el('button', 'aura-dlg-btn aura-dlg-close');
    later.type = 'button';
    later.dataset['action'] = 'later';
    later.setAttribute('aria-label', CLOSE_LATER.label);
    later.title = CLOSE_LATER.title;
    later.appendChild(spriteIcon('lucide-x'));
    later.addEventListener('click', () => opts.onLater?.());
    bar.appendChild(later);
  }
  root.appendChild(bar);

  const body = el('div', 'aura-dlg-body');
  const cardOpts = {
    mode: 'dialog' as const, actions: opts.actions, ...(opts.appLookup ? { appLookup: opts.appLookup } : {}), expanded: true,
    // The card's Later button = the header ✕ (only where it can be put off).
    ...(opts.onLater ? { onLater: () => opts.onLater?.() } : {}),
  };
  let card = renderNotificationCard(n, cardOpts);
  body.appendChild(card);
  root.appendChild(body);
  const linkTitle = () => {
    const t = card.querySelector<HTMLElement>('.aura-ntf-title');
    if (t?.id) root.setAttribute('aria-labelledby', t.id);
  };
  linkTitle();

  function setCollapsed(c: boolean) {
    collapsed = c;
    root.dataset['collapsed'] = String(c);
    body.hidden = c;
    if (toggle) {
      toggle.setAttribute('aria-expanded', String(!c));
      toggle.title = c ? 'Expand' : 'Collapse';
      toggle.setAttribute('aria-label', c ? 'Expand the question' : 'Collapse the question');
      toggle.replaceChildren(spriteIcon(c ? 'lucide-chevron-up' : 'lucide-chevron-down'));
    }
  }
  // Clicking the collapsed bar expands it.
  bar.addEventListener('click', (e) => {
    if (!collapsed || (e.target as HTMLElement).closest('button')) return;
    setCollapsed(false);
  });

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    // Inner menus / confirms handle their own Escape first.
    if ((e.target as HTMLElement | null)?.closest('[data-own-escape]')) return;
    if (opts.onLater) {
      e.preventDefault();
      e.stopPropagation();
      opts.onLater();
    }
  };
  root.addEventListener('keydown', onKey);

  const returnTo = opts.takeFocus ? (document.activeElement as HTMLElement | null) : null;
  let disposed = false;

  return {
    root,
    update(next: Notification) {
      n = next;
      kicker.textContent = label();
      barTitle.textContent = next.title;
      card = updateNotificationCard(card, next, cardOpts);
      linkTitle();
    },
    focus() {
      if (collapsed) setCollapsed(false);
      if (!focusFirst(root)) root.focus({ preventScroll: true });
    },
    setCollapsed,
    dispose() {
      if (disposed) return;
      disposed = true;
      root.removeEventListener('keydown', onKey);
      root.dataset['open'] = 'false';
      const hadFocus = root.contains(document.activeElement);
      if (hadFocus && returnTo && returnTo.isConnected && returnTo !== document.body) {
        try { returnTo.focus({ preventScroll: true }); } catch { /* ignore */ }
      } else if (hadFocus) {
        (document.activeElement as HTMLElement | null)?.blur?.();
      }
    },
  };
}
