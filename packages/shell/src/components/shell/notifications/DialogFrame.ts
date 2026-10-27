/**
 * The frame every notification dialogue shares (window overlay, floating,
 * phone sheet / full view, system decision): a bar with the sender, an
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
 *
 * Maximize (phase 6): a ⤢ / ⤡ header button next to the ✕ and
 * Alt+Shift+Enter (focus inside) toggle `data-maximized` — the styles
 * stretch the dialogue over the app area between the top bar and the Dock
 * (system modal, centred and floating dialogues) or over its window body
 * (in-window panel). It starts maximized when the sender set
 * `maximized: true`, unless the user already chose otherwise for that item
 * in this tab (lib/notifications/maximize.ts: the user's choice wins and is
 * remembered; a sender update of the hint applies only without a choice).
 * Hidden and ignored on the phone (`data-phone`).
 * A 150 ms size transition (FLIP), none under reduced motion. Select /
 * combobox popups re-place themselves every frame, so they follow.
 */
import type { Notification } from '../../../lib/notifications/api.ts';
import { senderLabel, type AppLookup } from '../../../lib/notifications/format.ts';
import { renderNotificationCard, updateNotificationCard, spriteIcon, type CardActions } from './NotificationCard.ts';
import { CLOSE_LATER } from '../../../lib/notifications/dialogs.ts';
import { ExitMachine } from '../../../lib/notifications/exit.ts';
import { getMaximizeMemory, initialMaximized, isMaximizeShortcut, MAXIMIZE_ARIA_KEYS, MAXIMIZE_SHORTCUT_LABEL } from '../../../lib/notifications/maximize.ts';
import { PHONE_MAX_WIDTH } from './placement.ts';

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
  /** Collapsed bar's "Answer" / bar click (default: expand in place). */
  onAnswer?: () => void;
  /** Activity-linked panel: yellow accent + badge (phase 4). */
  linked?: boolean;
  /** The USER collapsed / expanded it (chevron, bar, Answer) — not programmatic changes. */
  onCollapseChange?: (collapsed: boolean) => void;
  /** Adds a collapse-to-bar toggle (non-blocking window panel). */
  collapsible?: boolean;
  /** aria-modal (blocking / desktop / full view). */
  modal?: boolean;
  /** Label before the sender, e.g. "Question" / "AuraOS decision". */
  kicker?: string;
  takeFocus: boolean;
  /** Phase 6: the ⤢ maximize button (default true; never on the phone). */
  maximizable?: boolean;
}

export interface DialogFrame {
  root: HTMLElement;
  update(n: Notification): void;
  focus(): void;
  setCollapsed(c: boolean): void;
  /**
   * Phase 6: maximized state (no-op on the phone / when not maximizable).
   * `user` (default true) records it as the user's choice for this item.
   */
  setMaximized(on: boolean, opts?: { animate?: boolean; user?: boolean }): void;
  isMaximized(): boolean;
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
  const target = root.querySelector<HTMLElement>('.aura-ntf-body input:not([disabled]), .aura-ntf-body textarea:not([disabled]):not([readonly]):not([hidden]), .aura-ntf-body [data-ntf-field]:not(:disabled):not([hidden])')
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
  // Compact bar (collapsed): an explicit "Answer" that re-expands it.
  const answerBtn = el('button', 'aura-dlg-btn aura-dlg-answer', 'Answer');
  answerBtn.type = 'button';
  answerBtn.addEventListener('click', (e) => { e.stopPropagation(); expand(); });
  bar.appendChild(answerBtn);
  if (opts.linked) root.dataset['linked'] = 'true';
  if (opts.collapsible) {
    toggle = el('button', 'aura-dlg-btn aura-dlg-toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'true');
    toggle.title = 'Collapse';
    toggle.setAttribute('aria-label', 'Collapse the question');
    toggle.appendChild(spriteIcon('lucide-chevron-down'));
    // The chevron owns its click: nothing above (slot bring-to-front, card
    // activation) may also act on it.
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      if (collapsed) expand();
      else { setCollapsed(true); opts.onCollapseChange?.(true); }
    });
    bar.appendChild(toggle);
  }
  // Phase 6: maximize / restore, right before the ✕.
  const maxMemory = getMaximizeMemory();
  let maxBtn: HTMLButtonElement | null = null;
  let maximized = false;
  if (opts.maximizable !== false) {
    maxBtn = el('button', 'aura-dlg-btn aura-dlg-max');
    maxBtn.type = 'button';
    maxBtn.dataset['action'] = 'maximize';
    maxBtn.setAttribute('aria-keyshortcuts', MAXIMIZE_ARIA_KEYS);
    maxBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMax(); });
    bar.appendChild(maxBtn);
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
  const markMarkdown = () => {
    if ((n.components ?? []).some((c) => c.kind === 'markdown')) root.dataset['hasMarkdown'] = 'true';
    else delete root.dataset['hasMarkdown'];
  };
  markMarkdown();

  const isPhone = () => { try { return document.body.clientWidth < PHONE_MAX_WIDTH; } catch { return false; } };
  const reducedMotion = () => { try { return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
  function paintMax() {
    if (!maxBtn) return;
    const phone = isPhone();
    root.dataset['phone'] = String(phone);
    maxBtn.hidden = phone;
    const on = maximized && !phone;
    if (on) root.dataset['maximized'] = 'true'; else delete root.dataset['maximized'];
    maxBtn.setAttribute('aria-pressed', String(on));
    const tip = on ? 'Restore' : 'Maximize';
    maxBtn.title = `${tip} (${MAXIMIZE_SHORTCUT_LABEL})`;
    maxBtn.setAttribute('aria-label', tip);
    maxBtn.replaceChildren(spriteIcon(on ? 'lucide-minimize' : 'lucide-maximize'));
  }
  function setMaximized(on: boolean, o: { animate?: boolean; user?: boolean } = {}) {
    if (!maxBtn || isPhone()) return;
    if (o.user !== false) maxMemory.set(n.id, on);
    if (on === maximized) return;
    // FLIP: measure, switch, then animate from the old box (150 ms).
    const animate = o.animate !== false && !reducedMotion() && typeof root.animate === 'function' && root.isConnected;
    const before = animate ? root.getBoundingClientRect() : null;
    maximized = on;
    paintMax();
    if (before && before.width > 0 && before.height > 0) {
      const after = root.getBoundingClientRect();
      if (after.width > 0 && after.height > 0) {
        const dx = before.left - after.left;
        const dy = before.top - after.top;
        const sx = before.width / after.width;
        const sy = before.height / after.height;
        try {
          root.animate(
            [{ transformOrigin: 'top left', transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` }, { transformOrigin: 'top left', transform: 'none' }],
            { duration: 150, easing: 'ease-out' },
          );
        } catch { /* ignore */ }
      }
    }
    // Things positioned against the dialogue (select popups re-place every frame; others listen).
    root.dispatchEvent(new CustomEvent('aura:dialog-resize', { bubbles: true, detail: { id: n.id, maximized: on } }));
  }
  function toggleMax() { setMaximized(!maximized); }
  // The user's choice in this tab, else the sender's hint (phase 6).
  maximized = !!maxBtn && initialMaximized(maxMemory.get(n.id), n.maximized);
  paintMax();
  const onResize = () => paintMax();
  if (maxBtn) window.addEventListener('resize', onResize);
  const onMaxKey = (e: KeyboardEvent) => {
    if (!maxBtn || !isMaximizeShortcut(e) || isPhone()) return;
    e.preventDefault();
    e.stopPropagation();
    toggleMax();
  };
  root.addEventListener('keydown', onMaxKey, true);
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
  function expand() {
    // With a controller (onAnswer) it decides — and remembers — how to open.
    if (opts.onAnswer) { opts.onAnswer(); return; }
    setCollapsed(false);
    opts.onCollapseChange?.(false);
    focusFirst(root);
  }
  // Clicking the collapsed bar expands it.
  bar.addEventListener('click', (e) => {
    if (!collapsed || (e.target as HTMLElement).closest('button')) return;
    expand();
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
      markMarkdown();
      // A changed sender hint applies only while the user has not chosen.
      if (maxBtn && maxMemory.get(next.id) === null) {
        const want = !!next.maximized;
        if (want !== maximized) {
          if (isPhone()) { maximized = want; paintMax(); }
          else setMaximized(want, { user: false });
        }
      }
    },
    focus() {
      if (collapsed) setCollapsed(false);
      if (!focusFirst(root)) root.focus({ preventScroll: true });
    },
    setCollapsed,
    setMaximized,
    isMaximized: () => maximized && !isPhone(),
    dispose() {
      if (disposed) return;
      disposed = true;
      root.removeEventListener('keydown', onKey);
      root.removeEventListener('keydown', onMaxKey, true);
      window.removeEventListener('resize', onResize);
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
