/**
 * Text attributes on a captured screen (TM-17 / B18) — pure, no I/O.
 *
 * get_screen's grid is plain text, so a prompt TUI's faint ghost suggestion in
 * its input line ("yes restart them" in grey) reads exactly like typed input,
 * and an agent once refused to type over it. Generic (TM-18): "faint" is any
 * SGR dim or grey foreground, whichever program draws it. `tmux capture-pane -e` keeps the
 * SGR sequences; this module turns them into:
 *
 *   • markDim(): rows with faint runs (SGR 2, or a grey foreground) wrapped as `⟦dim:…⟧`;
 *   • dimRuns(): the same runs as `{ row, col, text }`;
 *   • ghostText(): the faint/grey tail of the cursor row — placeholder or
 *     suggestion text that is NOT typed input.
 *
 * Columns count code points, like padScreen() does for the plain grid.
 * Node builtins only: the tests import this file under --experimental-strip-types.
 */

export interface StyledCell { ch: string; dim: boolean; grey: boolean; reverse: boolean }

const SGR = /\x1b\[([0-9;:]*)m/y;
const OTHER_ESC = /\x1b(?:\[[0-9;:?<>=]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/y;

/** A grey foreground: bright black (90), the 256-colour grey ramp / 8, or an even RGB in the mid range. */
function isGreyExt(p: number[]): boolean {
  if (p[0] === 5) { const n = p[1] ?? -1; return n === 8 || (n >= 238 && n <= 250); }
  if (p[0] === 2) {
    const [r = 0, g = 0, b = 0] = p.slice(1, 4);
    return Math.max(r, g, b) - Math.min(r, g, b) <= 16 && r >= 90 && r <= 180;
  }
  return false;
}

/** One captured row → cells with the attributes that matter here. */
export function parseStyledLine(line: string): StyledCell[] {
  const cells: StyledCell[] = [];
  let dim = false, grey = false, reverse = false;
  let i = 0;
  while (i < line.length) {
    if (line[i] === '\x1b') {
      SGR.lastIndex = i;
      const m = SGR.exec(line);
      if (m) {
        const ps = m[1] === '' ? [0] : m[1]!.split(/[;:]/).map((x) => (x === '' ? 0 : Number(x)));
        for (let k = 0; k < ps.length; k++) {
          const p = ps[k]!;
          if (p === 0) { dim = false; grey = false; reverse = false; }
          else if (p === 2) dim = true;
          else if (p === 22) dim = false;
          else if (p === 7) reverse = true;
          else if (p === 27) reverse = false;
          else if (p === 90) grey = true;
          else if (p === 39 || (p >= 30 && p <= 37) || (p >= 91 && p <= 97)) grey = false;
          else if (p === 38 || p === 48 || p === 58) {
            const n = ps[k + 1] === 5 ? 2 : ps[k + 1] === 2 ? 4 : 0;
            if (p === 38) grey = isGreyExt(ps.slice(k + 1, k + 2 + n));
            k += n;
          }
        }
        i = SGR.lastIndex;
        continue;
      }
      OTHER_ESC.lastIndex = i;
      if (OTHER_ESC.exec(line)) { i = OTHER_ESC.lastIndex; continue; }
      i++;
      continue;
    }
    const cp = line.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    cells.push({ ch, dim, grey, reverse });
    i += ch.length;
  }
  return cells;
}

/** The row without its escape sequences. */
export function plainOf(line: string): string {
  return parseStyledLine(line).map((c) => c.ch).join('');
}

const isFaint = (c: StyledCell) => c.dim || c.grey;
const RULE_ONLY = /^[\s─-╿]*$/;

/**
 * Faint runs of one row as [start, end) cell ranges: SGR 2 (dim) or a grey
 * foreground — many TUIs draw hints and suggestions in 256-colour or RGB grey
 * (e.g. 38;5;244/246) instead of SGR 2. Whitespace between faint words joins the run;
 * runs of only box-drawing rules are skipped.
 */
function faintRanges(cells: StyledCell[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let c = 0; c < cells.length;) {
    if (!(isFaint(cells[c]!) && cells[c]!.ch.trim())) { c++; continue; }
    const start = c;
    let end = ++c;
    while (c < cells.length && (isFaint(cells[c]!) || !cells[c]!.ch.trim())) {
      c++;
      if (cells[c - 1]!.ch.trim()) end = c;
    }
    c = end;
    if (!RULE_ONLY.test(cells.slice(start, end).map((x) => x.ch).join(''))) out.push([start, end]);
  }
  return out;
}

/** Faint runs as `{ row, col, text }`. */
export function dimRuns(styled: string[]): Array<{ row: number; col: number; text: string }> {
  return styled.flatMap((line, row) => {
    const cells = parseStyledLine(line);
    return faintRanges(cells).map(([s, e]) => ({ row, col: s, text: cells.slice(s, e).map((x) => x.ch).join('') }));
  });
}

/** Rows as plain text with faint (dim or grey) runs wrapped as `⟦dim:…⟧` (rows right-trimmed). */
export function markDim(styled: string[]): string[] {
  return styled.map((line) => {
    const cells = parseStyledLine(line);
    const text = (from: number, to: number) => cells.slice(from, to).map((x) => x.ch).join('');
    let out = '';
    let at = 0;
    for (const [s, e] of faintRanges(cells)) { out += `${text(at, s)}⟦dim:${text(s, e)}⟧`; at = e; }
    return (out + text(at, cells.length)).replace(/\s+$/, '');
  });
}

const BORDER = /[│┃║]/;
/** A prompt glyph that may lead the faint tail (the input line's own `>` / `❯` / `›` / `»` / `➜`). */
const PROMPT_GLYPH = /^[>❯›»➜]\s+/;

/**
 * The faint or grey text at the end of the cursor row, or null: the
 * placeholder / suggestion a prompt TUI draws after the caret. The program's
 * own caret is often a reverse-video cell over the first ghost character, so
 * one reverse cell may start the tail. A leading prompt glyph is dropped.
 */
export function ghostText(styled: string[], cursor: { x: number; y: number }): string | null {
  const line = styled[cursor.y];
  if (line === undefined) return null;
  const cells = parseStyledLine(line);
  let end = cells.length;
  while (end > 0 && !cells[end - 1]!.ch.trim()) end--;
  if (end > 0 && BORDER.test(cells[end - 1]!.ch)) { end--; while (end > 0 && !cells[end - 1]!.ch.trim()) end--; }
  let start = end;
  while (start > 0 && (isFaint(cells[start - 1]!) || !cells[start - 1]!.ch.trim())) start--;
  if (start > 0 && cells[start - 1]!.reverse && cells[start - 1]!.ch.trim()) start--;
  const tail = cells.slice(start, end);
  if (!tail.some((c) => isFaint(c) && c.ch.trim())) return null;
  const text = tail.map((c) => c.ch).join('').trim().replace(PROMPT_GLYPH, '');
  return text && !/^[─━═\s]+$/.test(text) ? text : null;
}
