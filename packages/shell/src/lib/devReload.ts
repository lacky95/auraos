/**
 * Dev-only guard over Vite's full-page reload for the shell.
 *
 * By default Vite full-reloads the shell page on any source change, which
 * tears down all OS state (open windows, focused activity, launcher/PM
 * panels). When the user turns OFF "auto-reload on source change" in the
 * Viewport dialog, we intercept Vite's `vite:beforeFullReload` and abort it by
 * throwing — the documented way to cancel a full reload from the HMR client
 * (verified against Vite 6.x). A `aura.shell.reload-pending` event is fired so
 * the status bar can surface a "reload now" chip; the change isn't lost, just
 * deferred to a manual reload.
 *
 * Entirely dev-only: in a production build `import.meta.hot` is statically
 * `undefined`, so the body below is tree-shaken and the function early-returns.
 * The toggle is read FRESH from localStorage via viewportClient — never from an
 * in-memory cache — because the dialog island that flips it lives in a separate
 * module graph and same-tab writes don't emit a `storage` event.
 */
import { isAutoReloadEnabled } from './viewportClient';

declare global {
  interface Window {
    /** Set once installShellReloadGuard runs, so HMR re-eval doesn't double-bind. */
    __auraReloadGuard?: boolean;
  }
}

/** Custom event the status bar listens for to reveal its "reload pending" chip. */
export const RELOAD_PENDING_EVENT = 'aura.shell.reload-pending';

/** OS event the production shell emits after it rebuilt itself (server/watchRebuild). */
export const SHELL_REBUILT_EVENT = 'shell:rebuilt';

/**
 * Production counterpart of the guard below: a production shell has no HMR,
 * but it can rebuild itself (AURA_SHELL_WATCH=1) and announce the new build
 * as the `shell:rebuilt` OS event. Same rule as in dev: auto-reload on →
 * reload now; off → show the "reload pending" chip.
 */
export function installRebuildListener(
  osEvents: { subscribe(p: string, h: (ev: { type: string }) => void): () => void } | null,
): void {
  if (typeof window === 'undefined' || !osEvents) return;
  osEvents.subscribe(SHELL_REBUILT_EVENT, () => {
    if (isAutoReloadEnabled()) location.reload();
    else window.dispatchEvent(new CustomEvent(RELOAD_PENDING_EVENT));
  });
}

export function installShellReloadGuard(): void {
  if (typeof window === 'undefined') return;     // SSR no-op
  if (window.__auraReloadGuard) return;          // idempotent across HMR re-eval
  window.__auraReloadGuard = true;
  if (!import.meta.hot) return;                  // prod / no HMR → tree-shaken no-op

  import.meta.hot.on('vite:beforeFullReload', () => {
    if (isAutoReloadEnabled()) return;           // ON → let Vite reload normally
    // OFF → suppress. Surface the pending change, then throw to abort the
    // reload (Vite's HMR client treats a throwing handler as a veto).
    window.dispatchEvent(new CustomEvent(RELOAD_PENDING_EVENT));
    throw new Error('[aura] full reload suppressed — auto-reload is off');
  });
}
