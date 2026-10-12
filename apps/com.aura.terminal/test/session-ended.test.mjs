// `exit` in the root shell ends the tmux session (SHELL_LOOP); the pty-server
// must then tell every window `session-ended` BEFORE closing its socket (so
// the window moves on instead of reconnecting, which would recreate the
// session under the same name) and drop the session's scrollback and window
// picks. Real pty-server, real WebSockets, real tmux on a throwaway socket —
// never the live `-L aura` server. Skipped when tmux is not installed.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'aura-term-ended-'));
const SOCK = `aura-ended-test-${process.pid}`;
process.env.AURA_TERM_TMUX_SOCKET = SOCK;
process.env.AURA_TERM_TMUX = '1';
process.env.AURA_DATA_DIR = dataDir;
process.env.OS_API_BASE = 'http://127.0.0.1:9';
process.env.APP_INSTANCE_ID = 'com.aura.terminal-0';
process.env.AURA_TERM_HOME = join(dataDir, 'home');

const haveTmux = (() => { try { return spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0; } catch { return false; } })();
const skip = !haveTmux && 'tmux not installed';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const decoder = new TextDecoder();

after(() => {
  spawnSync('tmux', ['-L', SOCK, 'kill-server'], { stdio: 'ignore' });
  rmSync(dataDir, { recursive: true, force: true });
});

async function until(fn, what, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for: ${what}`);
}

test('root exit: every window gets session-ended before close; scrollback and picks are dropped', { skip }, async () => {
  const { WebSocket } = await import('ws');
  const { getPtyWss } = await import('../src/pty-server.ts');
  const { tmuxHasSession } = await import('../src/pane-tap.ts');
  const { pickSession } = await import('../src/window-session.ts');

  const id = 'com.aura.terminal-0#a20';
  const scrollFile = join(dataDir, 'scrollback', id);
  mkdirSync(join(dataDir, 'scrollback'), { recursive: true });
  writeFileSync(scrollFile, 'old scrollback\r\n');
  pickSession('com.aura.terminal-0#5', id);

  const wss = getPtyWss();
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  const open = (browser) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?_aura_session=${encodeURIComponent(id)}&_aura_browser=${browser}`);
    const view = { ws, events: [], out: '' };
    ws.on('message', (data, isBinary) => {
      if (isBinary) view.events.push(JSON.parse(decoder.decode(data)));
      else view.out += data.toString();
    });
    ws.on('close', () => view.events.push({ type: '(closed)' }));
    return view;
  };
  const live = open('browser-live');
  await until(() => live.events.some((e) => e.type === 'granted'), 'live window granted');
  const spectator = open('browser-spectator');
  await until(() => spectator.events.some((e) => e.type === 'busy'), 'spectator told busy');

  // Past the loop's crash window (a shell that lives < 2 s is restarted).
  await sleep(2500);
  live.ws.send(JSON.stringify({ type: 'data', data: 'exit\r' }));

  for (const [name, v] of [['live', live], ['spectator', spectator]]) {
    await until(() => v.events.some((e) => e.type === '(closed)'), `${name} socket closed`);
    const ended = v.events.findIndex((e) => e.type === 'session-ended');
    const closed = v.events.findIndex((e) => e.type === '(closed)');
    assert.ok(ended >= 0, `${name} got session-ended: ${JSON.stringify(v.events)}`);
    assert.equal(v.events[ended].id, id);
    assert.ok(ended < closed, `${name}: session-ended came before the close`);
  }
  assert.equal(tmuxHasSession(id), false, 'the tmux session is gone');

  await sleep(300);   // the sockets' close handlers must not persist it again
  assert.equal(existsSync(scrollFile), false, 'scrollback removed');
  const picks = JSON.parse(readFileSync(join(dataDir, 'window-sessions.json'), 'utf-8'));
  assert.equal(Object.values(picks).includes(id), false, 'no window reopens onto the ended session');

  server.close();
});
