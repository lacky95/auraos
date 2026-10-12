// TM-4 + root exit: new sessions run the shell under a loop that ends the
// session on a deliberate `exit` in the root shell, but restarts a shell that
// crashed (killed by a signal, or dead within ~2 s) in place; a pane that does die
// (a session created before the loop existed, or the loop itself killed) is
// kept by tmux's `remain-on-exit`, reported as `exited`, and respawned in place
// instead of the session vanishing into `no-such-session`.
// Real tmux on a throwaway socket; skipped when tmux is not installed.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'aura-term-life-'));
const SOCK = `aura-life-test-${process.pid}`;
process.env.AURA_TERM_TMUX_SOCKET = SOCK;
process.env.AURA_TERM_TMUX = '1';
process.env.AURA_DATA_DIR = dataDir;
process.env.OS_API_BASE = 'http://127.0.0.1:9';
process.env.APP_INSTANCE_ID = 'com.aura.terminal-0';

const haveTmux = (() => { try { return spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0; } catch { return false; } })();
const skip = !haveTmux && 'tmux not installed';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmuxRaw = (...args) => spawnSync('tmux', ['-L', SOCK, ...args], { encoding: 'utf-8' });

async function waitFor(pred, ms = 5000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await sleep(100);
  }
}

after(() => {
  tmuxRaw('kill-server');
  rmSync(dataDir, { recursive: true, force: true });
});

test('tmux.conf keeps a pane whose program exited', () => {
  const conf = readFileSync(new URL('../tmux.conf', import.meta.url), 'utf-8');
  assert.match(conf, /^set -g remain-on-exit on$/m);
});

test('shellArgv wraps the shell in an exit/restart loop tmux passes through untouched', async () => {
  const { shellArgv } = await import('../src/tmux-control.ts');
  const argv = shellArgv('/bin/bash');
  assert.equal(argv[argv.length - 1], '/bin/bash', 'the real shell is the last argument');
  assert.equal(argv[0], '/bin/sh');
  // tmux ends a command at an argument that ends in ";" and expands "#{…}" in
  // some arguments: the loop must contain neither.
  for (const a of argv) {
    assert.ok(!/;\s*$/.test(a), `argument ends with ";": ${a}`);
    assert.ok(!a.includes('#'), `argument contains "#": ${a}`);
  }
});

test('shellCwd: HOME unless it is inside the app tree', async () => {
  const { shellCwd } = await import('../src/tmux-control.ts');
  const alt = join(dataDir, 'home');
  assert.equal(shellCwd({ HOME: '/home/aura' }, '/workspace/apps/com.aura.terminal'), '/home/aura');
  assert.equal(shellCwd({ HOME: '/workspace/apps/com.aura.terminal', AURA_TERM_HOME: alt }, '/workspace/apps/com.aura.terminal'), alt);
  assert.equal(shellCwd({ HOME: '/workspace/apps/com.aura.terminal/sub', AURA_TERM_HOME: alt }, '/workspace/apps/com.aura.terminal/'), alt);
  assert.equal(shellCwd({ AURA_TERM_HOME: alt }, '/workspace/apps/com.aura.terminal'), alt);
  assert.equal(shellCwd({ HOME: '/workspace/apps/com.aura.terminal2' }, '/workspace/apps/com.aura.terminal'), '/workspace/apps/com.aura.terminal2');
});

/** A new session whose shell is up, and the time it started. */
async function freshSession(id) {
  const { newSession, paneState } = await import('../src/tmux-control.ts');
  await newSession(id, 80, 24);
  await waitFor(async () => (await paneState(id)).command === 'bash');
  return Date.now();
}

/** Wait until the root shell has lived long enough to count as deliberate. */
const pastCrashWindow = (startedAt) => sleep(Math.max(0, startedAt + 2300 - Date.now()));

async function expectRestartedInPlace(id, status) {
  const { paneState, captureScreen, sendLiteral, sendKeys, liveTmuxSessions, tmuxName, tmuxKill } = await import('../src/tmux-control.ts');
  await waitFor(async () => (await captureScreen(id)).some((x) => x.includes(`shell exited (status ${status})`)));
  assert.ok(liveTmuxSessions().has(tmuxName(id)), 'session still exists');
  await waitFor(async () => { const s = await paneState(id); return !s.dead && s.command === 'bash'; });
  // A NEW shell: the old one's variables are gone.
  await sendLiteral(id, 'echo "MARK=[$MARK]"'); await sendKeys(id, ['Enter']);
  await waitFor(async () => (await captureScreen(id)).some((x) => x.includes('MARK=[]')));
  assert.equal(tmuxKill(id), true, 'kill_session still ends it for good');
  assert.equal(liveTmuxSessions().has(tmuxName(id)), false);
}

test('exit in the root shell ends the session for real', { skip }, async () => {
  const { sendLiteral, sendKeys, liveTmuxSessions, tmuxName } = await import('../src/tmux-control.ts');
  const id = 'com.aura.terminal-0#a7';
  await pastCrashWindow(await freshSession(id));
  await sendLiteral(id, 'exit 3'); await sendKeys(id, ['Enter']);
  await waitFor(() => !liveTmuxSessions().has(tmuxName(id)));
});

test('exit inside a nested shell only ends the hop', { skip }, async () => {
  const { sendLiteral, sendKeys, paneState, liveTmuxSessions, tmuxName } = await import('../src/tmux-control.ts');
  const id = 'com.aura.terminal-0#a12';
  await pastCrashWindow(await freshSession(id));
  await sendLiteral(id, 'bash --norc'); await sendKeys(id, ['Enter']);
  await sleep(500);
  await sendLiteral(id, 'exit'); await sendKeys(id, ['Enter']);
  await sleep(800);
  assert.ok(liveTmuxSessions().has(tmuxName(id)), 'the session survives the hop exit');
  assert.equal((await paneState(id)).command, 'bash');
  await sendLiteral(id, 'exit'); await sendKeys(id, ['Enter']);
  await waitFor(() => !liveTmuxSessions().has(tmuxName(id)));
});

test('exit after a Ctrl+C\'d command (status 130) still ends the session', { skip }, async () => {
  const { sendLiteral, sendKeys, liveTmuxSessions, tmuxName } = await import('../src/tmux-control.ts');
  const id = 'com.aura.terminal-0#a13';
  await pastCrashWindow(await freshSession(id));
  await sendLiteral(id, 'exit 130'); await sendKeys(id, ['Enter']);
  await waitFor(() => !liveTmuxSessions().has(tmuxName(id)));
});

test('a shell that exits within 2 s is restarted in place (broken rc guard)', { skip }, async () => {
  const { sendLiteral, sendKeys } = await import('../src/tmux-control.ts');
  const id = 'com.aura.terminal-0#a14';
  await freshSession(id);
  await sendLiteral(id, 'exit 4'); await sendKeys(id, ['Enter']);
  await expectRestartedInPlace(id, 4);
});

test('a shell killed by a signal is restarted in place', { skip }, async () => {
  const { sendLiteral, sendKeys } = await import('../src/tmux-control.ts');
  const id = 'com.aura.terminal-0#a15';
  await pastCrashWindow(await freshSession(id));
  await sendLiteral(id, 'export MARK=old; kill -9 $$'); await sendKeys(id, ['Enter']);
  await expectRestartedInPlace(id, 137);
});

/** A session the old way (bare shell, no loop) whose shell has exited. */
async function deadPane(id) {
  const { newSession, tmuxName, paneState, liveTmuxSessions } = await import('../src/tmux-control.ts');
  // Start the server with OUR tmux.conf (it is only read at server start).
  if (!liveTmuxSessions().has(tmuxName('com.aura.terminal-0#boot'))) await newSession('com.aura.terminal-0#boot', 80, 24);
  assert.equal(tmuxRaw('new-session', '-d', '-s', tmuxName(id), '-x', '80', '-y', '24', 'bash', '--norc').status, 0);
  tmuxRaw('send-keys', '-t', tmuxName(id), 'exit 5', 'Enter');
  return waitFor(async () => { const s = await paneState(id); return s.dead ? s : null; });
}

test('respawnIfDead: a dead pane gets a fresh shell, a live one is left alone', { skip }, async () => {
  const { respawnIfDead, paneState } = await import('../src/tmux-control.ts');
  const id = 'com.aura.terminal-0#a8';
  await deadPane(id);
  const r = await respawnIfDead(id);
  assert.equal(r.respawned, true);
  await waitFor(async () => !(await paneState(id)).dead);
  assert.deepEqual(await respawnIfDead(id), { respawned: false, deadStatus: null });
});

test('get_screen on an exited shell reports exited + respawned, not no-such-session', { skip }, async () => {
  const { screenLocal } = await import('../src/session-service.ts');
  const { paneState } = await import('../src/tmux-control.ts');
  const id = 'com.aura.terminal-0#a9';
  await deadPane(id);
  const v = await screenLocal(id, { settleMs: 0 });
  assert.equal(v.dead, true);
  assert.equal(v.respawned, true);
  await waitFor(async () => !(await paneState(id)).dead);
  const v2 = await screenLocal(id, { settleMs: 0 });
  assert.equal(v2.dead, false);
  assert.equal(v2.respawned, undefined);
});

test('input to an exited shell sends nothing, respawns it and says so', { skip }, async () => {
  const { inputLocal, SessionError } = await import('../src/session-service.ts');
  const { paneState, captureScreen } = await import('../src/tmux-control.ts');
  const id = 'com.aura.terminal-0#a10';
  await deadPane(id);
  await assert.rejects(inputLocal(id, { text: 'echo SHOULD_NOT_RUN', keys: ['Enter'] }),
    (err) => err instanceof SessionError && err.code === 'shell-exited' && err.status === 409 && /fresh shell/i.test(err.hint ?? ''));
  await waitFor(async () => !(await paneState(id)).dead);
  await sleep(300);
  assert.ok(!(await captureScreen(id)).some((l) => l.includes('SHOULD_NOT_RUN')), 'nothing was typed');
});

test('MCP get_status on an exited shell: state exited, respawned, no error', { skip }, async () => {
  const { buildTerminalServer } = await import('../src/mcp/terminal.ts');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const id = 'com.aura.terminal-0#a11';
  await deadPane(id);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await buildTerminalServer().connect(serverT);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientT);
  const s = await client.callTool({ name: 'get_status', arguments: { target: id } });
  assert.ok(!s.isError, JSON.stringify(s));
  assert.equal(s.structuredContent.state, 'exited');
  assert.equal(s.structuredContent.respawned, true);
  await client.close();
});
