// Touch scrolling for the terminal.
//
// xterm 5.5 ships its own one-finger touch handler, but it nudges the
// viewport's scrollTop by the raw pixel delta and the viewport then rounds that
// to whole rows — the next render snaps scrollTop back to the current row, so a
// slow drag (a few px per touchmove) barely moves, and there is no momentum.
// This replaces it: the finger delta (the average of all fingers, so a
// two-finger drag scrolls too) is accumulated and turned into whole-row steps,
// and a released flick keeps coasting, iOS-style (a repeat flick during a coast
// builds on its speed).
//
// Where a step goes depends on the program inside, re-read on every step:
//   - mouse tracking off → `scrollLines` through xterm's scrollback;
//   - mouse tracking on (vim, htop, Claude Code… — tmux passes a pane's mouse
//     mode through even with `mouse off`) → `wheel`, which the page turns into
//     wheel events so xterm reports them to the program and IT scrolls.
// Touches are never handed back to xterm: in mouse mode its handler steps aside
// without preventDefault, iOS then pans .xterm-viewport natively and xterm
// snaps it back row by row — the "stuck, one line at a time" scroll.
//
// Listeners sit on the terminal's container in the CAPTURE phase and stop the
// touch events there, so xterm's own touch handler never sees them. Only
// touchmove is preventDefault'ed, so a tap still produces the browser's click /
// mouse events. Mouse and real wheel events are not touched. The container
// should also carry `touch-action: none` so iOS never starts a native pan whose
// touchmoves would arrive uncancelable.

export interface TouchScrollTerminal {
  scrollLines(amount: number): void;
  readonly modes: { readonly mouseTrackingMode: string };
}

export interface TouchScrollOptions {
  /** Current row height in CSS px. */
  rowHeight: () => number;
  /** Scroll the program by `rows` wheel notches (positive = down) at a point —
   *  used while it has mouse tracking on. Without it, scrollLines is used. */
  wheel?: (rows: number, clientX: number, clientY: number) => void;
  /** Clock + frame scheduler — injectable for tests. */
  now?: () => number;
  raf?: (cb: () => void) => unknown;
  caf?: (handle: unknown) => void;
}

// Fling tuning: per-ms velocity decay (≈ UIScrollView's normal deceleration)
// and the speed (px/ms) below which a release or a coast stops.
const FRICTION = 0.998;
const MIN_FLING = 0.05;
// Only the motion of the last few moves counts toward a flick's speed, so a
// drag that paused before release doesn't coast.
const VELOCITY_WINDOW_MS = 100;
// A flick that interrupts a coast and lands within this long adds the coast's
// speed to its own (same direction only), so repeated flicks accelerate.
const BOOST_WINDOW_MS = 400;

type Pt = { clientX?: number; clientY: number };

function avg(touches: ArrayLike<Pt>, key: 'clientX' | 'clientY'): number {
  let sum = 0;
  for (let i = 0; i < touches.length; i++) sum += touches[i][key] ?? 0;
  return sum / touches.length;
}

export function attachTouchScroll(
  container: EventTarget,
  term: TouchScrollTerminal,
  opts: TouchScrollOptions,
): () => void {
  const now = opts.now ?? (() => performance.now());
  const raf = opts.raf ?? ((cb) => requestAnimationFrame(cb));
  const caf = opts.caf ?? ((h) => cancelAnimationFrame(h as number));

  let active = false;
  let lastX = 0;
  let lastY = 0;
  let carry = 0;                       // px not yet turned into a whole row
  let samples: { t: number; dy: number }[] = [];
  let fling: unknown = null;
  let flingV = 0;                      // current coast speed, px/ms
  let boostV = 0;                      // speed of the coast this gesture interrupted
  let gestureStart = 0;

  // Positive dy = finger moved up = scroll toward newer output (down).
  function scrollBy(dy: number) {
    const rh = opts.rowHeight();
    if (!(rh > 0)) return;
    carry += dy;
    const rows = carry > 0 ? Math.floor(carry / rh) : Math.ceil(carry / rh);
    if (rows === 0) return;
    carry -= rows * rh;
    if (opts.wheel && term.modes.mouseTrackingMode !== 'none') opts.wheel(rows, lastX, lastY);
    else term.scrollLines(rows);
  }

  /** Stops a coast; returns the speed it was going at (0 if none). */
  function stopFling(): number {
    if (fling === null) return 0;
    caf(fling);
    fling = null;
    return flingV;
  }

  function startFling(v: number) {
    let last = now();
    flingV = v;
    const step = () => {
      const t = now();
      const dt = Math.max(1, t - last);
      last = t;
      flingV *= Math.pow(FRICTION, dt);
      if (Math.abs(flingV) < MIN_FLING) { fling = null; return; }
      scrollBy(flingV * dt);
      fling = raf(step);
    };
    fling = raf(step);
  }

  function onStart(e: TouchEvent) {
    const coasting = stopFling();
    e.stopPropagation();
    // Every finger new → a fresh gesture, even if a lost touchend left us
    // `active`. A finger added mid-gesture just re-anchors on the new average
    // so the jump in the average doesn't register as a scroll.
    const fresh = !active || (e.changedTouches && e.changedTouches.length === e.touches.length);
    if (fresh) {
      carry = 0;
      samples = [];
      boostV = coasting;
      gestureStart = now();
    }
    active = true;
    lastX = avg(e.touches, 'clientX');
    lastY = avg(e.touches, 'clientY');
  }

  function onMove(e: TouchEvent) {
    if (!active || e.touches.length === 0) return;
    e.stopPropagation();
    if (e.cancelable) e.preventDefault();  // no page pan / pinch-zoom under the terminal
    lastX = avg(e.touches, 'clientX');
    const y = avg(e.touches, 'clientY');
    const dy = lastY - y;
    lastY = y;
    if (dy === 0) return;
    const t = now();
    samples.push({ t, dy });
    while (samples.length && t - samples[0].t > VELOCITY_WINDOW_MS) samples.shift();
    scrollBy(dy);
  }

  function onEnd(e: TouchEvent) {
    if (!active) return;
    e.stopPropagation();
    if (e.touches.length > 0) {
      lastX = avg(e.touches, 'clientX');
      lastY = avg(e.touches, 'clientY');
      return;
    }
    active = false;
    if (e.type === 'touchcancel') return;
    const t = now();
    const recent = samples.filter((s) => t - s.t <= VELOCITY_WINDOW_MS);
    samples = [];
    if (recent.length < 2) return;
    const span = Math.max(1, t - recent[0].t);
    let v = recent.reduce((a, s) => a + s.dy, 0) / span;
    if (Math.abs(v) < MIN_FLING * 4) return;
    if (boostV * v > 0 && t - gestureStart <= BOOST_WINDOW_MS) v += boostV;
    startFling(v);
  }

  // A touch's move/end events always go to the element it started on. xterm's
  // DOM renderer replaces a row's styled spans on every redraw — so after the
  // first scrolled row, a touch that began on colored text targets a DETACHED
  // span, its events no longer propagate to the container, and the scroll
  // dies mid-drag (and no touchend ever arrives). So the start target gets
  // listeners too; `seen` keeps an event that reaches both from counting twice.
  let seen: Event | null = null;
  let tracked: EventTarget | null = null;
  const opt = { passive: false } as AddEventListenerOptions;

  const move = (e: Event) => {
    if (e === seen) return;
    seen = e;
    onMove(e as TouchEvent);
  };
  const end = (e: Event) => {
    if (e === seen) return;
    seen = e;
    onEnd(e as TouchEvent);
    if (!active) untrack();
  };
  const start = (e: Event) => {
    if (e === seen) return;
    seen = e;
    onStart(e as TouchEvent);
    const t = e.target;
    if (t && t !== container && t !== tracked) {
      untrack();
      tracked = t;
      t.addEventListener('touchmove', move, opt);
      t.addEventListener('touchend', end, opt);
      t.addEventListener('touchcancel', end, opt);
    }
  };
  function untrack() {
    if (!tracked) return;
    tracked.removeEventListener('touchmove', move, opt);
    tracked.removeEventListener('touchend', end, opt);
    tracked.removeEventListener('touchcancel', end, opt);
    tracked = null;
  }

  const cap = { capture: true, passive: false } as AddEventListenerOptions;
  container.addEventListener('touchstart', start, cap);
  container.addEventListener('touchmove', move, cap);
  container.addEventListener('touchend', end, cap);
  container.addEventListener('touchcancel', end, cap);
  return () => {
    stopFling();
    untrack();
    container.removeEventListener('touchstart', start, cap);
    container.removeEventListener('touchmove', move, cap);
    container.removeEventListener('touchend', end, cap);
    container.removeEventListener('touchcancel', end, cap);
  };
}
