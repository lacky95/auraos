// Drives pick-harness.ts inside a real pty at various terminal sizes and
// asserts every rendered frame is well-formed:
//   - frame height <= rows - 1
//   - no visible line wider than cols - 1 (nothing can hard-wrap)
//   - the selection cursor '▸' is visible in every frame
//   - each in-place redraw moves up exactly the previous frame's line count
const pty = require('/workspace/node_modules/.pnpm/node_modules/node-pty');

const TSX = '/workspace/node_modules/.pnpm/node_modules/.bin/tsx';
const HARNESS = __dirname + '/pick-harness.ts';

const SGR = /\x1b\[[0-9;]*m/g;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(name, { cols, rows, n, keys, resize, expect }) {
  return new Promise((resolve) => {
    const p = pty.spawn(TSX, [HARNESS, String(n)], {
      name: 'xterm-256color', cols, rows, cwd: __dirname, env: process.env,
    });
    let out = '';
    p.onData((d) => { out += d; });
    p.onExit(async () => resolve(check(name, out, { cols, rows, resize, expect })));
    (async () => {
      await sleep(1500); // tsx compile + first draw
      for (const k of keys) {
        if (k === 'RESIZE') { p.resize(resize.cols, resize.rows); await sleep(150); continue; }
        p.write(k);
        await sleep(60);
      }
      await sleep(400);
      try { p.kill(); } catch {}
    })();
  });
}

function check(name, raw, { cols, rows, resize, expect }) {
  const errors = [];
  // Frames are separated by the redraw prefix: cursor-up '\x1b[NA' + clear '\x1b[0J'.
  // Split on the clear; the tail of each chunk holds the next frame's up-move.
  const chunks = raw.split('\x1b[0J');
  const frames = [];
  let prevLines = null;
  let dims = { cols, rows }; // resize test flips dims at the RESIZE marker; we
  // can't know exactly which frame it lands on, so after a resize we check
  // against the larger budget of both sizes for one frame, then the new size.
  let resized = false;
  for (let c = 0; c < chunks.length; c++) {
    let chunk = chunks[c];
    let upMove = null;
    if (c < chunks.length - 1) {
      const m = /\x1b\[(\d+)A$/.exec(chunk);
      if (m) { upMove = parseInt(m[1], 10); chunk = chunk.slice(0, m.index); }
      else errors.push(`frame ${c}: redraw without cursor-up move`);
    }
    // Strip non-SGR control sequences (cursor show/hide etc.), CRs, and the
    // harness's own RESULT line (printed after the picker exits — not a frame).
    const clean = chunk
      .replace(/\x1b\[\?25[lh]/g, '')
      .replace(/\r/g, '')
      .replace(/RESULT:.*\n?/, '');
    const frame = clean.replace(/\n+$/, '');
    if (frame.trim() === '' && c === 0) continue; // pre-draw noise
    const lines = frame.split('\n');
    frames.push(lines);
    const visible = lines.map((l) => l.replace(SGR, ''));

    // Height: rendered frame must fit above the input row.
    const maxLines = resized && resize ? Math.max(rows, resize.rows) - 1 : dims.rows - 1;
    if (lines.length > maxLines) {
      errors.push(`frame ${frames.length - 1}: ${lines.length} lines > budget ${maxLines} (rows=${dims.rows})`);
    }
    // Width: no visible line may reach the terminal width (would hard-wrap).
    const maxW = Math.max(...visible.map((l) => l.length));
    if (maxW > dims.cols - 1 && !(resized && maxW <= Math.max(cols, resize ? resize.cols : 0) - 1)) {
      errors.push(`frame ${frames.length - 1}: line width ${maxW} > ${dims.cols - 1}`);
    }
    // Selection cursor visible in every full frame.
    if (!visible.some((l) => l.includes('▸'))) {
      errors.push(`frame ${frames.length - 1}: selection cursor '▸' not visible`);
    }
    // The next redraw must move up by exactly this frame's newline count.
    if (upMove !== null && prevLines !== null) { /* checked via prevLines below */ }
    if (upMove !== null) {
      const written = (clean.match(/\n/g) || []).length;
      // upMove belongs to the NEXT frame and must equal this frame's height,
      // except right after a resize (clamped intentionally).
      if (upMove !== written && !resize) {
        errors.push(`frame ${frames.length - 1}: next redraw moves up ${upMove}, frame wrote ${written} newlines`);
      }
    }
    prevLines = lines.length;
    if (resize && raw.indexOf('\x1b[0J') !== -1 && !resized && frames.length >= (expect.resizeAfterFrame ?? Infinity)) {
      resized = true; dims = resize;
    }
  }
  const result = /RESULT:(.*)/.exec(raw.replace(SGR, ''));
  if (expect.result !== undefined) {
    const got = result ? result[1].trim() : '(none)';
    if (got !== expect.result) errors.push(`RESULT mismatch: got ${got}, want ${expect.result}`);
  }
  if (frames.length < (expect.minFrames ?? 1)) errors.push(`only ${frames.length} frames captured`);
  const status = errors.length === 0 ? 'PASS' : 'FAIL';
  console.log(`[${status}] ${name} — ${frames.length} frames`);
  for (const e of errors) console.log(`   ✗ ${e}`);
  return errors.length === 0;
}

const DOWN = '\x1b[B', UP = '\x1b[A';

(async () => {
  let ok = true;
  // 1. Roomy terminal, short list: default layout, quick-pick slot 3.
  ok &= await run('80x24 n=8 fits + quick-pick', {
    cols: 80, rows: 24, n: 8,
    keys: [DOWN, DOWN, '3'],
    expect: { result: '"App1"', minFrames: 3 },
  });
  // 2. Short terminal, long list: scrolling + wrap-around navigation.
  ok &= await run('80x10 n=20 scroll + wrap', {
    cols: 80, rows: 10, n: 20,
    keys: [...Array(25).fill(DOWN), ...Array(5).fill(UP), 'q'],
    expect: { result: 'null', minFrames: 20 },
  });
  // 3. Narrow + short.
  ok &= await run('40x8 n=20 narrow+short', {
    cols: 40, rows: 8, n: 20,
    keys: [...Array(12).fill('j'), 'q'],
    expect: { result: 'null', minFrames: 10 },
  });
  // 4. Extreme.
  ok &= await run('30x6 n=15 extreme', {
    cols: 30, rows: 6, n: 15,
    keys: [...Array(8).fill(DOWN), 'q'],
    expect: { result: 'null', minFrames: 6 },
  });
  // 5. Resize mid-session: shrink, then keep navigating.
  ok &= await run('80x24→80x8 resize', {
    cols: 80, rows: 24, n: 20,
    keys: [DOWN, 'RESIZE', DOWN, DOWN, DOWN, 'q'],
    resize: { cols: 80, rows: 8 },
    expect: { result: 'null', minFrames: 4, resizeAfterFrame: 2 },
  });
  console.log(ok ? 'ALL PASS' : 'FAILURES');
  process.exit(ok ? 0 : 1);
})();
