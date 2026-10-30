// Free Window geometry + docking math (lib/layout/strategies/freeWindow).
//
//   cd packages/shell && npx tsx --test test/layout-free-window.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampRect, MIN_H, MIN_W, resizeRect } from '../src/lib/layout/strategies/freeWindow/geometry.ts';
import {
  DEFAULT_GRID, dragSplitter, gridForNewSnap, rectForZone, restoreOnDragOut, splittersFor,
  splittersForHandle, zoneAt,
} from '../src/lib/layout/strategies/freeWindow/snap.ts';

const AREA = { w: 1600, h: 900 };

test('zoneAt: edges → halves, corners → quarters, top → full, middle → none', () => {
  assert.equal(zoneAt(5, 450, AREA), 'left');
  assert.equal(zoneAt(1595, 450, AREA), 'right');
  assert.equal(zoneAt(800, 3, AREA), 'full');
  assert.equal(zoneAt(800, -40, AREA), 'full', 'pointer above the area (over the taskbar) still counts');
  assert.equal(zoneAt(5, 20, AREA), 'tl');
  assert.equal(zoneAt(20, 5, AREA), 'tl');
  assert.equal(zoneAt(1590, 5, AREA), 'tr');
  assert.equal(zoneAt(5, 890, AREA), 'bl');
  assert.equal(zoneAt(1595, 890, AREA), 'br');
  assert.equal(zoneAt(1500, 895, AREA), 'br', 'bottom edge near a corner');
  assert.equal(zoneAt(800, 895, AREA), null, 'bottom edge middle has no zone');
  assert.equal(zoneAt(800, 450, AREA), null);
});

test('zoneAt: narrow viewport only offers full', () => {
  const phone = { w: 400, h: 800 };
  assert.equal(zoneAt(2, 400, phone), null);
  assert.equal(zoneAt(200, 2, phone), 'full');
});

test('rectForZone tiles the area exactly', () => {
  const g = { x: 0.6, yl: 0.25, yr: 0.5 };
  const l = rectForZone('left', g, AREA);
  const r = rectForZone('right', g, AREA);
  assert.deepEqual(l, { x: 0, y: 0, w: 960, h: 900 });
  assert.equal(l.w + r.w, AREA.w);
  assert.equal(r.x, l.w);
  const tl = rectForZone('tl', g, AREA);
  const bl = rectForZone('bl', g, AREA);
  assert.equal(tl.h + bl.h, AREA.h);
  assert.equal(bl.y, 225);
  assert.deepEqual(rectForZone('full', g, AREA), { x: 0, y: 0, ...AREA });
});

test('gridForNewSnap: first docked activity resets the split, a neighbour keeps it', () => {
  const g = { x: 0.7, yl: 0.3, yr: 0.4 };
  assert.equal(gridForNewSnap('left', [], g).x, 0.5);
  assert.equal(gridForNewSnap('left', ['full'], g).x, 0.5, 'a full activity is not a neighbour');
  assert.equal(gridForNewSnap('right', ['left'], g).x, 0.7);
  assert.equal(gridForNewSnap('tl', ['right'], g).yl, 0.5, 'first quarter in its column resets yl');
  assert.equal(gridForNewSnap('bl', ['tl'], g).yl, 0.3);
  assert.equal(gridForNewSnap('tr', ['tl'], g).yr, 0.5);
});

test('splittersFor: half/half, quarters and half+quarter mixes', () => {
  const keys = (zs: Parameters<typeof splittersFor>[0]) => splittersFor(zs, DEFAULT_GRID, AREA).map((s) => s.key).sort();
  assert.deepEqual(keys(['left', 'right']), ['x']);
  assert.deepEqual(keys(['left']), []);
  assert.deepEqual(keys(['tl', 'bl', 'tr', 'br']), ['x', 'yl', 'yr']);
  assert.deepEqual(keys(['left', 'tr', 'br']), ['x', 'yr']);
  assert.deepEqual(keys(['tl', 'bl']), ['yl']);
  assert.deepEqual(keys(['full', 'left']), []);
  const [v] = splittersFor(['left', 'right'], DEFAULT_GRID, AREA);
  assert.equal(v!.rect.x + v!.rect.w / 2, 800, 'vertical splitter centred on the border');
});

test('dragSplitter clamps so both sides keep their minimum size', () => {
  assert.equal(dragSplitter(DEFAULT_GRID, 'x', 1200, AREA).x, 0.75);
  assert.equal(dragSplitter(DEFAULT_GRID, 'x', 10, AREA).x, MIN_W / AREA.w);
  assert.equal(dragSplitter(DEFAULT_GRID, 'x', 1599, AREA).x, (AREA.w - MIN_W) / AREA.w);
  assert.equal(dragSplitter(DEFAULT_GRID, 'yl', 0, AREA).yl, MIN_H / AREA.h);
  assert.equal(dragSplitter(DEFAULT_GRID, 'x', 100, { w: 400, h: 300 }).x, 0.5, 'too small to split: stays centred');
});

test('splittersForHandle: shared edges move the grid, outer edges undock', () => {
  assert.deepEqual(splittersForHandle('left', 'e'), ['x']);
  assert.deepEqual(splittersForHandle('left', 'w'), []);
  assert.deepEqual(splittersForHandle('left', 's'), [], 'a half has no shared horizontal edge');
  assert.deepEqual(splittersForHandle('right', 'w'), ['x']);
  assert.deepEqual(splittersForHandle('tl', 'se'), ['x', 'yl']);
  assert.deepEqual(splittersForHandle('tl', 'ne'), [], 'north edge of a top quarter is outer');
  assert.deepEqual(splittersForHandle('br', 'n'), ['yr']);
  assert.deepEqual(splittersForHandle('br', 'nw'), ['x', 'yr']);
  assert.deepEqual(splittersForHandle('full', 'e'), []);
});

test('restoreOnDragOut keeps the grab point under the pointer', () => {
  const docked = { x: 0, y: 0, w: 800, h: 900 };
  const r = restoreOnDragOut(docked, { w: 400, h: 300 }, { x: 600, y: 10 });
  assert.equal(r.w, 400);
  assert.equal(r.h, 300);
  assert.equal(r.x, 300, 'grabbed at 75% of the title → 75% of the restored width');
  assert.equal(r.y, 0);
});

test('resizeRect: opposite edge stays, min size wins, stays inside area', () => {
  const start = { x: 100, y: 100, w: 400, h: 300 };
  assert.deepEqual(resizeRect(start, 'se', 50, 20, AREA), { x: 100, y: 100, w: 450, h: 320 });
  assert.deepEqual(resizeRect(start, 'nw', -50, -20, AREA), { x: 50, y: 80, w: 450, h: 320 });
  const w = resizeRect(start, 'w', 1000, 0, AREA);
  assert.equal(w.w, MIN_W);
  assert.equal(w.x + w.w, 500, 'right edge fixed');
  assert.equal(resizeRect(start, 'n', 0, -500, AREA).y, 0, 'top edge cannot leave the area');
  assert.equal(resizeRect(start, 'e', 5000, 0, AREA).w, AREA.w - 100);
});

test('clampRect keeps an activity reachable', () => {
  const r = clampRect({ x: -2000, y: -50, w: 5000, h: 100 }, AREA);
  assert.equal(r.w, AREA.w);
  assert.equal(r.h, MIN_H);
  assert.equal(r.y, 0);
  assert.equal(r.x, 32 - r.w);
});
