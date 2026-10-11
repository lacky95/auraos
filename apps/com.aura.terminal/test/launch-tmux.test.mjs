// OPEN_TERMINAL against a REAL tmux server on a throwaway socket: a
// background (window-less) session is created under the given name and its
// `command` is typed only once the shell has drawn its prompt; a queued
// windowed command runs exactly once. Skipped without tmux.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Must be set BEFORE the modules are imported: socket + data dir are read at load.
process.env.AURA_TERM_TMUX_SOCKET = `aura-test-launch-${process.pid}`;
process.env.AURA_TERM_TMUX = '1';
process.env.AURA_DATA_DIR = mkdtempSync(join(tmpdir(), 'term-launch-tmux-'));
process.env.APP_INSTANCE_ID = 'com.aura.terminal-0';

const haveTmux = (() => { try { return spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0; } catch { return false; } })();
const lc = haveTmux ? await import('../src/launch-commands.ts') : null;
const tc = haveTmux ? await import('../src/tmux-control.ts') : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function screenHas(id, text, ms = 6000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const lines = await tc.captureScreen(id);
    if (lines.some((l) => l.includes(text))) return lines;
    if (Date.now() > deadline) throw new Error(`timed out waiting for "${text}" in:\n${lines.join('\n')}`);
    await sleep(100);
  }
}

after(() => { if (haveTmux) spawnSync('tmux', ['-L', process.env.AURA_TERM_TMUX_SOCKET, 'kill-server'], { stdio: 'ignore' }); });

test('background session: created headless under the given id, command runs after the prompt', { skip: !haveTmux && 'tmux not installed' }, async () => {
  const id = 'com.aura.terminal-0#a7';
  await lc.openHeadlessSession(id);
  assert.equal(await lc.sessionIsLive(id), true);
  await lc.openHeadlessSession(id);   // idempotent: no duplicate-session error
  const { settled } = await lc.runLaunchCommand(id, 'echo BG_$((40+2))');
  assert.equal(settled, true, 'waited for the prompt to settle');
  const lines = await screenHas(id, 'BG_42');
  // The command line itself sits after the prompt, not before it.
  assert.ok(lines.some((l) => /echo BG_\$\(\(40\+2\)\)/.test(l)));
  tc.tmuxKill(id);
});

test('windowed command: taken once and typed into the queued session', { skip: !haveTmux && 'tmux not installed' }, async () => {
  const win = 'com.aura.terminal-0#a8';
  const target = 'com.aura.terminal-0#a9';
  await lc.openHeadlessSession(target);
  lc.queueLaunchCommand(win, target, 'echo WIN_$((1+1))');
  const p = lc.takeLaunchCommand(win);
  assert.equal(lc.takeLaunchCommand(win), null);
  await lc.runLaunchCommand(p.sessionId, p.command);
  const lines = await screenHas(target, 'WIN_2');
  assert.equal(lines.filter((l) => l.includes('WIN_2') && !l.includes('echo')).length, 1, 'ran exactly once');
  tc.tmuxKill(target);
});

test('sessionIsLive is false for a name tmux does not have', { skip: !haveTmux && 'tmux not installed' }, async () => {
  assert.equal(await lc.sessionIsLive('com.aura.terminal-0#a99'), false);
});
