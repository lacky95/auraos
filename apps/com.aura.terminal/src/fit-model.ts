// How the terminal grid follows its box.
//
// One formula, used by every caller: cols/rows = floor((box − chrome) / cell).
// There used to be a second opinion — addon-fit's proposeDimensions, run by a
// 5 s watchdog — and the two disagreed by design: with `box-sizing:
// border-box` the computed height of #terminal INCLUDES its padding, and
// addon-fit falls back to a 15 px scrollbar where overlay scrollbars measure
// 0. So the watchdog "repaired" to +1 row / −1 col, the next viewport message
// flipped it back, and every flip was a resize + SIGWINCH + full repaint. The
// watchdog is gone; this module is the only arithmetic.
//
// `settleBoxes` is the other half: the shell posts one box per animation
// frame while the soft keyboard slides or the window is dragged. Applying
// each one reflows the buffer and resizes the PTY ~20 times. Instead the first
// box of a burst applies at once (a window open or a rotation end should not
// wait) and the rest trail: boxes arriving within `delayMs` of the previous
// one are coalesced and only the last is applied.

export interface GridInput {
  boxW: number;
  boxH: number;
  cell: { w: number; h: number };
  /** Pixels around the grid the cells can't use (padding, bar, scrollbar). */
  inset: { x: number; y: number };
}

export function proposeGrid({ boxW, boxH, cell, inset }: GridInput): { cols: number; rows: number } | null {
  if (!(boxW > 0) || !(boxH > 0) || !(cell.w > 0) || !(cell.h > 0)) return null;
  return {
    cols: Math.max(1, Math.floor((boxW - inset.x) / cell.w)),
    rows: Math.max(1, Math.floor((boxH - inset.y) / cell.h)),
  };
}

export interface SettleOptions {
  /** Boxes closer together than this are one burst. */
  delayMs?: number;
  now?: () => number;
  setTimer?: (cb: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export function settleBoxes(
  apply: (w: number, h: number) => void,
  opts: SettleOptions = {},
): { push(w: number, h: number): void; flush(): void; last(): { w: number; h: number } | null } {
  const delayMs = opts.delayMs ?? 120;
  const now = opts.now ?? (() => performance.now());
  const setTimer = opts.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let lastAt = -Infinity;          // when a box was last APPLIED or deferred
  let pending: { w: number; h: number } | null = null;
  let last: { w: number; h: number } | null = null;
  let timer: unknown = null;

  function fire() {
    timer = null;
    if (!pending) return;
    const { w, h } = pending;
    pending = null;
    lastAt = now();
    apply(w, h);
  }

  return {
    push(w, h) {
      last = { w, h };
      const t = now();
      if (timer === null && t - lastAt > delayMs) {
        lastAt = t;
        apply(w, h);
        return;
      }
      // Inside a burst: keep only the newest box, (re)arm the trailing timer.
      pending = { w, h };
      lastAt = t;
      if (timer !== null) clearTimer(timer);
      timer = setTimer(fire, delayMs);
    },
    /** Apply a deferred box now (e.g. before a replay must reflow into it). */
    flush() {
      if (timer !== null) { clearTimer(timer); fire(); }
    },
    last: () => last,
  };
}
