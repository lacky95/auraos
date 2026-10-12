// A short terminal must still receive every line of output.
//
// tmux discards a client's pending output and repaints only the visible screen
// once the backlog passes 8 × cols × rows bytes, so the smaller the window the
// more output never reaches xterm's scrollback. The pane tap (pane-tap.ts)
// feeds viewers the pane's raw output instead. Drives the real pty-server over
// a real WebSocket against a throwaway tmux server, at 8 rows.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { WebSocket } from 'ws';

// Must be set BEFORE the modules load: the socket name is read at import.
process.env.AURA_TERM_TMUX_SOCKET = `aura-tap-test-${process.pid}`;
process.env.AURA_TERM_TMUX = '1';
process.env.AURA_DATA_DIR = mkdtempSync(join(tmpdir(), 'aura-tap-test-'));

const haveTmux = (() => { try { return spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0; } catch { return false; } })();
const { getPtyWss, killSession } = await import('../src/pty-server.ts');

const SESSION = 'com.aura.terminal-0#tap1';
const LINES = 400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

after(() => spawnSync('tmux', ['-L', process.env.AURA_TERM_TMUX_SOCKET, 'kill-server'], { stdio: 'ignore' }));

test('every line reaches an 8-row terminal', { skip: !haveTmux && 'tmux not installed' }, async () => {
  const wss = getPtyWss();
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req)));
  await new Promise((r) => server.listen(0, r));
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws?_aura_session=${encodeURIComponent(SESSION)}&_aura_browser=b1`);
  let out = '';
  ws.on('message', (d, bin) => { if (!bin) out += d.toString(); });
  await new Promise((r) => ws.on('open', r));
  try {
    ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 8 }));
    await sleep(500);
    ws.send(JSON.stringify({ type: 'data', data: `for i in $(seq 1 ${LINES}); do echo TAPLINE$i-${'x'.repeat(60)}; done\r` }));

    const missing = () => {
      const seen = new Set([...out.matchAll(/TAPLINE(\d+)-x/g)].map((m) => Number(m[1])));
      let n = 0; for (let i = 1; i <= LINES; i++) if (!seen.has(i)) n++;
      return n;
    };
    const deadline = Date.now() + 8000;
    while (missing() > 0 && Date.now() < deadline) await sleep(100);
    assert.equal(missing(), 0, 'no line of output was dropped');
  } finally {
    ws.close();
    killSession(SESSION);
    server.close();
  }
});
