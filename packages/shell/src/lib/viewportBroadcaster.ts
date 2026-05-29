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
}

/** Post to every app iframe (each gets its own measured box). */
export function broadcastViewportChanged(reason: ViewportReason): void {
  document.querySelectorAll('iframe').forEach((f) =>
    postViewportTo(f as HTMLIFrameElement, reason));
}

// Coalesce bursts (the ~18 renderLayout call sites, a zoom-slider drag) into
// one broadcast per frame, fired AFTER the grid has re-laid-out and painted
// (double-rAF) so each iframe is measured at its final size.
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
