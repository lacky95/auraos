/**
 * `osClient.nav` — Android-style Back/Home/finish for app iframes.
 *
 * The shell sends `aura.back` to the focused iframe whenever the user
 * activates the OS Back action (default `Escape`). The SDK invokes every
 * registered `onBack` handler with a `preventDefault()`-style escape:
 *   • If a handler calls `e.preventDefault()`, the SDK posts an ACK back to
 *     the shell so it stays in App mode and the app handles its own
 *     internal back-stack (sub-screen pop, "are you sure?" dialog, etc.).
 *   • Otherwise (no preventDefault within ~100ms) the shell falls through
 *     to its built-in Back semantics (pop activity stack or switch to Nav
 *     mode).
 *
 * `finish()` is a thin alias over `OsClient.finish()` (existing API) so apps
 * can call `osClient.nav.finish()` from the same namespace.
 */

import type { OsClient } from './OsClient.js';

export interface BackEvent {
  /** Stop the OS from taking its default Back action. App handles it. */
  preventDefault(): void;
  /** Whether `preventDefault()` has been called. */
  readonly defaultPrevented: boolean;
  /** UTC ms when the OS sent the Back signal. */
  readonly timestamp: number;
}

export type BackHandler = (e: BackEvent) => void | Promise<void>;

/**
 * Spatial keyboard-navigation helper. An app that wants its visible grid /
 * list to respond to the OS basic-nav keys (`aura.nav.{up,down,left,right}`)
 * calls `osClient.nav.installGridNav(...)` once per page mount.
 *
 * The helper reads the user's current combo for each direction via
 * `osClient.keymap.getBinding()` so remaps in Settings → Keyboard take effect
 * on the next page load. Enter activation comes "for free" via native button
 * behavior — we only move focus, the browser fires the click. Back
 * (`aura.nav.back`, default `RShift+Backspace`) is never touched; it flows
 * to the shell's existing activity-history pop handler.
 */
export interface InstallGridNavOptions {
  /** CSS selector for navigable elements. Re-queried on every keystroke so
   *  React islands / async-loaded content work without re-installing. */
  selector?: string;
  /** Use instead of `selector` when the set can't be expressed declaratively. */
  getElements?: () => HTMLElement[];
  /** Return `true` to make the helper ignore arrow keys this tick. Use for
   *  modals / capture dialogs that need raw key access (e.g. KeymapManager's
   *  combo-capture UI). */
  pauseWhen?: () => boolean;
  /** Fired after focus moves to a new element. */
  onFocus?: (el: HTMLElement) => void;
}

export interface GridNavHandle {
  /** Force-focus the first navigable element. Auto-called when the shell
   *  posts `aura.window.focus` (window-selection mode picked this window). */
  focusFirst(): void;
  /** Remove the keydown listener + window-focus listener. */
  uninstall(): void;
}

interface NavRect {
  el: HTMLElement;
  cx: number;
  cy: number;
  w:  number;
  h:  number;
}

export class NavApi {
  private handlers = new Set<BackHandler>();

  constructor(private client: OsClient) {
    if (typeof window === 'undefined') return;
    window.addEventListener('message', this.handleMessage);
  }

  /**
   * Register a Back-key handler. Multiple handlers stack: each is invoked in
   * registration order on every Back press. If ANY handler calls
   * `e.preventDefault()`, the OS treats the Back as consumed.
   */
  onBack(handler: BackHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /** Close the calling activity (mirrors `OsClient.finish()` Android-style). */
  finish(): Promise<void> {
    return this.client.finish();
  }

  /**
   * Wire the page's navigable elements to the OS arrow keys + auto-focus
   * the first element when the window receives `aura.window.focus`. See
   * `InstallGridNavOptions` for option semantics.
   *
   * No-op on the server.
   */
  installGridNav(opts: InstallGridNavOptions): GridNavHandle {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return { focusFirst: () => undefined, uninstall: () => undefined };
    }

    const resolveElements = (): HTMLElement[] => {
      if (opts.getElements) return opts.getElements();
      if (opts.selector)    return Array.from(document.querySelectorAll<HTMLElement>(opts.selector));
      return [];
    };

    const focusFirst = (): void => {
      // The browser's "restore iframe's last-focused descendant" task can
      // fire AFTER our handler — a single rAF isn't enough in every
      // browser. We retry up to 3 frames if `.focus()` didn't stick
      // (something else, usually the body element, became
      // activeElement instead of our target).
      const tryFocus = (attempt: number): void => {
        const els = resolveElements();
        if (els.length === 0) return;
        const target = els[0]!;
        target.focus();
        if (document.activeElement === target) {
          opts.onFocus?.(target);
          return;
        }
        if (attempt < 3) requestAnimationFrame(() => tryFocus(attempt + 1));
      };
      requestAnimationFrame(() => tryFocus(0));
    };

    const onKeydown = (e: KeyboardEvent): void => {
      if (opts.pauseWhen?.()) return;
      // Let typing win in any text-entry surface. Inputs of type `button`/
      // `submit` would also match `'input'` but their `.value` doesn't
      // accept arrow input, so this is benign for those.
      const t = e.target as Element | null;
      if (t && (t.matches?.('input, textarea, select, [contenteditable]')
                || t.closest?.('[contenteditable]'))) return;

      const combo = navComboFromEvent(e);
      // Resolve the current arrow bindings lazily on every keystroke
      // (the keymap API caches them and refreshes on `aura.keymap.changed`).
      const upC    = this.client.keymap.getBinding('aura.nav.up')    ?? 'ArrowUp';
      const downC  = this.client.keymap.getBinding('aura.nav.down')  ?? 'ArrowDown';
      const leftC  = this.client.keymap.getBinding('aura.nav.left')  ?? 'ArrowLeft';
      const rightC = this.client.keymap.getBinding('aura.nav.right') ?? 'ArrowRight';

      let dir: 'up' | 'down' | 'left' | 'right' | null = null;
      if      (combo === upC)    dir = 'up';
      else if (combo === downC)  dir = 'down';
      else if (combo === leftC)  dir = 'left';
      else if (combo === rightC) dir = 'right';
      if (!dir) return;

      const elements = resolveElements();
      if (elements.length === 0) return;

      const rects: NavRect[] = elements.map((el) => {
        const bb = el.getBoundingClientRect();
        return { el, cx: bb.left + bb.width / 2, cy: bb.top + bb.height / 2, w: bb.width, h: bb.height };
      });

      const activeIdx = elements.indexOf(document.activeElement as HTMLElement);
      // noUncheckedIndexedAccess: rects[i] is T|undefined → coalesce.
      const current   = activeIdx >= 0 ? (rects[activeIdx] ?? null) : null;

      const next = pickNeighbour(rects, current, dir);
      if (!next || next === current) return;

      e.preventDefault();
      e.stopPropagation();
      next.el.focus();
      opts.onFocus?.(next.el);
    };

    // Auto-focus when the shell hands focus to this window via
    // window-select mode. The shell posts `aura.window.focus` after
    // `iframe.focus()` so the inner element below the iframe-level focus
    // (button/input) actually receives keyboard input.
    const onMessage = (ev: MessageEvent): void => {
      const d = ev.data as { type?: string } | null;
      if (d?.type !== 'aura.window.focus') return;
      focusFirst();
    };

    // Capture phase so we run before any local bubble-phase listener;
    // matches the proxy's iframe-side forwarder pattern.
    document.addEventListener('keydown', onKeydown, true);
    window.addEventListener('message', onMessage);

    return {
      focusFirst,
      uninstall: () => {
        document.removeEventListener('keydown', onKeydown, true);
        window.removeEventListener('message', onMessage);
      },
    };
  }

  // ---- internals ---------------------------------------------------------

  // ---- Window-select / arrow-nav helpers (module-private) --------------

  // (helper functions below the class — kept at module scope so they can
  // be inlined by the bundler and unit-tested independently.)

  private handleMessage = (ev: MessageEvent): void => {
    const d = ev.data as { type?: string } | null;
    if (!d || typeof d !== 'object' || d.type !== 'aura.back') return;
    if (this.handlers.size === 0) return;

    let prevented = false;
    const event: BackEvent = {
      preventDefault: () => { prevented = true; },
      get defaultPrevented() { return prevented; },
      timestamp: Date.now(),
    };

    void (async () => {
      for (const h of this.handlers) {
        try {
          const res = h(event);
          if (res && typeof (res as Promise<unknown>).then === 'function') {
            await (res as Promise<void>);
          }
        } catch (err) {
          console.warn('[NavApi] onBack handler threw:', err);
        }
      }
      if (prevented && typeof window !== 'undefined' && window.parent !== window) {
        try { window.parent.postMessage({ type: 'aura.back.ack', handled: true }, '*'); }
        catch { /* parent gone */ }
      }
    })();
  };
}

// ---- Module-private helpers ----------------------------------------------

/** Canonical combo string for a keyboard event. Mirrors the proxy-injected
 *  forwarder's `combo()` (Ctrl→Alt→Shift→Super order, `KeyboardEvent.code`
 *  for the trailing key) so user remaps captured via Settings → Keyboard
 *  resolve against the same form. */
function navComboFromEvent(e: KeyboardEvent): string {
  if (!e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) return e.code;
  const parts: string[] = [];
  if (e.ctrlKey)  parts.push('Ctrl');
  if (e.altKey)   parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey)  parts.push('Super');
  parts.push(e.code);
  return parts.join('+');
}

/** Pick the next rect in `dir` from `current`'s center using a half-plane
 *  filter plus an off-axis penalty so straight steps win over diagonals.
 *  Same algorithm the shell uses for window-to-window arrow navigation
 *  (`packages/shell/src/lib/windowNav.ts:nextInDirection`). */
function pickNeighbour(
  rects: readonly NavRect[],
  current: NavRect | null,
  dir: 'up' | 'down' | 'left' | 'right',
): NavRect | null {
  if (rects.length === 0) return null;
  if (!current) return rects[0] ?? null;
  let best: NavRect | null = null;
  let bestScore = Infinity;
  for (const cand of rects) {
    if (cand === current) continue;
    const dx = cand.cx - current.cx;
    const dy = cand.cy - current.cy;
    if (dir === 'up'    && dy >= -1) continue;
    if (dir === 'down'  && dy <=  1) continue;
    if (dir === 'left'  && dx >= -1) continue;
    if (dir === 'right' && dx <=  1) continue;
    const along = (dir === 'up' || dir === 'down') ? Math.abs(dy) : Math.abs(dx);
    const off   = (dir === 'up' || dir === 'down') ? Math.abs(dx) : Math.abs(dy);
    const score = along + off * 2;
    if (score < bestScore) { bestScore = score; best = cand; }
  }
  return best;
}
