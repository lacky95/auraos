/**
 * Free-flight activities — pure geometry (no DOM), unit-tested.
 *
 * All values are body-local CSS px (see keyboard/floatGesture.ts: the shell
 * zooms <body>, fixed children live in its coordinate space).
 */

export type FlightEdge = 'left' | 'right' | 'top' | 'bottom';
export interface Box { x: number; y: number; w: number; h: number }
export interface Size { w: number; h: number }
/** Space the visible bars take at the top / bottom of the screen. */
export interface Insets { top: number; bottom: number }

/** Tab size: `long` along the edge, `deep` into the screen (≥ 44 px hit target). */
export const TAB_LONG = 56;
export const TAB_DEEP = 38;
export const TAB_GAP = 6;
/** Dragging a flight with the pointer this close to an edge perches it. */
export const PERCH_BAND = 28;
export const FLIGHT_MIN: Size = { w: 200, h: 120 };
export const FLIGHT_DEFAULT: Size = { w: 360, h: 240 };
/** How much of an airborne flight must stay on screen. */
const KEEP_VISIBLE: Size = { w: 96, h: 36 };

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/** The edge closest to (x, y), and the position along it (0..1). */
export function nearestEdge(x: number, y: number, vw: number, vh: number): { edge: FlightEdge; pos: number } {
  const d: Record<FlightEdge, number> = { left: x, right: vw - x, top: y, bottom: vh - y };
  const edge = (Object.keys(d) as FlightEdge[]).reduce((a, b) => (d[b] < d[a] ? b : a));
  return { edge, pos: posAlong(edge, x, y, vw, vh) };
}

export function posAlong(edge: FlightEdge, x: number, y: number, vw: number, vh: number): number {
  return edge === 'left' || edge === 'right' ? clamp(y / Math.max(1, vh), 0, 1) : clamp(x / Math.max(1, vw), 0, 1);
}

/** While dragging a flight: the edge it would perch on if released at (x, y), or null. */
export function perchTarget(x: number, y: number, vw: number, vh: number, band = PERCH_BAND): { edge: FlightEdge; pos: number } | null {
  const n = nearestEdge(x, y, vw, vh);
  const dist = { left: x, right: vw - x, top: y, bottom: vh - y }[n.edge];
  return dist <= band ? n : null;
}

/** Tab box for an edge, centred on `center` (px along the edge). */
function tabAt(edge: FlightEdge, center: number, vw: number, vh: number, insets: Insets): Box {
  if (edge === 'left' || edge === 'right') {
    return { x: edge === 'left' ? 0 : vw - TAB_DEEP, y: Math.round(center - TAB_LONG / 2), w: TAB_DEEP, h: TAB_LONG };
  }
  const y = edge === 'top' ? insets.top : vh - insets.bottom - TAB_DEEP;
  return { x: Math.round(center - TAB_LONG / 2), y, w: TAB_LONG, h: TAB_DEEP };
}

/** The usable range along an edge (between the bars on the side edges). */
function range(edge: FlightEdge, vw: number, vh: number, insets: Insets): [number, number] {
  return edge === 'left' || edge === 'right'
    ? [insets.top + TAB_LONG / 2 + 4, vh - insets.bottom - TAB_LONG / 2 - 4]
    : [TAB_LONG / 2 + 4, vw - TAB_LONG / 2 - 4];
}

/**
 * Place every perched tab. Tabs on the same edge keep their order (by `pos`)
 * and never overlap: a sweep pushes each one past its predecessor, and the
 * run is shifted back if it overflows the end of the edge.
 */
export function layoutTabs(
  tabs: Array<{ id: string; edge: FlightEdge; pos: number }>,
  vw: number, vh: number, insets: Insets,
): Map<string, Box> {
  const out = new Map<string, Box>();
  const step = TAB_LONG + TAB_GAP;
  for (const edge of ['left', 'right', 'top', 'bottom'] as FlightEdge[]) {
    const list = tabs.filter((t) => t.edge === edge).sort((a, b) => a.pos - b.pos || a.id.localeCompare(b.id));
    if (!list.length) continue;
    const [lo, hi] = range(edge, vw, vh, insets);
    const len = edge === 'left' || edge === 'right' ? vh : vw;
    const centers = list.map((t) => clamp(t.pos * len, lo, hi));
    for (let i = 1; i < centers.length; i++) centers[i] = Math.max(centers[i]!, centers[i - 1]! + step);
    const over = centers[centers.length - 1]! - hi;
    if (over > 0) for (let i = 0; i < centers.length; i++) centers[i] = centers[i]! - over;
    // Too many to fit: the first ones may sit below `lo` — keep them on screen.
    for (let i = 0; i < centers.length; i++) centers[i] = Math.max(centers[i]!, Math.min(lo, hi));
    list.forEach((t, i) => out.set(t.id, tabAt(edge, centers[i]!, vw, vh, insets)));
  }
  return out;
}

/**
 * Keep an airborne flight usable: minimum size, at most the screen, and wholly
 * on screen (between the bars) — a rect saved on a bigger display, or a
 * shrunk window, never leaves a flight hanging off an edge. Only a flight
 * larger than the screen falls back to keeping a strip visible.
 */
export function clampFlightRect(r: Box, vw: number, vh: number, min: Size = FLIGHT_MIN, insets: Insets = { top: 0, bottom: 0 }): Box {
  const w = clamp(Math.max(min.w, r.w), min.w, Math.max(min.w, vw));
  const h = clamp(Math.max(min.h, r.h), min.h, Math.max(min.h, vh - insets.top - insets.bottom));
  const x = w <= vw ? clamp(r.x, 0, vw - w) : clamp(r.x, KEEP_VISIBLE.w - w, vw - KEEP_VISIBLE.w);
  const bottom = vh - insets.bottom;
  const y = h <= bottom - insets.top ? clamp(r.y, insets.top, bottom - h) : clamp(r.y, insets.top, bottom - KEEP_VISIBLE.h);
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

/** First placement: the requested size, cascaded from the centre by `index`. */
export function defaultFlightRect(size: Size | undefined, vw: number, vh: number, index = 0, min: Size = FLIGHT_MIN): Box {
  const s = size ?? FLIGHT_DEFAULT;
  const w = Math.min(Math.max(min.w, s.w), vw - 32);
  const h = Math.min(Math.max(min.h, s.h), vh - 96);
  const off = (index % 6) * 28;
  return clampFlightRect({ x: Math.round((vw - w) / 2) + off, y: Math.round((vh - h) / 3) + off, w, h }, vw, vh, min);
}

/**
 * Where a flight unfolds from its tab: its last rect if it has one, else
 * next to the tab, pulled away from the edge.
 */
export function unfoldRect(rect: Box | null, tab: Box | null, size: Size | undefined, vw: number, vh: number, min: Size = FLIGHT_MIN): Box {
  if (rect) return clampFlightRect(rect, vw, vh, min);
  const base = defaultFlightRect(size, vw, vh, 0, min);
  if (!tab) return base;
  // Centred on the tab, but wholly on screen (so it opens beside the tab).
  const cx = tab.x + tab.w / 2, cy = tab.y + tab.h / 2;
  return {
    ...base,
    x: Math.round(clamp(cx - base.w / 2, 0, vw - base.w)),
    y: Math.round(clamp(cy - base.h / 2, 0, vh - base.h)),
  };
}

// ─── Edge mode: the drawer ───────────────────────────────────────────────

/** Edge-mode drawer size: along the edge (`'full'` = the whole edge) × into the screen. */
export interface EdgeSize { length: number | 'full'; depth: number }
export const EDGE_MIN = 120;
/** Dragging an edge drawer's title bar this far from its edge tears it off into free mode. */
export const TEAR_OFF_PX = 80;

const isSide = (e: FlightEdge) => e === 'left' || e === 'right';

/**
 * The drawer of an edge-mode flight: flush with `anchor.edge`, centred on the
 * anchor position, `length` along the edge (`'full'` = between the bars on the
 * side edges, the whole width on top/bottom) and `depth` into the screen.
 * Always wholly on screen (shifted along the edge, capped to what fits).
 */
export function edgeRect(anchor: { edge: FlightEdge; pos: number }, size: EdgeSize, vw: number, vh: number, insets: Insets = { top: 0, bottom: 0 }): Box {
  const top = insets.top, bottom = vh - insets.bottom;
  if (isSide(anchor.edge)) {
    const avail = Math.max(EDGE_MIN, bottom - top);
    const h = size.length === 'full' ? avail : clamp(size.length, EDGE_MIN, avail);
    const w = clamp(size.depth, EDGE_MIN, Math.max(EDGE_MIN, vw - TAB_DEEP));
    const y = size.length === 'full' ? top : clamp(anchor.pos * vh - h / 2, top, bottom - h);
    return { x: anchor.edge === 'left' ? 0 : vw - w, y: Math.round(y), w: Math.round(w), h: Math.round(h) };
  }
  const w = size.length === 'full' ? vw : clamp(size.length, EDGE_MIN, vw);
  const h = clamp(size.depth, EDGE_MIN, Math.max(EDGE_MIN, bottom - top - TAB_DEEP));
  const x = size.length === 'full' ? 0 : clamp(anchor.pos * vw - w / 2, 0, vw - w);
  const y = anchor.edge === 'top' ? top : bottom - h;
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

/** The open drawer's tab: a handle on its inner side, at the anchor position (kept on the drawer). */
export function edgeHandleBox(drawer: Box, anchor: { edge: FlightEdge; pos: number }, vw: number, vh: number): Box {
  if (isSide(anchor.edge)) {
    const cy = clamp(anchor.pos * vh, drawer.y + TAB_LONG / 2, drawer.y + drawer.h - TAB_LONG / 2);
    const x = anchor.edge === 'left' ? drawer.x + drawer.w : drawer.x - TAB_DEEP;
    return { x, y: Math.round(cy - TAB_LONG / 2), w: TAB_DEEP, h: TAB_LONG };
  }
  const cx = clamp(anchor.pos * vw, drawer.x + TAB_LONG / 2, drawer.x + drawer.w - TAB_LONG / 2);
  const y = anchor.edge === 'top' ? drawer.y + drawer.h : drawer.y - TAB_DEEP;
  return { x: Math.round(cx - TAB_LONG / 2), y, w: TAB_LONG, h: TAB_DEEP };
}

/** How far (px) the point is from `edge` — for the tear-off check. */
export function distanceFromEdge(edge: FlightEdge, x: number, y: number, vw: number, vh: number): number {
  return edge === 'left' ? x : edge === 'right' ? vw - x : edge === 'top' ? y : vh - y;
}

/** A drawer box back into the edge-mode size + anchor position (after a resize). */
export function edgeSizeOf(box: Box, edge: FlightEdge, vw: number, vh: number, wasFull: boolean, lengthChanged: boolean): { size: EdgeSize; pos: number } {
  const side = isSide(edge);
  const length = wasFull && !lengthChanged ? 'full' : Math.round(side ? box.h : box.w);
  const depth = Math.round(side ? box.w : box.h);
  const pos = side ? (box.y + box.h / 2) / Math.max(1, vh) : (box.x + box.w / 2) / Math.max(1, vw);
  return { size: { length, depth }, pos: clamp(pos, 0, 1) };
}
