/**
 * Free Window geometry — pure functions over plain rects in windows-area
 * CSS pixels. No DOM; unit-tested in test/layout-free-window.test.ts.
 */

export interface Rect { x: number; y: number; w: number; h: number }
export interface Size { w: number; h: number }

/** Strip of chrome that must stay inside the area on every side so a window
 *  can always be grabbed back (title bar is 28px). */
export const EDGE_MARGIN = 32;
export const MIN_W = 240;
export const MIN_H = 140;
/** Below this width the layout behaves as "mobile": new windows fill the
 *  area and only the full-area dock zone exists. */
export const MOBILE_BP = 640;

export function defaultRect(index: number, area: Size): Rect {
  if (area.w < MOBILE_BP) {
    return { x: 8, y: 8, w: Math.max(MIN_W, area.w - 16), h: Math.max(MIN_H, area.h - 16) };
  }
  return { x: 24 + index * 40, y: 24 + index * 40, w: 560, h: 400 };
}

/** Keep a window reachable: size within [min, area], at least EDGE_MARGIN of
 *  it inside horizontally, title bar never above the top edge. */
export function clampRect(r: Rect, area: Size): Rect {
  const w = Math.max(MIN_W, Math.min(r.w, area.w));
  const h = Math.max(MIN_H, Math.min(r.h, area.h));
  const x = Math.max(EDGE_MARGIN - w, Math.min(r.x, area.w - EDGE_MARGIN));
  const y = Math.max(0, Math.min(r.y, area.h - EDGE_MARGIN));
  return { x, y, w, h };
}

export type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
export const HANDLES: readonly Handle[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

/**
 * Resize `start` by dragging `handle` by (dx, dy). The opposite edge stays
 * put; min size wins over the pointer; the moving edge stays inside the area.
 */
export function resizeRect(start: Rect, handle: Handle, dx: number, dy: number, area: Size): Rect {
  let { x, y, w, h } = start;
  const right = start.x + start.w;
  const bottom = start.y + start.h;
  if (handle.includes('e')) {
    w = Math.max(MIN_W, Math.min(start.w + dx, area.w - start.x));
  }
  if (handle.includes('w')) {
    // A window already hanging off the left edge keeps that offset as its limit.
    const nx = Math.min(Math.max(start.x + dx, Math.min(0, start.x)), right - MIN_W);
    x = nx; w = right - nx;
  }
  if (handle.includes('s')) {
    h = Math.max(MIN_H, Math.min(start.h + dy, area.h - start.y));
  }
  if (handle.includes('n')) {
    const ny = Math.min(Math.max(start.y + dy, 0), bottom - MIN_H);
    y = ny; h = bottom - ny;
  }
  return { x, y, w, h };
}
