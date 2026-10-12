import { stdout } from 'node:process';
import { moveCursor, clearScreenDown } from 'node:readline';

/**
 * Frame helpers shared by the in-place pickers (`aura jump`, lib/prompts.ts).
 *
 * Every picker redraws by moving the cursor up over its previous frame. That
 * only works while the frame is honest about its height, so a frame must:
 *   • be at most rows-1 physical lines — a taller one scrolls the screen, the
 *     cursor-up move then silently stops at row 0, and every redraw after it
 *     lands lower than the last;
 *   • never hard-wrap — a wrapped line is two rows but one '\n', which
 *     desyncs the line count. Hence every line is clipped to cols-1.
 *
 * The pickers emit only ASCII plus single-cell symbols (▸ ● ◐ ◆ ─ ↑ ↓ ↵ ✓ …),
 * so char-count equals column-count — no wcwidth table needed.
 */

export const SGR_RESET = '\x1b[0m';
const ANSI_SGR_RE = /\x1b\[[0-9;]*m/g;

/** Printable width of a string, ignoring SGR color sequences. */
export function visibleWidth(s: string): number {
  return s.replace(ANSI_SGR_RE, '').length;
}

/** Clip a colored line to `maxCols` terminal cells without splitting SGR
 *  sequences. Clipped lines end in '…' plus a reset so an open color never
 *  bleeds into the next row. */
export function truncateAnsi(s: string, maxCols: number): string {
  if (visibleWidth(s) <= maxCols) return s;
  const keep = Math.max(0, maxCols - 1); // leave one cell for the ellipsis
  let out = '';
  let width = 0;
  for (let i = 0; i < s.length; ) {
    if (s[i] === '\x1b') {
      const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
      if (m) { out += m[0]; i += m[0].length; continue; }
    }
    if (width >= keep) break;
    out += s[i];
    width++;
    i++;
  }
  return out + '…' + SGR_RESET;
}

/** A fixed-width column: clipped to `width` cells, then padded to it. Pads by
 *  VISIBLE width, so a colored label lines up with a plain one. */
export function fitAnsi(s: string, width: number): string {
  const clipped = truncateAnsi(s, width);
  return clipped + ' '.repeat(Math.max(0, width - visibleWidth(clipped)));
}

/** Current terminal size, with the usual fallbacks for a missing TTY size. */
export function termSize(): { rows: number; cols: number } {
  return { rows: stdout.rows || 24, cols: stdout.columns || 80 };
}

/**
 * Move back to the top of the previous frame and clear it. Clamped to rows-1:
 * after a shrink-resize the old frame may be taller than the screen, and the
 * terminal would undershoot a larger move anyway.
 */
export function rewind(linesWritten: number): void {
  if (linesWritten <= 0) return;
  moveCursor(stdout, 0, -Math.min(linesWritten, termSize().rows - 1));
  clearScreenDown(stdout);
}

/** Write a frame, every line clipped to cols-1; returns its height. */
export function writeFrame(lines: string[]): number {
  const cols = termSize().cols;
  stdout.write(lines.map((l) => truncateAnsi(l, Math.max(1, cols - 1))).join('\n') + '\n');
  return lines.length;
}

/**
 * The help-line items that fit in `width` cells. Lower `prio` = more
 * essential: those are kept first, but the survivors render in their original
 * order so the line still reads naturally.
 */
export function fitHints(items: Array<{ text: string; prio: number }>, width: number, sep = '   '): string {
  const order = items.map((it, i) => ({ ...it, i })).sort((a, b) => a.prio - b.prio || a.i - b.i);
  const kept = new Set<number>();
  let used = 0;
  for (const it of order) {
    const add = visibleWidth(it.text) + (kept.size ? sep.length : 0);
    if (used + add > width) continue;
    kept.add(it.i);
    used += add;
  }
  return items.filter((_, i) => kept.has(i)).map((it) => it.text).join(sep);
}

/**
 * First visible row of a `size`-row window over `total` rows that keeps
 * `cursor` in view. Moves only when the cursor would leave the window, so the
 * list doesn't shift under the user on every keypress.
 */
export function scrollWindow(total: number, cursor: number, size: number, top: number): number {
  if (total <= size) return 0;
  if (cursor < top) top = cursor;
  if (cursor >= top + size) top = cursor - size + 1;
  return Math.max(0, Math.min(top, total - size));
}
