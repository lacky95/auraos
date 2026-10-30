/**
 * Dock zones + the shared snap grid — pure, unit-tested.
 *
 * Zones (desktop-style): left/right edge → half, corners → quarter, top edge
 * → the whole activities area. Docked activities store their ZONE, not pixels; the
 * pixels come from `rectForZone` and the workspace's `SnapGrid` fractions, so
 * they follow viewport resizes, and activities that share a border share one
 * fraction — dragging that border (a splitter) resizes all of them.
 */
import { MIN_H, MIN_W, MOBILE_BP, type Rect, type Size } from './geometry.ts';

export type Zone = 'left' | 'right' | 'full' | 'tl' | 'tr' | 'bl' | 'br';
export const ZONES: readonly Zone[] = ['left', 'right', 'full', 'tl', 'tr', 'bl', 'br'];

/** Split fractions: `x` between the left and right column, `yl`/`yr`
 *  between top and bottom quarter in the left/right column. */
export interface SnapGrid { x: number; yl: number; yr: number }
export const DEFAULT_GRID: SnapGrid = { x: 0.5, yl: 0.5, yr: 0.5 };

/** Distance from an edge (px) that arms a zone. Beyond the edge counts too:
 *  the pointer may be over the taskbar or status bar above the area. */
export const EDGE_BAND = 12;
/** Share of an edge, from each end, that counts as "corner". */
export const CORNER_SHARE = 0.15;

export function zoneAt(px: number, py: number, area: Size): Zone | null {
  const { w: W, h: H } = area;
  if (W <= 0 || H <= 0) return null;
  const top = py <= EDGE_BAND;
  if (W < MOBILE_BP) return top ? 'full' : null;
  const left = px <= EDGE_BAND;
  const right = px >= W - EDGE_BAND;
  const bottom = py >= H - EDGE_BAND;
  const cw = Math.max(48, W * CORNER_SHARE);
  const ch = Math.max(48, H * CORNER_SHARE);
  if (top) {
    if (px < cw) return 'tl';
    if (px > W - cw) return 'tr';
    return 'full';
  }
  if (bottom && !left && !right) {
    if (px < cw) return 'bl';
    if (px > W - cw) return 'br';
    return null;
  }
  if (left)  return py < ch ? 'tl' : py > H - ch ? 'bl' : 'left';
  if (right) return py < ch ? 'tr' : py > H - ch ? 'br' : 'right';
  return null;
}

export function column(z: Zone): 'l' | 'r' | null {
  if (z === 'left' || z === 'tl' || z === 'bl') return 'l';
  if (z === 'right' || z === 'tr' || z === 'br') return 'r';
  return null;
}

export function normalizeGrid(g: Partial<SnapGrid> | undefined): SnapGrid {
  const f = (v: unknown, d: number) => (typeof v === 'number' && v > 0 && v < 1 ? v : d);
  return { x: f(g?.x, 0.5), yl: f(g?.yl, 0.5), yr: f(g?.yr, 0.5) };
}

export function rectForZone(z: Zone, g: SnapGrid, area: Size): Rect {
  const { w: W, h: H } = area;
  const xs = Math.round(W * g.x);
  const yl = Math.round(H * g.yl);
  const yr = Math.round(H * g.yr);
  switch (z) {
    case 'full':  return { x: 0,  y: 0,  w: W,      h: H };
    case 'left':  return { x: 0,  y: 0,  w: xs,     h: H };
    case 'right': return { x: xs, y: 0,  w: W - xs, h: H };
    case 'tl':    return { x: 0,  y: 0,  w: xs,     h: yl };
    case 'bl':    return { x: 0,  y: yl, w: xs,     h: H - yl };
    case 'tr':    return { x: xs, y: 0,  w: W - xs, h: yr };
    case 'br':    return { x: xs, y: yr, w: W - xs, h: H - yr };
  }
}

/**
 * Grid to use when an activity docks into `z` while `others` (zones of the
 * other docked activities) stay. A fraction nobody else depends on resets to
 * the middle, so a fresh half/half split is 50/50 even after an earlier
 * splitter drag; a fraction a neighbour already uses is kept.
 */
export function gridForNewSnap(z: Zone, others: readonly Zone[], g: SnapGrid): SnapGrid {
  const next = { ...g };
  const col = column(z);
  if (!col) return next;
  if (!others.some((o) => column(o) !== null)) next.x = 0.5;
  const yKey = col === 'l' ? 'yl' : 'yr';
  const isQuarter = z !== 'left' && z !== 'right';
  if (isQuarter && !others.some((o) => column(o) === col && o !== 'left' && o !== 'right')) next[yKey] = 0.5;
  return next;
}

export type SplitterKey = 'x' | 'yl' | 'yr';
export interface Splitter { key: SplitterKey; rect: Rect }
/** Thickness of a splitter's grab area. */
export const SPLITTER_PX = 8;

/** Splitters between docked activities that share a border. */
export function splittersFor(zones: readonly Zone[], g: SnapGrid, area: Size): Splitter[] {
  const has = (z: Zone) => zones.includes(z);
  const out: Splitter[] = [];
  const { w: W, h: H } = area;
  const half = SPLITTER_PX / 2;
  const xs = Math.round(W * g.x);
  const leftCol = zones.some((z) => column(z) === 'l');
  const rightCol = zones.some((z) => column(z) === 'r');
  if (leftCol && rightCol) out.push({ key: 'x', rect: { x: xs - half, y: 0, w: SPLITTER_PX, h: H } });
  if (has('tl') && has('bl')) {
    out.push({ key: 'yl', rect: { x: 0, y: Math.round(H * g.yl) - half, w: xs, h: SPLITTER_PX } });
  }
  if (has('tr') && has('br')) {
    out.push({ key: 'yr', rect: { x: xs, y: Math.round(H * g.yr) - half, w: W - xs, h: SPLITTER_PX } });
  }
  return out;
}

/** Move one grid fraction to the pointer, keeping every activity ≥ min size. */
export function dragSplitter(g: SnapGrid, key: SplitterKey, pointer: number, area: Size): SnapGrid {
  const span = key === 'x' ? area.w : area.h;
  const min = key === 'x' ? MIN_W : MIN_H;
  if (span <= 2 * min) return { ...g, [key]: 0.5 };
  const v = Math.min(Math.max(pointer, min), span - min) / span;
  return { ...g, [key]: v };
}

/**
 * Which splitter an edge-resize of a docked activity moves: dragging the edge an
 * activity shares with the rest of the grid resizes the grid (all neighbours);
 * dragging an outer edge returns null → the activity undocks and resizes alone.
 * Corner handles combine both axes.
 */
export function splittersForHandle(z: Zone, handle: string): SplitterKey[] {
  const col = column(z);
  if (!col) return [];
  const keys: SplitterKey[] = [];
  if (col === 'l' && handle.includes('e')) keys.push('x');
  if (col === 'r' && handle.includes('w')) keys.push('x');
  const yKey: SplitterKey = col === 'l' ? 'yl' : 'yr';
  if ((z === 'tl' || z === 'tr') && handle.includes('s')) keys.push(yKey);
  if ((z === 'bl' || z === 'br') && handle.includes('n')) keys.push(yKey);
  // Every axis the handle moves must map to a shared edge, else it's an
  // outer-edge resize (undock).
  const axes = (handle.match(/[ns]/) ? 1 : 0) + (handle.match(/[ew]/) ? 1 : 0);
  return keys.length === axes ? keys : [];
}

/**
 * Undock on drag: give the activity its pre-dock size back, positioned so the
 * point the user grabbed stays under the pointer (proportionally along the
 * title bar, same offset from the top).
 */
export function restoreOnDragOut(
  docked: Rect, restore: { w: number; h: number }, pointer: { x: number; y: number },
): Rect {
  const fx = docked.w > 0 ? (pointer.x - docked.x) / docked.w : 0.5;
  const oy = Math.min(pointer.y - docked.y, 24);
  return { x: Math.round(pointer.x - fx * restore.w), y: Math.round(pointer.y - oy), w: restore.w, h: restore.h };
}
