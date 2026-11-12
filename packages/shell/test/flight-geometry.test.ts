/**
 * Free-flight activities: the pure geometry of lib/flight/geometry.ts —
 * edge snapping, perch detection, tab stacking and flight clamping.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nearestEdge, perchTarget, layoutTabs, clampFlightRect, defaultFlightRect, unfoldRect,
  TAB_LONG, TAB_DEEP, TAB_GAP, FLIGHT_MIN,
} from '../src/lib/flight/geometry.ts';

const VW = 1200, VH = 800;
const NO_BARS = { top: 0, bottom: 0 };

test('nearestEdge picks the closest edge and the position along it', () => {
  assert.deepEqual(nearestEdge(5, 400, VW, VH), { edge: 'left', pos: 0.5 });
  assert.deepEqual(nearestEdge(1190, 200, VW, VH), { edge: 'right', pos: 0.25 });
  assert.deepEqual(nearestEdge(300, 3, VW, VH), { edge: 'top', pos: 0.25 });
  assert.deepEqual(nearestEdge(900, 795, VW, VH), { edge: 'bottom', pos: 0.75 });
});

test('perchTarget only fires inside the band', () => {
  assert.equal(perchTarget(600, 400, VW, VH), null);
  assert.equal(perchTarget(40, 400, VW, VH), null);
  assert.deepEqual(perchTarget(10, 400, VW, VH)?.edge, 'left');
  assert.deepEqual(perchTarget(600, 790, VW, VH)?.edge, 'bottom');
});

test('a tab sits flush on its edge, rotated for top/bottom', () => {
  const m = layoutTabs([
    { id: 'l', edge: 'left', pos: 0.5 },
    { id: 'r', edge: 'right', pos: 0.5 },
    { id: 't', edge: 'top', pos: 0.5 },
    { id: 'b', edge: 'bottom', pos: 0.5 },
  ], VW, VH, NO_BARS);
  assert.deepEqual(m.get('l'), { x: 0, y: 400 - TAB_LONG / 2, w: TAB_DEEP, h: TAB_LONG });
  assert.equal(m.get('r')!.x, VW - TAB_DEEP);
  assert.deepEqual(m.get('t'), { x: 600 - TAB_LONG / 2, y: 0, w: TAB_LONG, h: TAB_DEEP });
  assert.equal(m.get('b')!.y, VH - TAB_DEEP);
});

test('top/bottom tabs stay clear of the visible bars; side tabs between them', () => {
  const bars = { top: 32, bottom: 60 };
  const m = layoutTabs([
    { id: 't', edge: 'top', pos: 0.5 },
    { id: 'b', edge: 'bottom', pos: 0.5 },
    { id: 'hi', edge: 'left', pos: 0 },
    { id: 'lo', edge: 'right', pos: 1 },
  ], VW, VH, bars);
  assert.equal(m.get('t')!.y, 32);
  assert.equal(m.get('b')!.y, VH - 60 - TAB_DEEP);
  assert.ok(m.get('hi')!.y >= 32, 'below the top bar');
  assert.ok(m.get('lo')!.y + TAB_LONG <= VH - 60, 'above the dock');
});

test('tabs on one edge stack without overlapping, in pos order', () => {
  const m = layoutTabs([
    { id: 'a', edge: 'right', pos: 0.5 },
    { id: 'b', edge: 'right', pos: 0.5 },
    { id: 'c', edge: 'right', pos: 0.49 },
  ], VW, VH, NO_BARS);
  const ys = ['c', 'a', 'b'].map((id) => m.get(id)!.y);
  assert.ok(ys[1]! - ys[0]! >= TAB_LONG + TAB_GAP);
  assert.ok(ys[2]! - ys[1]! >= TAB_LONG + TAB_GAP);
});

test('a stack at the end of an edge is pushed back on screen', () => {
  const m = layoutTabs([1, 2, 3].map((i) => ({ id: `t${i}`, edge: 'left' as const, pos: 1 })), VW, VH, NO_BARS);
  for (const b of m.values()) assert.ok(b.y + b.h <= VH, `tab at ${b.y} fits`);
});

test('clampFlightRect keeps a flight usable', () => {
  const r = clampFlightRect({ x: -2000, y: -50, w: 10, h: 10 }, VW, VH);
  assert.equal(r.w, FLIGHT_MIN.w);
  assert.equal(r.h, FLIGHT_MIN.h);
  assert.equal(r.x, 0, 'pulled fully on screen');
  assert.equal(r.y, 0);
  const off = clampFlightRect({ x: 1024, y: 700, w: 320, h: 196 }, VW, VH);
  assert.equal(off.x + off.w, VW, 'a rect from a wider screen fits');
  assert.equal(off.y + off.h, VH);
  const big = clampFlightRect({ x: 0, y: 0, w: 5000, h: 5000 }, VW, VH);
  assert.equal(big.w, VW);
  assert.equal(big.h, VH);
});

test('defaultFlightRect cascades new flights', () => {
  const a = defaultFlightRect({ w: 320, h: 200 }, VW, VH, 0);
  const b = defaultFlightRect({ w: 320, h: 200 }, VW, VH, 1);
  assert.equal(a.w, 320);
  assert.ok(b.x > a.x && b.y > a.y);
});

test('unfoldRect prefers the last rect, else opens next to the tab', () => {
  const last = { x: 100, y: 100, w: 300, h: 200 };
  assert.deepEqual(unfoldRect(last, null, undefined, VW, VH), last);
  const tab = { x: VW - TAB_DEEP, y: 300, w: TAB_DEEP, h: TAB_LONG };
  const r = unfoldRect(null, tab, { w: 300, h: 200 }, VW, VH);
  assert.ok(r.x + r.w <= VW + 1 && r.x > VW / 2, 'opens on the tab side');
});

// ─── Edge mode ────────────────────────────────────────────────────────────
import { edgeRect, edgeHandleBox, edgeSizeOf, distanceFromEdge, TEAR_OFF_PX } from '../src/lib/flight/geometry.ts';

test('edgeRect: flush with each edge, centred on the anchor', () => {
  const r = edgeRect({ edge: 'right', pos: 0.5 }, { length: 400, depth: 300 }, VW, VH);
  assert.deepEqual(r, { x: VW - 300, y: 200, w: 300, h: 400 });
  const l = edgeRect({ edge: 'left', pos: 0.5 }, { length: 400, depth: 300 }, VW, VH);
  assert.equal(l.x, 0);
  const t = edgeRect({ edge: 'top', pos: 0.5 }, { length: 400, depth: 300 }, VW, VH, { top: 32, bottom: 0 });
  assert.deepEqual(t, { x: 400, y: 32, w: 400, h: 300 });
  const b = edgeRect({ edge: 'bottom', pos: 0.25 }, { length: 400, depth: 300 }, VW, VH, { top: 0, bottom: 60 });
  assert.deepEqual(b, { x: 100, y: VH - 60 - 300, w: 400, h: 300 });
});

test('edgeRect: "full" spans the edge between the bars', () => {
  const r = edgeRect({ edge: 'left', pos: 0.1 }, { length: 'full', depth: 320 }, VW, VH, { top: 32, bottom: 60 });
  assert.deepEqual(r, { x: 0, y: 32, w: 320, h: VH - 92 });
  const t = edgeRect({ edge: 'top', pos: 0.9 }, { length: 'full', depth: 200 }, VW, VH);
  assert.deepEqual(t, { x: 0, y: 0, w: VW, h: 200 });
});

test('edgeRect: shifted and capped to stay on screen', () => {
  const r = edgeRect({ edge: 'right', pos: 0.98 }, { length: 400, depth: 5000 }, VW, VH);
  assert.equal(r.y + r.h, VH, 'shifted up');
  assert.ok(r.x >= 0 && r.w < VW, 'depth capped');
  const tiny = edgeRect({ edge: 'top', pos: 0.5 }, { length: 10, depth: 10 }, VW, VH);
  assert.ok(tiny.w >= 120 && tiny.h >= 120);
});

test('edgeHandleBox sits on the drawer\'s inner side at the anchor', () => {
  const d = edgeRect({ edge: 'right', pos: 0.5 }, { length: 400, depth: 300 }, VW, VH);
  const h = edgeHandleBox(d, { edge: 'right', pos: 0.5 }, VW, VH);
  assert.equal(h.x + h.w, d.x);
  assert.ok(h.y >= d.y && h.y + h.h <= d.y + d.h);
  const t = edgeRect({ edge: 'top', pos: 0.5 }, { length: 400, depth: 300 }, VW, VH);
  assert.equal(edgeHandleBox(t, { edge: 'top', pos: 0.5 }, VW, VH).y, t.y + t.h);
});

test('edgeSizeOf turns a resized drawer back into size + position', () => {
  const { size, pos } = edgeSizeOf({ x: 900, y: 100, w: 300, h: 400 }, 'right', VW, VH, false, true);
  assert.deepEqual(size, { length: 400, depth: 300 });
  assert.equal(pos, 0.375);
  assert.equal(edgeSizeOf({ x: 900, y: 0, w: 350, h: VH }, 'right', VW, VH, true, false).size.length, 'full');
});

test('tear-off distance is measured from the drawer\'s edge', () => {
  assert.equal(distanceFromEdge('right', VW - 10, 300, VW, VH), 10);
  assert.ok(distanceFromEdge('top', 500, TEAR_OFF_PX + 1, VW, VH) > TEAR_OFF_PX);
});
