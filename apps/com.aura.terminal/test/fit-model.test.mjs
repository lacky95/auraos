// The grid formula, and the box settler that turns a keyboard slide's burst
// of viewport boxes into a resize at the start and one at the end.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proposeGrid, settleBoxes } from '../src/fit-model.ts';

// The terminal's real numbers: Courier New 14px → 8.4×17 cells, #terminal
// padding 4/4/7, a 24px bar, no scrollbar on a phone.
const CELL = { w: 8.4, h: 17 };
const INSET = { x: 8, y: 11 + 24 };

test('cols/rows are floor((box − inset) / cell)', () => {
  assert.deepEqual(proposeGrid({ boxW: 412, boxH: 700, cell: CELL, inset: INSET }), { cols: 48, rows: 39 });
  // Exactly on a boundary: 8 + 10 × 8.4 = 92 → 10 cols, not 9.
  assert.deepEqual(proposeGrid({ boxW: 92, boxH: 35 + 17, cell: CELL, inset: INSET }), { cols: 10, rows: 1 });
});

test('never below 1×1, and null while nothing can be measured', () => {
  assert.deepEqual(proposeGrid({ boxW: 5, boxH: 5, cell: CELL, inset: INSET }), { cols: 1, rows: 1 });
  assert.equal(proposeGrid({ boxW: 0, boxH: 700, cell: CELL, inset: INSET }), null);
  assert.equal(proposeGrid({ boxW: 400, boxH: 700, cell: { w: 0, h: 0 }, inset: INSET }), null);
});

function settler(delayMs = 120) {
  let t = 0;
  let timer = null;
  const applied = [];
  const s = settleBoxes((w, h) => applied.push([w, h, t]), {
    delayMs,
    now: () => t,
    setTimer: (cb, ms) => { timer = { cb, at: t + ms }; return timer; },
    clearTimer: (h) => { if (timer === h) timer = null; },
  });
  const advance = (ms) => {
    const target = t + ms;
    while (timer && timer.at <= target) { t = timer.at; const f = timer; timer = null; f.cb(); }
    t = target;
  };
  return { s, applied, advance, pending: () => timer !== null };
}

test('a lone box applies at once', () => {
  const { s, applied } = settler();
  s.push(400, 700);
  assert.deepEqual(applied, [[400, 700, 0]]);
});

test('a burst applies its first box now and only its last box after it settles', () => {
  const { s, applied, advance } = settler();
  s.push(400, 700);                        // keyboard starts sliding
  for (let h = 690; h >= 400; h -= 10) { advance(16); s.push(400, h); }   // 30 frames
  assert.deepEqual(applied, [[400, 700, 0]], 'nothing applied mid-slide');
  advance(120);
  assert.equal(applied.length, 2);
  assert.deepEqual(applied[1].slice(0, 2), [400, 400]);
});

test('boxes further apart than the delay each apply immediately', () => {
  const { s, applied, advance } = settler();
  s.push(400, 700);
  advance(500);
  s.push(400, 420);
  advance(500);
  s.push(800, 420);
  assert.deepEqual(applied.map((a) => a.slice(0, 2)), [[400, 700], [400, 420], [800, 420]]);
});

test('flush applies a deferred box right away; last() always has the newest', () => {
  const { s, applied, advance, pending } = settler();
  s.push(400, 700);
  advance(16); s.push(400, 650);
  assert.equal(pending(), true);
  assert.deepEqual(s.last(), { w: 400, h: 650 });
  s.flush();
  assert.equal(pending(), false);
  assert.deepEqual(applied.at(-1).slice(0, 2), [400, 650]);
  s.flush();                               // nothing pending: no-op
  assert.equal(applied.length, 2);
});
