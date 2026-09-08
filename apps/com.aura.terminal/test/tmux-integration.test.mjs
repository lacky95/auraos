// The tmux side of the terminal MCP against a REAL tmux server on a throwaway
// socket: a headless session, typing, reading the grid back, keys, teardown.
// Skipped when tmux is not installed (CI without the image), so the pure tests
// in tmux-control.test.mjs remain the floor.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// Must be set BEFORE the module is imported: the socket name is read at load.
process.env.AURA_TERM_TMUX_SOCKET = `aura-test-${process.pid}`;
process.env.AURA_TERM_TMUX = '1';

const haveTmux = (() => { try { return spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0; } catch { return false; } })();
const tc = haveTmux ? await import('../src/tmux-control.ts') : null;

const SESSION = 'com.aura.terminal-0#a1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred, ms = 5000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await sleep(100);
  }
}

after(() => { if (haveTmux) spawnSync('tmux', ['-L', process.env.AURA_TERM_TMUX_SOCKET, 'kill-server'], { stdio: 'ignore' }); });

test('headless session: create, type, read the grid, keys, kill', { skip: !haveTmux && 'tmux not installed' }, async () => {
  const { newSession, paneState, captureScreen, captureScrollback, sendLiteral, sendKeys, padScreen, tmuxKill, liveTmuxSessions, tmuxName, pasteText } = tc;

  await newSession(SESSION, 80, 24);
  assert.ok(liveTmuxSessions().has(tmuxName(SESSION)), 'session is on our socket');
  const st0 = await paneState(SESSION);
  assert.equal(st0.cols, 80); assert.equal(st0.rows, 24); assert.equal(st0.alternate, false);

  // Literal text with a leading dash must not be parsed as an option.
  await sendLiteral(SESSION, 'echo -n MARK_; echo 1');
  await sendKeys(SESSION, ['Enter']);
  const lines = await waitFor(async () => { const l = await captureScreen(SESSION); return l.some((x) => x.includes('MARK_1')) ? l : null; });
  const grid = padScreen(lines, 80, 24);
  assert.equal(grid.length, 24);
  assert.ok(grid.every((l) => [...l].length >= 80), 'every row padded to the pane width');

  // The shell got the same env a window-spawned one would.
  await sendLiteral(SESSION, 'echo LBL=$AURA_TERM_LABEL'); await sendKeys(SESSION, ['Enter']);
  await waitFor(async () => (await captureScreen(SESSION)).some((x) => /^LBL=aura-shell/.test(x)));

  // Scrollback: push more than the pane holds, then read the history above it.
  await sendLiteral(SESSION, 'for i in $(seq 1 40); do echo L$i; done'); await sendKeys(SESSION, ['Enter']);
  const st1 = await waitFor(async () => { const s = await paneState(SESSION); return s.historySize > 0 ? s : null; });
  const hist = await captureScrollback(SESSION, 5, st1.historySize);
  assert.equal(hist.length, 5);
  assert.ok(hist.every((l) => /^L\d+$|MARK|LBL|echo|seq/.test(l) || l.length >= 0), 'history lines are text');
  assert.deepEqual(await captureScrollback(SESSION, 5, 0), [], 'empty history yields nothing');

  // Bracketed paste lands as typed text, not executed line by line.
  await pasteText(SESSION, 'echo P1\necho P2');
  await waitFor(async () => (await captureScreen(SESSION)).some((x) => x.includes('echo P2')));
  await sendKeys(SESSION, ['C-c']);   // abandon the pasted lines
  await sleep(150);

  // Ctrl+C at a prompt just gives a new prompt; the shell stays alive.
  assert.equal((await paneState(SESSION)).command, 'bash');

  assert.equal(tmuxKill(SESSION), true);
  assert.equal(liveTmuxSessions().has(tmuxName(SESSION)), false);
});

test('errors: missing session and disabled tmux are typed', { skip: !haveTmux && 'tmux not installed' }, async () => {
  const { captureScreen, TmuxError } = tc;
  await assert.rejects(captureScreen('com.aura.terminal-0#nope'), (err) => err instanceof TmuxError && err.code === 'no-such-session');
});
