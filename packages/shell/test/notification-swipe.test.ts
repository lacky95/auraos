// Swipe-right-to-hide gesture (phase 4). DOM-free.
//
//   cd packages/shell && npx tsx --test test/notification-swipe.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AXIS_LOCK_PX, LEFT_MAX_PX, SwipeTracker, startsSwipe } from '../src/lib/notifications/swipe.ts';

test('threshold: ≥ 35 % of the width hides, less springs back', () => {
  const s = new SwipeTracker(300);
  s.start(0, 0, 0); s.move(20, 1, 100); s.move(110, 2, 1000);
  assert.equal(s.end(110, 1400), 'hide');
  const b = new SwipeTracker(300);
  b.start(0, 0, 0); b.move(20, 0, 100); b.move(90, 0, 1000);
  assert.equal(b.end(90, 1400), 'spring');
});

test('fling: a fast rightward flick hides even when short', () => {
  const s = new SwipeTracker(300);
  s.start(0, 0, 0); s.move(15, 0, 10); s.move(60, 0, 60);
  assert.equal(s.end(60, 60), 'hide', '45px in 50ms = 0.9 px/ms');
});

test('axis lock after ~10px: vertical keeps scrolling (no offset, not a swipe)', () => {
  const s = new SwipeTracker(300);
  s.start(0, 0, 0);
  assert.equal(s.move(3, 4, 10).axis, 'pending', 'below the lock distance');
  const v = s.move(4, AXIS_LOCK_PX + 20, 50);
  assert.equal(v.axis, 'vertical');
  assert.equal(v.offset, 0);
  assert.equal(s.move(200, 30, 100).offset, 0, 'locked vertical stays vertical');
  assert.equal(s.end(200, 120), 'none');
  assert.equal(s.suppressesClick, false);
});

test('left drags are resisted (rubber band) and spring back', () => {
  const s = new SwipeTracker(300);
  s.start(200, 0, 0);
  s.move(185, 0, 10);
  const m = s.move(20, 0, 100);
  assert.equal(m.axis, 'horizontal');
  assert.equal(m.offset, -LEFT_MAX_PX, 'capped');
  assert.equal(m.opacity, 1);
  assert.equal(s.end(20, 120), 'spring');
});

test('controls never start a swipe; mouse does not either; a swipe is never a click', () => {
  assert.equal(startsSwipe('touch', false), true);
  assert.equal(startsSwipe('pen', false), true);
  assert.equal(startsSwipe('touch', true), false, 'inputs / buttons / links / ⋯');
  assert.equal(startsSwipe('mouse', false), false);
  const s = new SwipeTracker(300);
  s.start(0, 0, 0); s.move(30, 0, 50);
  assert.equal(s.suppressesClick, true);
  const tap = new SwipeTracker(300);
  tap.start(0, 0, 0); tap.move(2, 1, 30);
  assert.equal(tap.end(2, 40), 'none');
  assert.equal(tap.suppressesClick, false, 'a tap keeps the click rules');
});

test('opacity falls as it moves right', () => {
  const s = new SwipeTracker(200);
  s.start(0, 0, 0); s.move(20, 0, 10);
  assert.ok(s.move(100, 0, 50).opacity < 0.6);
});
