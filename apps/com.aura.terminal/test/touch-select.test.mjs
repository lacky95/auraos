// Long-press selects the word under the finger, a drag extends it, the
// handles move one end while the other stays put, and Copy goes to the
// clipboard (or the execCommand fallback). All through xterm's programmatic
// selection, faked here on a tiny buffer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachTouchSelect } from '../src/touch-select.ts';

const W = 10, H = 20, COLS = 20;

// rows: strings (one char per cell; '中' is wide → takes two cells).
// wrapped: indices of rows that continue the previous one.
function fakeTerm(rows, { wrapped = [], viewportY = 0, viewRows = rows.length } = {}) {
  const lines = rows.map((text, i) => {
    const cells = [];
    for (const ch of text) {
      if (ch === '中') { cells.push({ c: ch, w: 2 }, { c: '', w: 0 }); }
      else cells.push({ c: ch === ' ' ? '' : ch, w: 1 });
    }
    while (cells.length < COLS) cells.push({ c: '', w: 1 });
    return {
      isWrapped: wrapped.includes(i),
      getCell: (x) => cells[x] && { getChars: () => cells[x].c, getWidth: () => cells[x].w },
    };
  });
  let sel = null;
  const term = {
    cols: COLS, rows: viewRows,
    buffer: { active: { viewportY, length: lines.length, getLine: (y) => lines[y] } },
    selects: [],
    scrolled: [],
    pasted: [],
    select(col, row, len) { this.selects.push([col, row, len]); sel = { col, row, len }; },
    selectAll() { sel = { col: 0, row: 0, len: COLS * lines.length }; },
    clearSelection() { sel = null; },
    hasSelection: () => !!sel && sel.len > 0,
    getSelection: () => (sel ? 'TEXT' : ''),
    getSelectionPosition: () => {
      if (!sel) return undefined;
      const e = sel.col + sel.len;
      return { start: { x: sel.col, y: sel.row }, end: { x: e % COLS, y: sel.row + Math.floor(e / COLS) } };
    },
    scrollLines(n) { this.scrolled.push(n); this.buffer.active.viewportY += n; },
    paste(t) { this.pasted.push(t); },
  };
  return term;
}

function setup(term, extra = {}) {
  const changes = [];
  let iv = null;
  const ts = attachTouchSelect(term, {
    screen: () => ({ left: 0, top: 0, width: COLS * W, height: term.rows * H }),
    cell: () => ({ w: W, h: H }),
    onChange: (on) => changes.push(on),
    setInterval: (cb) => { iv = cb; return 1; },
    clearInterval: () => { iv = null; },
    ...extra,
  });
  const at = (col, row) => [col * W + W / 2, row * H + H / 2];
  return { ts, changes, at, tick: () => iv?.() };
}

test('long-press selects the whole non-space run — a path stays one word', () => {
  const term = fakeTerm(['ls /usr/local/bin ok']);
  const { ts, at, changes } = setup(term);
  assert.equal(ts.hook.start(...at(8, 0)), true);
  assert.deepEqual(term.selects.at(-1), [3, 0, 14]);     // "/usr/local/bin"
  assert.deepEqual(changes, [], 'no handles while the finger is still down');
  ts.hook.end();
  assert.deepEqual(changes, [true]);
});

test('a word that soft-wraps onto the next row is selected across the wrap', () => {
  const term = fakeTerm(['x https://example.co', 'm/path y'], { wrapped: [1] });
  const { ts, at } = setup(term);
  ts.hook.start(...at(5, 0));
  assert.deepEqual(term.selects.at(-1), [2, 0, 24]);      // col 2 row 0 → col 5 row 1
});

test('a wide character is selected with both its cells', () => {
  const term = fakeTerm(['a 中中 b']);
  const { ts, at } = setup(term);
  ts.hook.start(...at(3, 0));                             // right half of the first 中
  assert.deepEqual(term.selects.at(-1), [2, 0, 4]);
});

test('dragging after the press extends forward and backward from the word', () => {
  const term = fakeTerm(['one two three', 'four five six', 'seven']);
  const { ts, at } = setup(term);
  ts.hook.start(...at(5, 1));                             // "five" = cols 5..8 row 1
  ts.hook.move(...at(2, 2));                              // forward into row 2
  assert.deepEqual(term.selects.at(-1), [5, 1, (2 - 1) * COLS + 2 - 5 + 1]);
  ts.hook.move(...at(4, 0));                              // backward: keeps the word's end
  assert.deepEqual(term.selects.at(-1), [4, 0, COLS + 8 - 4 + 1]);
  ts.hook.move(...at(6, 1));                              // back inside the word
  assert.deepEqual(term.selects.at(-1), [5, 1, 4]);
});

test('dragging at the bottom edge auto-scrolls and keeps extending', () => {
  const term = fakeTerm(Array.from({ length: 10 }, (_, i) => `row${i}`), { viewRows: 5 });
  const { ts, at, tick } = setup(term);
  ts.hook.start(...at(1, 0));
  ts.hook.move(0, 5 * H - 2);                             // bottom edge
  tick(); tick();
  assert.deepEqual(term.scrolled, [1, 1]);
  // viewport now starts at row 2, so the finger's screen row 4 is buffer row 6
  assert.deepEqual(term.selects.at(-1), [0, 0, 6 * COLS + 1]);
  ts.hook.end();
  tick();
  assert.deepEqual(term.scrolled, [1, 1], 'stops when the finger lifts');
});

test('a handle drag moves that end while the other stays put, crossing over too', () => {
  const term = fakeTerm(['alpha beta gamma']);
  const { ts, at } = setup(term);
  ts.hook.start(...at(7, 0)); ts.hook.end();              // "beta" = 6..9
  ts.beginHandle('end');
  ts.moveHandle(...at(14, 0));
  assert.deepEqual(term.selects.at(-1), [6, 0, 9]);
  ts.moveHandle(...at(1, 0));                             // drag the end past the start
  assert.deepEqual(term.selects.at(-1), [1, 0, 6]);
  ts.endHandle();
});

test('layout puts the handles on the selection corners and hides off-screen ones', () => {
  const term = fakeTerm(['aaaa bbbb', 'cccc']);
  const { ts, at } = setup(term);
  ts.hook.start(...at(6, 0)); ts.hook.end();
  const l = ts.layout();
  assert.deepEqual(l.start, { x: 5 * W, y: H, visible: true });
  assert.deepEqual(l.end, { x: 9 * W, y: H, visible: true });
  term.buffer.active.viewportY = 1;
  assert.equal(ts.layout().start.visible, false);
});

test('a tap clears a shown selection and swallows; otherwise passes', () => {
  const term = fakeTerm(['word']);
  const { ts, at, changes } = setup(term);
  assert.equal(ts.hook.tap(), false);
  ts.hook.start(...at(1, 0)); ts.hook.end();
  assert.equal(ts.hook.tap(), true);
  assert.equal(term.hasSelection(), false);
  assert.deepEqual(changes, [true, false]);
});

test('selection cleared elsewhere (typing, a click) hides the touch UI', () => {
  const term = fakeTerm(['word']);
  const { ts, at, changes } = setup(term);
  ts.hook.start(...at(1, 0)); ts.hook.end();
  ts.userActed();                                         // a keypress / mouse click…
  term.clearSelection();                                  // …which made xterm clear
  ts.selectionChanged();
  assert.equal(ts.isActive(), false);
  assert.equal(term.hasSelection(), false, 'not re-pinned: the user dismissed it');
  assert.deepEqual(changes, [true, false]);
});

test('copy uses the clipboard, then the fallback when it is refused', async () => {
  const written = [];
  const term = fakeTerm(['word']);
  const ok = setup(term, { clipboard: { writeText: async (t) => { written.push(t); } } });
  ok.ts.hook.start(...ok.at(1, 0));
  assert.equal(await ok.ts.copy(), true);
  assert.deepEqual(written, ['TEXT']);

  const fell = [];
  const term2 = fakeTerm(['word']);
  const no = setup(term2, {
    clipboard: { writeText: async () => { throw new Error('denied'); } },
    fallbackCopy: (t) => { fell.push(t); return true; },
  });
  no.ts.hook.start(...no.at(1, 0));
  assert.equal(await no.ts.copy(), true);
  assert.deepEqual(fell, ['TEXT']);
});

test('paste sends the clipboard to the program; false without read access', async () => {
  const term = fakeTerm(['x']);
  const { ts } = setup(term, { clipboard: { readText: async () => 'hello' } });
  assert.equal(await ts.paste(), true);
  assert.deepEqual(term.pasted, ['hello']);
  const t2 = fakeTerm(['x']);
  assert.equal(await setup(t2, { clipboard: null }).ts.paste(), false);
});

test('a selection xterm dropped during a repaint comes back when the text is unchanged', () => {
  const term = fakeTerm(['alpha beta gamma']);
  const { ts, at, changes } = setup(term);
  ts.hook.start(...at(7, 0)); ts.hook.end();              // "beta"
  const before = term.selects.length;
  term.clearSelection();                                  // e.g. a mouse-mode DECSET from the TUI
  ts.selectionChanged();
  assert.equal(ts.isActive(), true);
  assert.equal(term.hasSelection(), true);
  assert.deepEqual(term.selects.at(-1), [6, 0, 4]);
  assert.equal(term.selects.length, before + 1);
  assert.deepEqual(changes, [true], 'handles never flickered');
});

test('…but stays gone when the text under it changed', () => {
  const term = fakeTerm(['alpha beta gamma']);
  const { ts, at, changes } = setup(term);
  ts.hook.start(...at(7, 0)); ts.hook.end();
  term.getSelection = () => 'OTHER';                      // the cells now hold different text
  term.clearSelection();
  ts.selectionChanged();
  assert.equal(ts.isActive(), false);
  assert.equal(term.hasSelection(), false);
  assert.deepEqual(changes, [true, false]);
});

test('a tap still clears a pinned selection for good', () => {
  const term = fakeTerm(['alpha beta gamma']);
  const { ts, at } = setup(term);
  ts.hook.start(...at(7, 0)); ts.hook.end();
  assert.equal(ts.hook.tap(), true);
  ts.selectionChanged();
  assert.equal(term.hasSelection(), false);
  assert.equal(ts.isActive(), false);
});
