// Touch text selection for the terminal.
//
// One finger held still selects the word under it (touch-scroll.ts detects the
// long-press and hands the gesture here); dragging on extends the selection
// cell by cell, auto-scrolling at the top/bottom edge. After the finger lifts
// the page shows two handles and a Copy/Paste toolbar (index.astro) — handle
// drags come back in through beginHandle/moveHandle/endHandle.
//
// Everything goes through xterm's programmatic selection (`select`), which
// works whether or not the program has mouse tracking on — xterm only disables
// its MOUSE selection then. The selection itself is read back from
// `getSelectionPosition` every time instead of being kept here, because xterm
// shifts it when scrollback trims and clears it when the user types.
//
// One exception: xterm also clears the selection on EVERY mouse-tracking
// DECSET, even one that doesn't change the mode — and a TUI repainting after
// a SIGWINCH re-sends its mouse modes. So while a touch selection is shown,
// its range and text are pinned; when xterm drops it and the same cells still
// hold the same text, it is re-selected and the handles stay. A clear the USER
// caused (typing, a mouse click — the page reports those via `userActed`)
// unpins first, so those still dismiss the selection as they always did.

export interface SelectCell {
  getChars(): string;
  getWidth(): number;
}
export interface SelectLine {
  readonly isWrapped: boolean;
  getCell(x: number): SelectCell | undefined;
}
export interface SelectTerminal {
  readonly cols: number;
  readonly rows: number;
  readonly buffer: { readonly active: { readonly viewportY: number; readonly length: number; getLine(y: number): SelectLine | undefined } };
  select(column: number, row: number, length: number): void;
  selectAll(): void;
  clearSelection(): void;
  hasSelection(): boolean;
  getSelection(): string;
  getSelectionPosition(): { start: { x: number; y: number }; end: { x: number; y: number } } | undefined;
  scrollLines(amount: number): void;
  paste(data: string): void;
}

export interface TouchSelectOptions {
  /** Client rect of `.xterm-screen` (the cell grid). */
  screen: () => { left: number; top: number; width: number; height: number } | null;
  /** Current cell size in CSS px. */
  cell: () => { w: number; h: number };
  /** Touch selection became visible (true) or went away (false). */
  onChange?: (active: boolean) => void;
  vibrate?: (ms: number) => void;
  clipboard?: {
    writeText?: (text: string) => Promise<void>;
    readText?: () => Promise<string>;
  } | null;
  /** Last-resort copy for contexts without the async clipboard. */
  fallbackCopy?: (text: string) => boolean;
  setInterval?: (cb: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

/** An absolute buffer cell. */
export interface Pos { col: number; row: number }

export interface SelectLayout {
  /** Bottom-left corner of the first cell, bottom-right of the last (client px);
   *  `visible` is false while that row is scrolled off-screen. */
  start: { x: number; y: number; visible: boolean };
  end: { x: number; y: number; visible: boolean };
  /** Top edge of the topmost visible selected row and bottom edge of the
   *  bottommost one — where the toolbar goes. */
  top: number;
  bottom: number;
}

// Auto-scroll while dragging near an edge: one row per tick.
const EDGE_SCROLL_MS = 60;
// A word never grows past this many cells (a screenful of non-space).
const MAX_WORD = 4000;

function cmp(a: Pos, b: Pos): number {
  return a.row - b.row || a.col - b.col;
}

export function attachTouchSelect(term: SelectTerminal, opts: TouchSelectOptions) {
  const setIv = opts.setInterval ?? ((cb, ms) => setInterval(cb, ms));
  const clearIv = opts.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));

  let active = false;                       // a touch-made selection is shown
  // The part that stays put while a finger drags: the long-pressed word, or
  // the far handle. The selection spans from it to the finger.
  let fixed: { start: Pos; end: Pos } | null = null;
  let lastX = 0;
  let lastY = 0;
  let edgeTimer: unknown = null;
  let edgeDir = 0;
  let pinned: { start: Pos; end: Pos; text: string } | null = null;
  let reapplying = false;

  function setActive(on: boolean) {
    if (active === on) return;
    active = on;
    opts.onChange?.(on);
  }

  /** Client point → absolute buffer cell, clamped to the grid. */
  function cellAt(x: number, y: number): Pos | null {
    const r = opts.screen();
    const { w, h } = opts.cell();
    if (!r || !(w > 0) || !(h > 0)) return null;
    const col = Math.min(term.cols - 1, Math.max(0, Math.floor((x - r.left) / w)));
    const vrow = Math.min(term.rows - 1, Math.max(0, Math.floor((y - r.top) / h)));
    return { col, row: vrow + term.buffer.active.viewportY };
  }

  function isBlank(p: Pos): boolean {
    const cell = term.buffer.active.getLine(p.row)?.getCell(p.col);
    if (!cell) return true;
    if (cell.getWidth() === 0) return false;  // right half of a wide char
    const c = cell.getChars();
    return c === '' || /\s/.test(c);
  }

  /** The neighbouring cell, following soft-wrapped lines; null at a hard edge. */
  function step(p: Pos, dir: 1 | -1): Pos | null {
    const buf = term.buffer.active;
    if (dir < 0) {
      if (p.col > 0) return { col: p.col - 1, row: p.row };
      return buf.getLine(p.row)?.isWrapped ? { col: term.cols - 1, row: p.row - 1 } : null;
    }
    if (p.col < term.cols - 1) return { col: p.col + 1, row: p.row };
    return p.row + 1 < buf.length && buf.getLine(p.row + 1)?.isWrapped ? { col: 0, row: p.row + 1 } : null;
  }

  /** The run of non-blank cells around `p` (paths and URLs stay whole). A
   *  blank cell selects just itself. */
  function wordAt(p: Pos): { start: Pos; end: Pos } {
    if (isBlank(p)) return { start: p, end: p };
    let start = p;
    let end = p;
    for (let n = 0, q = step(start, -1); q && !isBlank(q) && n < MAX_WORD; n++, q = step(start, -1)) start = q;
    for (let n = 0, q = step(end, 1); q && !isBlank(q) && n < MAX_WORD; n++, q = step(end, 1)) end = q;
    // Include the right half of a trailing wide char.
    const after = step(end, 1);
    if (after && term.buffer.active.getLine(after.row)?.getCell(after.col)?.getWidth() === 0) end = after;
    return { start, end };
  }

  /** Select `start..end` inclusive (either order). */
  function apply(a: Pos, b: Pos) {
    const [s, e] = cmp(a, b) <= 0 ? [a, b] : [b, a];
    term.select(s.col, s.row, (e.row - s.row) * term.cols + e.col - s.col + 1);
    pinned = { start: s, end: e, text: term.getSelection() };
  }

  /** The current selection as inclusive cells, from xterm. */
  function range(): { start: Pos; end: Pos } | null {
    const r = term.hasSelection() ? term.getSelectionPosition() : undefined;
    if (!r) return null;
    const start = { col: r.start.x, row: r.start.y };
    // xterm's end is exclusive.
    const end = r.end.x > 0 ? { col: Math.min(r.end.x, term.cols) - 1, row: r.end.y } : { col: term.cols - 1, row: r.end.y - 1 };
    return { start, end };
  }

  function track() {
    if (!fixed) return;
    const p = cellAt(lastX, lastY);
    if (!p) return;
    if (cmp(p, fixed.start) < 0) apply(p, fixed.end);
    else if (cmp(p, fixed.end) > 0) apply(fixed.start, p);
    else apply(fixed.start, fixed.end);
  }

  function edgeScroll() {
    const r = opts.screen();
    const { h } = opts.cell();
    const dir = !r ? 0 : lastY < r.top + h / 2 ? -1 : lastY > r.top + r.height - h / 2 ? 1 : 0;
    if (dir === edgeDir) return;
    edgeDir = dir;
    if (edgeTimer !== null) { clearIv(edgeTimer); edgeTimer = null; }
    if (dir) edgeTimer = setIv(() => { term.scrollLines(edgeDir); track(); }, EDGE_SCROLL_MS);
  }

  function stopDrag() {
    fixed = null;
    edgeDir = 0;
    if (edgeTimer !== null) { clearIv(edgeTimer); edgeTimer = null; }
  }

  function dragTo(x: number, y: number) {
    lastX = x;
    lastY = y;
    track();
    edgeScroll();
  }

  /** The long-press hook for attachTouchScroll. */
  const hook = {
    start(x: number, y: number): boolean {
      const p = cellAt(x, y);
      if (!p) return false;
      fixed = wordAt(p);
      lastX = x;
      lastY = y;
      apply(fixed.start, fixed.end);
      opts.vibrate?.(10);
      setActive(false);          // hide handles/toolbar while the finger is down
      return true;
    },
    move: dragTo,
    end() {
      stopDrag();
      setActive(term.hasSelection());
    },
    /** A tap while a touch selection is shown clears it; true = it did, so
     *  the tap must not also click into the program. */
    tap(): boolean {
      if (!active) return false;
      clear();
      return true;
    },
  };

  function clear() {
    stopDrag();
    pinned = null;
    term.clearSelection();
    setActive(false);
  }

  /** xterm dropped the selection behind our back: put it back if the text
   *  under it is unchanged (a repaint), otherwise it is really gone. */
  function repin(): boolean {
    if (!pinned || reapplying) return false;
    reapplying = true;
    try {
      const { start, end, text } = pinned;
      apply(start, end);
      if (term.hasSelection() && term.getSelection() === text) return true;
      term.clearSelection();
      return false;
    } finally { reapplying = false; }
  }

  return {
    hook,
    isActive: () => active,
    clear,
    selectAll() {
      term.selectAll();
      pinned = null;                 // select-all has no cell range to pin
      setActive(term.hasSelection());
    },
    /** Start dragging a handle: the OTHER end stays put. */
    beginHandle(which: 'start' | 'end') {
      const r = range();
      if (!r) return;
      const p = which === 'start' ? r.end : r.start;
      fixed = { start: p, end: p };
    },
    moveHandle: dragTo,
    endHandle() { stopDrag(); },
    /** The user typed or clicked: a selection clear that follows is theirs. */
    userActed() { pinned = null; },
    /** Call when xterm's selection changed — a repaint, a click or typing may
     *  have cleared it behind our back. */
    selectionChanged() {
      if (reapplying || !active || term.hasSelection()) return;
      if (repin()) return;
      pinned = null;
      stopDrag();
      setActive(false);
    },
    layout(): SelectLayout | null {
      const r = range();
      const box = opts.screen();
      const { w, h } = opts.cell();
      if (!r || !box || !(w > 0) || !(h > 0)) return null;
      const top = term.buffer.active.viewportY;
      const vis = (row: number) => row >= top && row < top + term.rows;
      const yOf = (row: number) => box.top + (row - top) * h;
      const firstRow = Math.max(r.start.row, top);
      const lastRow = Math.min(r.end.row, top + term.rows - 1);
      return {
        start: { x: box.left + r.start.col * w, y: yOf(r.start.row) + h, visible: vis(r.start.row) },
        end: { x: box.left + (r.end.col + 1) * w, y: yOf(r.end.row) + h, visible: vis(r.end.row) },
        top: yOf(firstRow),
        bottom: yOf(lastRow) + h,
      };
    },
    /** Copy the selection. Call from a click handler (needs a user gesture). */
    async copy(): Promise<boolean> {
      const text = term.getSelection();
      if (!text) return false;
      try {
        if (opts.clipboard?.writeText) { await opts.clipboard.writeText(text); return true; }
      } catch { /* not allowed here — try the fallback */ }
      return opts.fallbackCopy?.(text) ?? false;
    },
    /** Paste the clipboard into the program. False when reading isn't allowed. */
    async paste(): Promise<boolean> {
      try {
        if (!opts.clipboard?.readText) return false;
        const text = await opts.clipboard.readText();
        if (text) term.paste(text);
        return true;
      } catch { return false; }
    },
  };
}

export type TouchSelect = ReturnType<typeof attachTouchSelect>;
