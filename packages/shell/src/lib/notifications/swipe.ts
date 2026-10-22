/**
 * Swipe-right-to-hide for pop-ups (phase 4) — DOM-free gesture logic.
 *
 * Same meaning as the pop-up ✕: hide only, keep UNREAD, nothing sent.
 *   - touch / pen only; never from the pop-up's own controls;
 *   - the axis locks after AXIS_LOCK_PX of movement: horizontal → the
 *     pop-up follows the finger (opacity falls), vertical → the page /
 *     stack scrolls as usual (`touch-action: pan-y` on the pop-up);
 *   - release: ≥ HIDE_FRACTION of the width to the right, or a rightward
 *     fling ≥ FLING_PX_PER_MS → hide (finish the slide from where it is);
 *     otherwise spring back;
 *   - leftward drags are resisted (rubber band, at most LEFT_MAX_PX) and
 *     always spring back;
 *   - a horizontal swipe is never a click (no seen, no open).
 */
export const AXIS_LOCK_PX = 10;
export const HIDE_FRACTION = 0.35;
export const FLING_PX_PER_MS = 0.5;
export const LEFT_RESISTANCE = 0.25;
export const LEFT_MAX_PX = 24;
export const SPRING_MS = 150;

export type SwipeAxis = 'pending' | 'horizontal' | 'vertical';
export type SwipeResult = 'hide' | 'spring' | 'none';

/** Should this pointerdown start tracking a swipe? */
export function startsSwipe(pointerType: string, onControl: boolean): boolean {
  return (pointerType === 'touch' || pointerType === 'pen') && !onControl;
}

export class SwipeTracker {
  private x0 = 0;
  private y0 = 0;
  private last: { x: number; t: number } = { x: 0, t: 0 };
  private prev: { x: number; t: number } = { x: 0, t: 0 };
  axis: SwipeAxis = 'pending';

  constructor(private readonly width: number) {}

  start(x: number, y: number, t: number): void {
    this.x0 = x; this.y0 = y;
    this.last = { x, t }; this.prev = { x, t };
    this.axis = 'pending';
  }

  /** The visual state for a move: horizontal offset (px) and opacity. */
  move(x: number, y: number, t: number): { axis: SwipeAxis; offset: number; opacity: number } {
    const dx = x - this.x0;
    const dy = y - this.y0;
    if (this.axis === 'pending' && Math.hypot(dx, dy) >= AXIS_LOCK_PX) {
      this.axis = Math.abs(dx) > Math.abs(dy) ? 'horizontal' : 'vertical';
    }
    this.prev = this.last;
    this.last = { x, t };
    if (this.axis !== 'horizontal') return { axis: this.axis, offset: 0, opacity: 1 };
    const offset = this.offsetFor(dx);
    const opacity = offset > 0 ? Math.max(0, 1 - offset / Math.max(1, this.width)) : 1;
    return { axis: this.axis, offset, opacity };
  }

  /** Rubber band to the left, free to the right. */
  offsetFor(dx: number): number {
    if (dx >= 0) return dx;
    return -Math.min(LEFT_MAX_PX, -dx * LEFT_RESISTANCE);
  }

  /** Release: hide, spring back, or 'none' (not a horizontal swipe — a tap or a scroll). */
  end(x: number, t: number): SwipeResult {
    if (this.axis !== 'horizontal') return 'none';
    const dx = x - this.x0;
    const dt = Math.max(1, t - this.prev.t);
    const v = (x - this.prev.x) / dt;
    if (dx > 0 && (dx >= this.width * HIDE_FRACTION || v >= FLING_PX_PER_MS)) return 'hide';
    return 'spring';
  }

  /** A horizontal gesture happened: the following click must be ignored. */
  get suppressesClick(): boolean { return this.axis === 'horizontal'; }
}
