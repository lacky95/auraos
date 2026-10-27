/**
 * Layout helpers shared by the notification list and the pop-ups (DOM).
 *
 *   - phone mode: the body's effective width below 640 px. The shell zooms
 *     with `transform: scale()` on <body>, so `vw` and window.innerWidth are
 *     wrong — measure `document.body.clientWidth` (unscaled CSS px);
 *   - `right`: distance from the body's right edge to the anchor's right
 *     edge, in body px, so floating UI lines up with the 'notifications'
 *     anchor wherever a layout puts it;
 *   - `keyboard`: how much of the layout viewport the on-screen keyboard
 *     covers (visualViewport), in body px;
 *   - lock state: `#lockscreen[aria-hidden]`.
 *
 * Every watcher returns a disposer.
 */
import { NOTIFICATIONS_ANCHOR, watchAnchor } from '../../../lib/notifications/anchor.ts';

export const PHONE_MAX_WIDTH = 640;

export interface Placement {
  phone: boolean;
  /** Right offset (body px) that right-aligns to the anchor; ≥ 8. */
  right: number;
  /** Keyboard overlap at the bottom (body px), 0 when closed. */
  keyboard: number;
}

/** Ratio of rendered to layout size of <body> (1 = no zoom). */
export function bodyScale(): number {
  const b = document.body;
  const w = b.clientWidth;
  if (!w) return 1;
  const r = b.getBoundingClientRect().width;
  return r > 0 ? r / w : 1;
}

export function computePlacement(anchor: Element | null): Placement {
  const body = document.body;
  const scale = bodyScale();
  const phone = body.clientWidth < PHONE_MAX_WIDTH;
  let right = 16;
  if (anchor && (anchor as HTMLElement).offsetParent !== null) {
    const br = body.getBoundingClientRect();
    const ar = anchor.getBoundingClientRect();
    right = Math.max(8, Math.round((br.right - ar.right) / scale));
  }
  let keyboard = 0;
  const vv = window.visualViewport;
  if (vv) {
    const covered = window.innerHeight - (vv.height + vv.offsetTop);
    // Ignore small differences (browser chrome, rounding).
    if (covered > 80) keyboard = Math.round(covered / scale);
  }
  return { phone, right, keyboard };
}

/** Calls `cb` now and whenever size, zoom, keyboard or the anchor change. */
export function watchPlacement(cb: (p: Placement) => void): () => void {
  let anchor: Element | null = null;
  let raf = 0;
  let last = '';
  const run = () => {
    raf = 0;
    const p = computePlacement(anchor);
    const key = `${p.phone}|${p.right}|${p.keyboard}`;
    if (key === last) return;
    last = key;
    cb(p);
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(run); };
  const ro = new ResizeObserver(schedule);
  ro.observe(document.body);
  const offAnchor = watchAnchor<Element>(NOTIFICATIONS_ANCHOR, (el) => {
    if (anchor) ro.unobserve(anchor);
    anchor = el;
    if (el) ro.observe(el);
    schedule();
  });
  // Zoom changes rewrite body's inline style (transform / width).
  const mo = new MutationObserver(schedule);
  mo.observe(document.body, { attributes: true, attributeFilter: ['style', 'data-autohide-bars'] });
  window.addEventListener('resize', schedule);
  const vv = window.visualViewport;
  vv?.addEventListener('resize', schedule);
  vv?.addEventListener('scroll', schedule);
  run();
  return () => {
    if (raf) cancelAnimationFrame(raf);
    ro.disconnect();
    mo.disconnect();
    offAnchor();
    window.removeEventListener('resize', schedule);
    vv?.removeEventListener('resize', schedule);
    vv?.removeEventListener('scroll', schedule);
  };
}

export function isLocked(): boolean {
  return document.getElementById('lockscreen')?.getAttribute('aria-hidden') === 'false';
}

/** Calls `cb(locked)` now and on every lock / unlock. */
export function watchLock(cb: (locked: boolean) => void): () => void {
  const ls = document.getElementById('lockscreen');
  let last = isLocked();
  cb(last);
  if (!ls) return () => {};
  const mo = new MutationObserver(() => {
    const now = isLocked();
    if (now !== last) { last = now; cb(now); }
  });
  mo.observe(ls, { attributes: true, attributeFilter: ['aria-hidden'] });
  return () => mo.disconnect();
}

/** Pin / unpin the auto-hidden Dock (StatusBar's `auraPinBar` hook; no-op without it). */
export function pinDock(key: string, pinned: boolean): void {
  const pin = (window as unknown as { auraPinBar?: (which: 'top' | 'bottom', key: string, pinned: boolean) => void }).auraPinBar;
  if (typeof pin === 'function') pin('bottom', key, pinned);
}

/** A bag of disposers, run once. */
export class Disposer {
  private fns: Array<() => void> = [];
  add(fn: () => void): void { this.fns.push(fn); }
  listen<K extends keyof DocumentEventMap>(target: Document, type: K, fn: (e: DocumentEventMap[K]) => void, opts?: boolean | AddEventListenerOptions): void;
  listen<K extends keyof WindowEventMap>(target: Window, type: K, fn: (e: WindowEventMap[K]) => void, opts?: boolean | AddEventListenerOptions): void;
  listen(target: EventTarget, type: string, fn: (e: Event) => void, opts?: boolean | AddEventListenerOptions): void;
  listen(target: EventTarget, type: string, fn: (e: never) => void, opts?: boolean | AddEventListenerOptions): void {
    const l = fn as unknown as EventListener;
    target.addEventListener(type, l, opts);
    this.fns.push(() => target.removeEventListener(type, l, opts));
  }
  dispose(): void {
    for (const fn of this.fns.splice(0).reverse()) { try { fn(); } catch { /* ignore */ } }
  }
}
