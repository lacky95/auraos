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

  // ---- internals ---------------------------------------------------------

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
