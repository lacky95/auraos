// A tiny TUI picker for the select_menu_option tests: arrows move (clamped),
// a digit picks and confirms, Enter confirms, then it prints CHOSE <label>.
// `--reverse` highlights with reverse video instead of a ❯ marker;
// `--numbered` prints "1. " numbers; `--ghost` ends with a faint input row.
const args = process.argv.slice(2);
const reverse = args.includes('--reverse');
const numbered = args.includes('--numbered');
const options = ['Terminal', 'Console', 'Settings', 'No, exit', 'Type something.'];
let sel = 0;
const out = (s) => process.stdout.write(s);
function draw() {
  out('\x1b[H\x1b[2J');
  out('Which app should I open?\r\n\r\n');
  options.forEach((o, i) => {
    const label = `${numbered ? `${i + 1}. ` : ''}${o}`;
    if (reverse) out(i === sel ? `  \x1b[7m${label}\x1b[0m\r\n` : `  ${label}\r\n`);
    else out(i === sel ? ` ❯ ${label}\r\n` : `   ${label}\r\n`);
  });
  out('\r\n\x1b[2mEnter to confirm · Esc to cancel\x1b[0m\r\n');
}
process.stdin.setRawMode(true);
process.stdin.resume();
out('\x1b[?1049h');
draw();
function done(i) {
  out('\x1b[?1049l');
  out(`CHOSE ${options[i]}\r\n`);
  process.exit(0);
}
process.stdin.on('data', (b) => {
  const s = b.toString();
  for (const k of s.match(/\x1b\[[AB]|\x1bO[AB]|./gs) ?? []) {
    if (k === '\x1b[A' || k === '\x1bOA') sel = Math.max(0, sel - 1);
    else if (k === '\x1b[B' || k === '\x1bOB') sel = Math.min(options.length - 1, sel + 1);
    else if (k === '\r') return done(sel);
    else if (numbered && /[1-9]/.test(k) && Number(k) <= options.length) return done(Number(k) - 1);
    else if (k === '\x03') process.exit(130);
  }
  draw();
});
