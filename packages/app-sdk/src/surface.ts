/**
 * `osClient.surface` — ask the OS to paint a native browser view over part of
 * your window.
 *
 * Some sites cannot run inside an iframe at all, no matter what the host
 * strips from their headers, because their own JavaScript reaches for the top
 * frame. duck.ai's anti-abuse challenge reads `window.top.location` while
 * computing the token that unlocks its UI; frame-busters fail the same way.
 * `window.top` is `[LegacyUnforgeable]` in the HTML spec, so it cannot be
 * shimmed — such a page has to be a genuine top-level document, which only
 * the native host can provide.
 *
 * A surface is that document, positioned to look like it is inside your
 * window. The OS handles placement: it converts your rect out of your own
 * coordinate space, keeps the surface glued to your window through every
 * reflow, zoom and workspace switch, and destroys it when your window closes.
 * You decide whether to use one at all, for which URL, and over which part of
 * your layout.
 *
 * Two things follow from a surface being *native*, and both are visible to
 * users, so design around them rather than being surprised:
 *   - It paints above all page content. Nothing in your DOM can overlap it —
 *     no dropdown, dialog or toast will appear on top. Call {@link detach}
 *     before showing UI that must cover the same area.
 *   - One surface per window, keyed by the id {@link attach} returns. A second
 *     window gets its own; attaching twice from the *same* window replaces
 *     that window's surface.
 *
 * Typical use, driven by the host telling you a page needs it:
 *
 *   osClient.surface.onNeedsTopLevel(({ url }) => {
 *     const box = contentEl.getBoundingClientRect();
 *     osClient.surface.attach(url, {
 *       x: box.left, y: box.top, width: box.width, height: box.height,
 *     });
 *   });
 */

import type { OsClient } from './OsClient.js';

/** A rectangle in your app's own CSS pixel space (as getBoundingClientRect returns). */
export interface SurfaceRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Payload of the host's "this URL cannot be framed" notification. */
export interface NeedsTopLevelInfo {
  url: string;
  /** How the host worked it out: a live failure, or a host it already knew. */
  reason: string;
}

export type NeedsTopLevelHandler = (info: NeedsTopLevelInfo) => void;

/** Payload of the OS's "an overlay is covering your surface" notification. */
export interface OccludedInfo {
  /** True while an overlay covers the surface, false once it no longer does. */
  occluded: boolean;
  /** Which overlay: 'launcher' | 'processManager' | 'lockscreen' | 'dialog' | … */
  by: string | null;
}

export type OccludedHandler = (info: OccludedInfo) => void;

let nextId = 1;

export class SurfaceApi {
  private attachedId: string | null = null;
  private handlers = new Set<NeedsTopLevelHandler>();
  private occludedHandlers = new Set<OccludedHandler>();
  private listening = false;

  constructor(_client: OsClient) { /* no init */ }

  /**
   * Subscribe to the host's notification that a URL inside your window can
   * only run as a top-level document. Returns an unsubscribe function.
   *
   * The host detects this from an *unhandled* cross-origin frame SecurityError
   * raised inside the offending frame, and remembers the host afterwards — so
   * a second visit notifies you before the page has a chance to fail.
   */
  onNeedsTopLevel(handler: NeedsTopLevelHandler): () => void {
    this.handlers.add(handler);
    this.ensureListening();
    return () => { this.handlers.delete(handler); };
  }

  /**
   * Subscribe to the OS telling you an overlay has moved over your surface —
   * the launcher, the process manager, a dialog, the lock screen. Returns an
   * unsubscribe function.
   *
   * You have to act on this: a surface is a native view painted above the
   * whole page, so an overlay drawn over your window is simply invisible until
   * you call {@link setVisible}(false). The OS reports the overlap; it does not
   * hide the surface for you.
   *
   * Only real overlaps are reported. A side panel opening away from your
   * window does not fire.
   */
  onOccluded(handler: OccludedHandler): () => void {
    this.occludedHandlers.add(handler);
    this.ensureListening();
    return () => { this.occludedHandlers.delete(handler); };
  }

  /**
   * Show or hide the surface. Visibility only — the page, its history and its
   * scroll position survive, so this is the right call for something as
   * transient as an open menu. Use {@link detach} to actually tear it down.
   */
  setVisible(visible: boolean, surfaceId?: string): void {
    const id = surfaceId ?? this.attachedId;
    if (!id) return;
    this.post('aura.surface.command', {
      surfaceId: id, action: 'setVisible', payload: { visible },
    });
  }

  /**
   * Ask the OS to open `url` as a native top-level document over `rect`.
   *
   * @param rect in your own CSS pixels — pass a getBoundingClientRect() of the
   *             element the surface should cover.
   * @returns the surface id, for later {@link setRect} / {@link detach} calls.
   */
  attach(url: string, rect: SurfaceRect): string {
    const surfaceId = `s${nextId++}`;
    this.attachedId = surfaceId;
    this.post('aura.surface.attach', { surfaceId, url, rect });
    return surfaceId;
  }

  /**
   * Move or resize the surface within your layout. The OS already follows your
   * *window* — call this only when the surface should occupy a different part
   * of your own UI (a toolbar appearing, a sidebar opening).
   */
  setRect(rect: SurfaceRect, surfaceId?: string): void {
    const id = surfaceId ?? this.attachedId;
    if (!id) return;
    this.post('aura.surface.setRect', { surfaceId: id, rect });
  }

  /** Destroy the surface. Safe to call when nothing is attached. */
  detach(surfaceId?: string): void {
    const id = surfaceId ?? this.attachedId;
    if (!id) return;
    if (id === this.attachedId) this.attachedId = null;
    this.post('aura.surface.detach', { surfaceId: id });
  }

  /** The surface this app currently has attached, if any. */
  current(): string | null { return this.attachedId; }

  private ensureListening(): void {
    if (this.listening || typeof window === 'undefined') return;
    this.listening = true;
    window.addEventListener('message', (ev: MessageEvent) => {
      const d = ev.data as {
        type?: unknown; url?: unknown; reason?: unknown; occluded?: unknown; by?: unknown;
      } | null;
      if (!d) return;

      if (d.type === 'aura.surface.occluded') {
        const info: OccludedInfo = {
          occluded: d.occluded === true,
          by: typeof d.by === 'string' ? d.by : null,
        };
        for (const h of this.occludedHandlers) {
          try { h(info); } catch (err) { console.warn('[surface] occluded handler threw', err); }
        }
        return;
      }

      if (d.type !== 'aura.host.needsTopLevel') return;
      if (typeof d.url !== 'string') return;
      const info: NeedsTopLevelInfo = {
        url: d.url,
        reason: typeof d.reason === 'string' ? d.reason : 'unknown',
      };
      for (const h of this.handlers) {
        try { h(info); } catch (err) { console.warn('[surface] handler threw', err); }
      }
    });
  }

  private post(type: string, extras: Record<string, unknown>): void {
    if (typeof window === 'undefined' || window.parent === window) return;
    try { window.parent.postMessage({ type, ...extras }, '*'); }
    catch { /* parent gone */ }
  }
}
