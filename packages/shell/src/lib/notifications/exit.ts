/**
 * Exit-animation state machine for dialogues (phase 4) — DOM-free.
 *
 *   open ──hide()──▶ exiting ──end() / timeout──▶ gone
 *            │           │
 *            │           └─cancel() (reopened mid-exit)──▶ open
 *            └─hide({instant:true})──────────────────────▶ gone
 *
 * A second hide() while exiting is ignored; `onGone` runs exactly once.
 * The timeout is the safety net when `animationend` never fires (hidden
 * element, reduced motion, interrupted animation). Lock / wipe hides are
 * instant (privacy) — the caller passes `instant`.
 */
export type ExitState = 'open' | 'exiting' | 'gone';

export interface ExitTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const EXIT_MS = 200;
/** Fallback a bit after the animation (it never gets stuck). */
export const EXIT_FALLBACK_MS = EXIT_MS + 120;

export class ExitMachine {
  private s: ExitState = 'open';
  private timer: unknown = null;
  private onGone: (() => void) | null = null;

  constructor(private readonly timers: ExitTimers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) }) {}

  get state(): ExitState { return this.s; }

  /** Start hiding. Returns false when already exiting / gone (ignored). */
  hide(onGone: () => void, opts: { instant?: boolean } = {}): boolean {
    if (this.s === 'gone') return false;
    if (this.s === 'exiting') {
      if (opts.instant) { this.finish(); return true; }   // a lock overtakes the animation
      return false;
    }
    this.onGone = onGone;
    if (opts.instant) { this.finish(); return true; }
    this.s = 'exiting';
    this.timer = this.timers.set(() => this.finish(), EXIT_FALLBACK_MS);
    return true;
  }

  /** The exit animation ended (`animationend`). */
  end(): void { if (this.s === 'exiting') this.finish(); }

  /** Reopened mid-exit: back to open, `onGone` never runs. */
  cancel(): boolean {
    if (this.s !== 'exiting') return false;
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
    this.onGone = null;
    this.s = 'open';
    return true;
  }

  private finish(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
    this.s = 'gone';
    const fn = this.onGone;
    this.onGone = null;
    fn?.();
  }
}
