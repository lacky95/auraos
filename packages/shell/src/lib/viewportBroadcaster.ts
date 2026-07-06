/**
 * Per-window viewport broadcaster — the ONE place the shell tells each app
 * iframe its current size.
 *
 * NOT to be confused with lib/viewport.ts + lib/viewportClient.ts, which model
 * the user's zoom/margin *profiles* (localStorage, the ⚙ dialog). This module
 * is about the live per-iframe content box: after every layout reflow, zoom
 * change, free-window resize, or fresh mount, it posts each iframe its exact
 * logical pixel size so the app never has to guess by measuring its own DOM.
 *
 * Why authoritative dims instead of letting the app measure: the app's DOM
 * settles unpredictably across launch / workspace-switch / zoom / focus, which
 * is what made the terminal's xterm width flaky (it had grown seven overlapping
 * resize triggers to paper over the race). The shell already KNOWS every box
 * (it computes the grid cells and free-window rects), so it sends the number.
 *
 * Imported by BOTH index.astro (layout/mount/stack-release/window-resize) and
 * StatusBar.astro (zoom) so there is a single broadcaster, not a copy per
 * island. Apps consume via `osClient.onViewportChange`.
 */

export type ViewportReason = 'layout' | 'zoom' | 'mount';

export interface ViewportMessage {
  type: 'aura.viewport.changed';
  reason: ViewportReason;
  shellZoom: number;
  iframeScale: number;
  /** This iframe's logical content box in CSS px (transform-independent). */
  contentW: number;
  contentH: number;
}

function num(v: string, d: number): number {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : d;
}

/** Current global scale factors, read from the CSS vars StatusBar sets. */
function readScales(): { shellZoom: number; iframeScale: number } {
  const s = getComputedStyle(document.documentElement);
  return {
    shellZoom:   num(s.getPropertyValue('--aura-shell-zoom'), 1),
    iframeScale: num(s.getPropertyValue('--aura-iframe-scale'), 1),
  };
}

/**
 * Measure an iframe's LOGICAL content box. Uses clientWidth/Height, NOT
 * getBoundingClientRect(): the iframe carries `transform: scale(iframeScale)`
 * with `width: calc(100%/iframeScale)`, so its layout box (clientWidth) is the
 * unscaled size the app actually renders into, while getBoundingClientRect()
 * would return the painted (scaled) size — wrong for the app's own coordinate
 * space.
 */
function measureFrame(frame: HTMLIFrameElement): { contentW: number; contentH: number } {
  return { contentW: frame.clientWidth, contentH: frame.clientHeight };
}

/** Post the current viewport (with THIS frame's box) to one iframe. */
export function postViewportTo(frame: HTMLIFrameElement, reason: ViewportReason): void {
  const { shellZoom, iframeScale } = readScales();
  const { contentW, contentH } = measureFrame(frame);
  const msg: ViewportMessage = {
    type: 'aura.viewport.changed',
    reason, shellZoom, iframeScale, contentW, contentH,
  };
  try { frame.contentWindow?.postMessage(msg, '*'); }
  catch { /* cross-origin or torn-down frame */ }
  console.debug('[viewport] post', reason, contentW, '×', contentH, frame.id || ''); // TEMP: post-count instrumentation
}

/** Post to every app iframe (each gets its own measured box). */
export function broadcastViewportChanged(reason: ViewportReason): void {
  document.querySelectorAll('iframe').forEach((f) =>
    postViewportTo(f as HTMLIFrameElement, reason));
}

// Coalesce bursts (a zoom-slider drag) into one broadcast per frame, fired
// AFTER the grid has re-laid-out and painted (double-rAF) so each iframe is
// measured at its final size. Layout-driven broadcasts no longer come through
// here — they're geometry-driven by the per-iframe ResizeObserver below. This
// path is kept for the non-geometric signals (zoom) that no observer can see.
let queued = false;
let queuedReason: ViewportReason = 'layout';
export function queueViewportBroadcast(reason: ViewportReason): void {
  // A concrete reason (zoom/mount) wins over a pending generic 'layout' so the
  // app still learns why it's resizing when sources coincide.
  if (reason !== 'layout') queuedReason = reason;
  else if (!queued) queuedReason = reason;
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    queued = false;
    const r = queuedReason;
    queuedReason = 'layout';
    broadcastViewportChanged(r);
  }));
}

// ─── Geometry-driven layout hook: one ResizeObserver, every iframe ──────────
// Instead of remembering to call queueViewportBroadcast('layout') at each of
// the ~dozen mutation sites (renderLayout, window resize, stack release,
// maximize, …) — fragile, and silently missed by any future layout manager —
// the shell observes each iframe's actual box. A real client-box change is the
// ONE true signal that an app must refit, and it fires for tiling reflow,
// window open/close, fullscreen, rows, free-window resize, maximize, and
// browser resize alike. Zoom (a paint-only transform: scale()) and the initial
// mount are NOT geometry changes, so they stay explicit (queueViewportBroadcast
// 'zoom' / postViewportMount).

// Last box posted per frame, for dedupe (a reflow that doesn't move OUR box
// must not re-broadcast). WeakMap so torn-down frames GC without bookkeeping.
const lastBox = new WeakMap<HTMLIFrameElement, string>();

/**
 * Post to one frame only if its box actually changed since the last post. A
 * 0×0 box (the frame is display:none — e.g. an off-active-workspace slot) is
 * recorded but NEVER posted: apps treat contentW===0 as "hidden" and must not
 * resize to it. The next non-zero box (slot revealed) differs from "0x0" and
 * fires. Pass force=true to bypass dedupe (zoom: same box, new scale).
 */
export function broadcastIfChanged(
  frame: HTMLIFrameElement,
  reason: ViewportReason,
  force = false,
): void {
  const w = frame.clientWidth, h = frame.clientHeight;
  const key = `${w}x${h}`;
  if (!force && lastBox.get(frame) === key) return;
  lastBox.set(frame, key);
  if (w === 0 || h === 0) return; // hidden — record, don't post
  postViewportTo(frame, reason);
}

let suppressed = false;
/** While suppressed the observer skips broadcasts (used during free-window
 *  live drag, which stays CSS-only and fires one fit on release). */
export function setROSuppressed(v: boolean): void { suppressed = v; }

let ro: ResizeObserver | null = null;
const pending = new Set<HTMLIFrameElement>();
let flushQueued = false;
function scheduleFlush(): void {
  if (flushQueued) return;
  flushQueued = true;
  // Double-rAF: let the grid finish laying out + paint before we measure, so
  // each frame is read at its settled size (same settle the old queue used).
  requestAnimationFrame(() => requestAnimationFrame(() => {
    flushQueued = false;
    if (suppressed) { pending.clear(); return; }
    for (const f of pending) broadcastIfChanged(f, 'layout');
    pending.clear();
  }));
}

function ensureObserver(): ResizeObserver {
  if (ro) return ro;
  // No loop risk: the iframe box is shell-driven (width/height:100%), never
  // changed by anything inside the iframe, so a broadcast can't feed back into
  // a resize of the observed element.
  ro = new ResizeObserver((entries) => {
    for (const e of entries) pending.add(e.target as HTMLIFrameElement);
    scheduleFlush();
  });
  return ro;
}

/** Start observing an iframe (idempotent per frame). Its first observe fire
 *  carries the mount box — deduped against the explicit mount post via lastBox. */
export function observeIframe(frame: HTMLIFrameElement): void {
  ensureObserver().observe(frame);
}

/** Stop observing a torn-down iframe and drop its dedupe entry. */
export function unobserveIframe(frame: HTMLIFrameElement): void {
  ro?.unobserve(frame);
  pending.delete(frame);
  lastBox.delete(frame);
}

/** Explicit first-paint post for a freshly mounted frame; seeds lastBox so the
 *  observer's initial fire for the same box dedupes out (no double mount fit). */
export function postViewportMount(frame: HTMLIFrameElement): void {
  broadcastIfChanged(frame, 'mount');
}
