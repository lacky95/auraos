// A second, non-❯ TUI fixture for the generic detector tests (TM-18):
//   --fzf     an fzf-style picker: list drawn bottom-up, ">" marks the
//             selected row, a match counter, the cursor on the query line at
//             the bottom; Up moves up the screen, Enter prints CHOSE <item>.
//   --select  a bash-`select`-style list: numbers, no highlight, a "#? "
//             prompt read as a line; prints CHOSE <item>.
//   --yn      a "[y/N]" question read as a line; prints ANSWER <yes|no>.
const mode = process.argv[2] ?? '--fzf';
const out = (s) => process.stdout.write(s);
const items = ['alpha.txt', 'beta.txt', 'gamma.txt', 'delta.txt'];

if (mode === '--fzf') {
  let sel = 0;   // index into items; items[0] sits right above the counter
  const draw = () => {
    out('\x1b[H\x1b[2J');
    const top = 20 - items.length;
    items.forEach((it, i) => {
      out(`\x1b[${top + (items.length - 1 - i)};1H${i === sel ? '> ' : '  '}${it}`);
    });
    out(`\x1b[21;1H  ${items.length}/${items.length} ──────────`);
    out('\x1b[22;1H> \x1b[22;3H');
  };
  process.stdin.setRawMode(true);
  process.stdin.resume();
  out('\x1b[?1049h');
  draw();
  process.stdin.on('data', (b) => {
    for (const k of b.toString().match(/\x1b\[[AB]|\x1bO[AB]|./gs) ?? []) {
      if (k === '\x1b[A' || k === '\x1bOA') sel = Math.min(items.length - 1, sel + 1);
      else if (k === '\x1b[B' || k === '\x1bOB') sel = Math.max(0, sel - 1);
      else if (k === '\r') { out('\x1b[?1049l'); out(`CHOSE ${items[sel]}\r\n`); process.exit(0); }
      else if (k === '\x03') { out('\x1b[?1049l'); process.exit(130); }
    }
    draw();
  });
} else {
  const lines = [];
  if (mode === '--select') {
    out('Choose a file:\n');
    items.forEach((it, i) => out(`${i + 1}) ${it}\n`));
    out('#? ');
  } else {
    out('Delete the cache? [y/N] ');
  }
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    lines.push(...d.split('\n'));
    const answer = lines[0]?.trim() ?? '';
    if (lines.length < 2) return;
    if (mode === '--select') out(`CHOSE ${items[Number(answer) - 1] ?? '?'}\n`);
    else out(`ANSWER ${/^y(es)?$/i.test(answer) ? 'yes' : 'no'}\n`);
    process.exit(0);
  });
}
