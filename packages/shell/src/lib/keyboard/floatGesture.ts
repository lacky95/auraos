/**
 * Move / resize gestures for the floating virtual keyboard.
 *
 * Two things make a naive drag misbehave in the shell:
 *   • App iframes swallow pointer events, so a drag that crosses a window
 *     stalls and its release is lost. `runGesture` captures the pointer and
 *     sets `body.aura-stack-dragging` (pages/index.astro turns off iframe
 *     hit-testing for it) — same approach as the free-window layout's
 *     runGesture (lib/layout/strategies/freeWindow/index.ts).
 *   • The shell zooms `<body>` with `transform: scale()` (StatusBar.astro
 *     applyViewport). The keyboard is a fixed child of body, so its box is in
 *     body-local px while pointer coordinates are viewport px. `toLocal` /
 *     `localViewport` convert.
 *
 * The rect maths are pure functions so they can be unit-tested.
 */

export interface Rect { left: number; top: number; width: number; height: number }
export interface Size { width: number; height: number }
export type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export const MIN_SIZE: Size = { width: 280, height: 160 };
/** How much of the keyboard must stay on screen. */
const KEEP_VISIBLE: Size = { width: 80, height: 40 };

// ── Coordinates ─────────────────────────────────────────────────────────

/** Scale and origin of the (possibly transformed) <body>. */
function bodyFrame(): { left: number; top: number; scale: number } {
  const b = document.body;
  const r = b.getBoundingClientRect();
  const scale = b.clientWidth > 0 ? r.width / b.clientWidth : 1;
  return { left: r.left, top: r.top, scale: scale > 0 ? scale : 1 };
}

/** Viewport (client) px → body-local px. */
export function toLocal(clientX: number, clientY: number): { x: number; y: number; scale: number } {
  const f = bodyFrame();
  return { x: (clientX - f.left) / f.scale, y: (clientY - f.top) / f.scale, scale: f.scale };
}

/** A viewport-space DOMRect → body-local rect. */
export function rectToLocal(r: DOMRect | DOMRectReadOnly): Rect {
  const a = toLocal(r.left, r.top);
  return { left: a.x, top: a.y, width: r.width / a.scale, height: r.height / a.scale };
}

/** The area a fixed child of <body> can use, in body-local px. */
export function localViewport(): Size {
  const b = document.body;
  return { width: b.clientWidth || window.innerWidth, height: b.clientHeight || window.innerHeight };
}

// ── Rect maths (pure) ───────────────────────────────────────────────────

/** Fit `r` to the minimum size and keep part of it on screen. */
export function clampRect(r: Rect, bounds: Size, min: Size = MIN_SIZE): Rect {
  const width = Math.min(Math.max(min.width, r.width), Math.max(min.width, bounds.width));
  const height = Math.min(Math.max(min.height, r.height), Math.max(min.height, bounds.height));
  const left = Math.min(Math.max(KEEP_VISIBLE.width - width, r.left), bounds.width - KEEP_VISIBLE.width);
  const top = Math.min(Math.max(0, r.top), bounds.height - KEEP_VISIBLE.height);
  return { left, top, width, height };
}

export function moveRect(start: Rect, dx: number, dy: number, bounds: Size): Rect {
  return clampRect({ ...start, left: start.left + dx, top: start.top + dy }, bounds);
}

/**
 * Resize from `edge`. West/north edges move left/top so the opposite edge
 * stays where it was; the rect never shrinks below `min` and never grows
 * past the screen edge it is dragged towards.
 */
export function resizeRect(start: Rect, edge: Edge, dx: number, dy: number, bounds: Size, min: Size = MIN_SIZE): Rect {
  let { left, top, width, height } = start;
  const right = start.left + start.width;
  const bottom = start.top + start.height;
  if (edge.includes('e')) width = Math.min(Math.max(min.width, start.width + dx), bounds.width - start.left);
  if (edge.includes('s')) height = Math.min(Math.max(min.height, start.height + dy), bounds.height - start.top);
  if (edge.includes('w')) {
    left = Math.min(Math.max(0, start.left + dx), right - min.width);
    width = right - left;
  }
  if (edge.includes('n')) {
    top = Math.min(Math.max(0, start.top + dy), bottom - min.height);
    height = bottom - top;
  }
  return { left, top, width: Math.max(min.width, width), height: Math.max(min.height, height) };
}

// ── Gesture ─────────────────────────────────────────────────────────────

export interface GestureOptions {
  /** Pixels the pointer must travel before onMove starts (avoids click jitter). */
  threshold?: number;
  /** Cursor for the whole page while the gesture runs (e.g. 'nwse-resize'). */
  cursor?: string;
}

/**
 * Run one pointer gesture from `ev` on `handle`. `onMove` gets the distance
 * travelled in body-local px, at most once per frame. The gesture always
 * ends (release, cancel, lost capture, window blur) and calls `onEnd` once.
 */
export function runGesture(
  handle: HTMLElement,
  ev: PointerEvent,
  onMove: (dx: number, dy: number) => void,
  onEnd: (moved: boolean) => void,
  opts: GestureOptions = {},
): void {
  if (ev.button !== 0 && ev.pointerType === 'mouse') return;
  ev.preventDefault();
  const threshold = opts.threshold ?? 0;
  const start = toLocal(ev.clientX, ev.clientY);
  try { handle.setPointerCapture(ev.pointerId); } catch { /* not capturable */ }
  document.body.classList.add('aura-stack-dragging');
  const prevCursor = document.body.style.cursor;
  if (opts.cursor) document.body.style.cursor = opts.cursor;

  let moved = false;
  let dx = 0, dy = 0, raf = 0, pending = false;
  const flush = () => { raf = 0; if (pending) { pending = false; onMove(dx, dy); } };
  const move = (e: PointerEvent) => {
    if (e.pointerId !== ev.pointerId) return;
    const p = toLocal(e.clientX, e.clientY);
    dx = p.x - start.x;
    dy = p.y - start.y;
    if (!moved && Math.hypot(dx, dy) < threshold) return;
    moved = true;
    pending = true;
    if (!raf) raf = requestAnimationFrame(flush);
  };
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    if (raf) cancelAnimationFrame(raf);
    flush();
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', end);
    handle.removeEventListener('pointercancel', end);
    handle.removeEventListener('lostpointercapture', end);
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', end, true);
    window.removeEventListener('pointercancel', end, true);
    window.removeEventListener('blur', end);
    try { if (handle.hasPointerCapture(ev.pointerId)) handle.releasePointerCapture(ev.pointerId); } catch { /* gone */ }
    document.body.classList.remove('aura-stack-dragging');
    document.body.style.cursor = prevCursor;
    onEnd(moved);
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  handle.addEventListener('lostpointercapture', end);
  // Fallbacks for when capture isn't honoured.
  window.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', end, true);
  window.addEventListener('pointercancel', end, true);
  window.addEventListener('blur', end);
}
