// Touch drags on the terminal turn into whole-row steps — scrollLines, or wheel
// notches while the program has mouse tracking on: one finger or two, slow
// drags included, and nothing reaches xterm's own touch handler.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachTouchScroll } from '../src/touch-scroll.ts';

const ROW = 20;

// changed = how many of the touches are new/lifted (1, like a real finger).
function touch(type, ys, changed = 1) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  e.touches = ys.map((clientY) => ({ clientX: 100, clientY }));
  e.changedTouches = { length: changed };
  return e;
}

function setup({ mouseTrackingMode = 'none' } = {}) {
  const container = new EventTarget();
  const scrolled = [];
  const wheeled = [];
  const term = { scrollLines: (n) => scrolled.push(n), modes: { mouseTrackingMode } };
  let t = 0;
  const frames = [];
  attachTouchScroll(container, term, {
    rowHeight: () => ROW,
    wheel: (rows, x, y) => wheeled.push({ rows, x, y }),
    now: () => t,
    raf: (cb) => { frames.push(cb); return frames.length; },
    caf: () => { frames.length = 0; },
  });
  const send = (type, ys, dt = 16) => { t += dt; const e = touch(type, ys); container.dispatchEvent(e); return e; };
  const runFrames = (max = 1000) => { let n = 0; while (frames.length && n++ < max) { t += 16; frames.shift()(); } };
  const total = () => scrolled.reduce((a, b) => a + b, 0);
  const wheelTotal = () => wheeled.reduce((a, w) => a + w.rows, 0);
  return { send, runFrames, total, wheelTotal, scrolled, wheeled, frames, term };
}

test('one-finger drag down scrolls back through history, up scrolls forward', () => {
  const s = setup();
  s.send('touchstart', [500]);
  for (let y = 500; y <= 700; y += 20) s.send('touchmove', [y]);  // finger moves down 200px
  s.send('touchend', [], 500);                                     // paused → no fling
  assert.equal(s.total(), -10);
  s.send('touchstart', [700]);
  for (let y = 700; y >= 600; y -= 20) s.send('touchmove', [y]);
  s.send('touchend', [], 500);
  assert.equal(s.total(), -5);
});

test('a slow drag (sub-row moves) still scrolls', () => {
  const s = setup();
  s.send('touchstart', [500]);
  for (let i = 1; i <= 30; i++) s.send('touchmove', [500 + i * 2]); // 2px per move, 60px total
  s.send('touchend', [], 500);
  assert.equal(s.total(), -3);
});

test('two-finger vertical drag scrolls by the fingers\' average', () => {
  const s = setup();
  s.send('touchstart', [400]);
  s.send('touchstart', [400, 440]);         // second finger lands — no jump
  assert.equal(s.total(), 0);
  for (let d = 20; d <= 100; d += 20) s.send('touchmove', [400 - d, 440 - d]);
  s.send('touchend', [], 500);
  assert.equal(s.total(), 5);
});

test('touchmove is cancelled and stopped so xterm/the page do not also handle it', () => {
  const s = setup();
  s.send('touchstart', [300]);
  const e = s.send('touchmove', [280]);
  assert.equal(e.defaultPrevented, true);
});

test('a flick keeps coasting after release, and a new touch stops it', () => {
  const s = setup();
  s.send('touchstart', [600]);
  for (let y = 560; y >= 360; y -= 40) s.send('touchmove', [y], 10); // fast upward flick
  const atRelease = s.total();
  s.send('touchend', [], 5);
  s.runFrames(5);
  assert.ok(s.total() > atRelease, 'fling should keep scrolling');
  s.send('touchstart', [300]);
  assert.equal(s.frames.length, 0, 'touch stops the fling');
});

test('with mouse tracking on, a drag scrolls the program by wheel notches instead', () => {
  const s = setup({ mouseTrackingMode: 'vt200' });
  s.send('touchstart', [500]);
  const e = s.send('touchmove', [600]);                            // finger down 100px
  s.send('touchend', [], 500);
  assert.equal(s.total(), 0, 'scrollback untouched');
  assert.equal(s.wheelTotal(), -5);
  assert.deepEqual(s.wheeled[0], { rows: -5, x: 100, y: 600 });
  assert.equal(e.defaultPrevented, true, 'no native pan under the terminal');
});

test('a fling in mouse mode keeps sending wheel notches', () => {
  const s = setup({ mouseTrackingMode: 'vt200' });
  s.send('touchstart', [600]);
  for (let y = 560; y >= 360; y -= 40) s.send('touchmove', [y], 10);
  const atRelease = s.wheelTotal();
  s.send('touchend', [], 5);
  s.runFrames(5);
  assert.ok(s.wheelTotal() > atRelease);
  assert.equal(s.total(), 0);
});

test('mouse mode switching mid-fling routes the remaining rows to the new target', () => {
  const s = setup();
  s.send('touchstart', [600]);
  for (let y = 560; y >= 360; y -= 40) s.send('touchmove', [y], 10);
  s.send('touchend', [], 5);
  s.runFrames(3);
  s.term.modes.mouseTrackingMode = 'vt200';
  s.runFrames(5);
  assert.ok(s.wheelTotal() > 0);
});

test('a lost touchend does not leak into the next gesture', () => {
  const s = setup();
  s.send('touchstart', [500]);
  s.send('touchmove', [510]);                                      // 10px carry, then touchend lost
  s.send('touchstart', [300], 1);                                  // fresh single-finger gesture
  s.send('touchmove', [289]);                                      // 11px: < 1 row on its own
  assert.equal(s.total(), 0, 'stale carry must not complete a row');
});

test('a repeat flick during a coast builds on its speed', () => {
  const flick = (s) => {
    s.send('touchstart', [600]);
    for (let y = 560; y >= 360; y -= 40) s.send('touchmove', [y], 10);
    s.send('touchend', [], 5);
  };
  const single = setup();
  flick(single);
  single.runFrames(2);
  const before = single.total();
  single.runFrames(30);
  const singleCoast = single.total() - before;

  const double = setup();
  flick(double);
  double.runFrames(2);
  flick(double);
  const before2 = double.total();
  double.runFrames(30);
  assert.ok(double.total() - before2 > singleCoast, 'second flick coasts faster');
});

test('a drag keeps scrolling after its start element is re-rendered away (detached target)', () => {
  // xterm's DOM renderer replaces styled spans on redraw; touch events keep
  // going to the old, detached span and never reach the container again.
  const container = new EventTarget();
  const span = new EventTarget();
  const scrolled = [];
  const term = { scrollLines: (n) => scrolled.push(n), modes: { mouseTrackingMode: 'none' } };
  let t = 0;
  attachTouchScroll(container, term, { rowHeight: () => ROW, now: () => t, raf: () => 1, caf: () => {} });
  const ev = (type, ys) => {
    t += 16;
    const e = touch(type, ys);
    Object.defineProperty(e, 'target', { value: span });
    return e;
  };
  container.dispatchEvent(ev('touchstart', [500]));              // still attached: reaches container
  const first = ev('touchmove', [540]);
  container.dispatchEvent(first);                               // attached: container…
  span.dispatchEvent(first);                                    // …and target both see it — counted once
  assert.equal(scrolled.reduce((a, b) => a + b, 0), -2);
  for (let y = 580; y <= 700; y += 40) {                        // now detached: only the span gets them
    const e = ev('touchmove', [y]);
    span.dispatchEvent(e);
    assert.equal(e.defaultPrevented, true);
  }
  assert.equal(scrolled.reduce((a, b) => a + b, 0), -10);
  span.dispatchEvent(ev('touchend', []));
  span.dispatchEvent(ev('touchmove', [800]));                   // gesture over: listeners removed
  assert.equal(scrolled.reduce((a, b) => a + b, 0), -10);
});

// ── long-press hook ──────────────────────────────────────────────────────

function setupPress({ claim = true } = {}) {
  const container = new EventTarget();
  const scrolled = [];
  const calls = [];
  let t = 0;
  let timer = null;
  attachTouchScroll(container, { scrollLines: (n) => scrolled.push(n), modes: { mouseTrackingMode: 'none' } }, {
    rowHeight: () => ROW,
    now: () => t,
    raf: () => 1,
    caf: () => {},
    setTimer: (cb, ms) => { timer = { cb, ms }; return timer; },
    clearTimer: (h) => { if (timer === h) timer = null; },
    longPress: {
      start: (x, y) => { calls.push(['start', x, y]); return claim; },
      move: (x, y) => calls.push(['move', x, y]),
      end: () => calls.push(['end']),
      tap: (x, y) => { calls.push(['tap', x, y]); },
    },
  });
  const send = (type, ys, dt = 16, changed = 1) => { t += dt; const e = touch(type, ys, changed); container.dispatchEvent(e); return e; };
  const fire = () => { const f = timer; timer = null; f?.cb(); };
  return { send, fire, calls, scrolled, armed: () => timer !== null, timerMs: () => timer?.ms };
}

test('holding one finger still hands the gesture to longPress — no scrolling', () => {
  const s = setupPress();
  s.send('touchstart', [500]);
  assert.ok(s.armed());
  s.send('touchmove', [504]);                    // within slop: still a press candidate
  s.fire();
  assert.deepEqual(s.calls[0], ['start', 100, 504]);
  for (let y = 520; y <= 700; y += 20) s.send('touchmove', [y]);
  const end = s.send('touchend', [], 5);
  assert.equal(s.scrolled.length, 0, 'press moves never scroll');
  assert.deepEqual(s.calls.at(-2), ['move', 100, 700]);
  assert.deepEqual(s.calls.at(-1), ['end']);
  assert.equal(end.defaultPrevented, true, 'no click after a press');
});

test('moving past the slop first is a plain scroll and never a press', () => {
  const s = setupPress();
  s.send('touchstart', [500]);
  s.send('touchmove', [520]);
  assert.equal(s.armed(), false);
  for (let y = 540; y <= 600; y += 20) s.send('touchmove', [y]);
  s.send('touchend', [], 500);
  assert.equal(s.calls.length, 0);
  assert.equal(s.scrolled.reduce((a, b) => a + b, 0), -5);
});

test('a second finger cancels the long-press', () => {
  const s = setupPress();
  s.send('touchstart', [500]);
  s.send('touchstart', [500, 540]);
  assert.equal(s.armed(), false);
});

test('a declined long-press leaves the gesture scrolling', () => {
  const s = setupPress({ claim: false });
  s.send('touchstart', [500]);
  s.fire();
  for (let y = 520; y <= 600; y += 20) s.send('touchmove', [y]);
  const end = s.send('touchend', [], 500);
  assert.equal(s.scrolled.reduce((a, b) => a + b, 0), -5);
  assert.equal(end.defaultPrevented, false);
  assert.ok(!s.calls.some((c) => c[0] === 'tap'), 'a long hold is not a tap');
});

test('with a long-press hook every touchstart is cancelled, and each tap goes to tap()', () => {
  const s = setupPress();
  const start = s.send('touchstart', [300]);
  assert.equal(start.defaultPrevented, true, 'no compat mouse events / focus change / native long-press');
  s.send('touchend', [], 80);
  assert.deepEqual(s.calls, [['tap', 100, 300]]);
});

test('a drag or a two-finger touch is not a tap', () => {
  const s = setupPress();
  s.send('touchstart', [300]);
  s.send('touchmove', [340]);
  s.send('touchend', [], 80);
  s.send('touchstart', [300]);
  s.send('touchstart', [300, 340]);
  s.send('touchend', [300], 20);
  s.send('touchend', [], 20);
  assert.equal(s.calls.length, 0);
});

test('without a long-press hook touchstart is left alone (the browser clicks)', () => {
  const s = setup();
  const start = s.send('touchstart', [300]);
  assert.equal(start.defaultPrevented, false);
});
