// The terminal MCP end to end against a REAL tmux server on a throwaway
// socket: default target + aliases, run_command with the screen summary,
// the input guards (exit / Ctrl+D refused, the shell survives), literal text
// in send_keys, idle-shell reuse, and kill_session's confirmation.
// Skipped when tmux is not installed.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'aura-term-mcp-'));
process.env.AURA_TERM_TMUX_SOCKET = `aura-mcp-test-${process.pid}`;
process.env.AURA_TERM_TMUX = '1';
process.env.AURA_DATA_DIR = dataDir;
process.env.OS_API_BASE = 'http://127.0.0.1:9';   // OS API down → local instance only
process.env.APP_INSTANCE_ID = 'com.aura.terminal-0';

const haveTmux = (() => { try { return spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0; } catch { return false; } })();

after(() => {
  spawnSync('tmux', ['-L', process.env.AURA_TERM_TMUX_SOCKET, 'kill-server'], { stdio: 'ignore' });
  rmSync(dataDir, { recursive: true, force: true });
});

test('voice-safe terminal MCP against real tmux', { skip: !haveTmux && 'tmux not installed' }, async () => {
  const { buildTerminalServer } = await import('../src/mcp/terminal.ts');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await buildTerminalServer().connect(serverT);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientT);
  const call = (name, args = {}) => client.callTool({ name, arguments: args });

  const opened = await call('open_session', {});
  assert.ok(!opened.isError, JSON.stringify(opened));
  const id = opened.structuredContent.session.id;
  assert.equal(id, 'com.aura.terminal-0#a1');
  assert.equal(opened.structuredContent.reused, false);

  // Let bash draw its prompt.
  for (let i = 0; i < 40; i++) {
    const s = await call('get_status', { target: 'a1' });
    if (s.structuredContent?.state === 'shell_prompt' && s.structuredContent.last_lines.length) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  const ran = await call('run_command', { target: '0a1', command: 'echo HELLO_$((40+2))' });
  assert.ok(!ran.isError, JSON.stringify(ran));
  assert.equal(ran.structuredContent.target_used, id);
  assert.equal(ran.structuredContent.resolved_from, '0a1');
  assert.ok(ran.structuredContent.screen.some((l) => l.includes('HELLO_42')));
  assert.equal(ran.structuredContent.summary.state, 'shell_prompt');
  assert.ok(ran.structuredContent.settled);
  assert.ok(ran.structuredContent.elapsedMs < 3000, `early settle (${ran.structuredContent.elapsedMs} ms)`);

  // Guards: the shell must survive all of these.
  const exitCmd = await call('run_command', { command: 'exit' });          // default target = last used
  assert.ok(!exitCmd.isError);
  assert.equal(exitCmd.structuredContent.refused, true);
  assert.equal(exitCmd.structuredContent.target_used, id);
  const ctrlD = await call('send_keys', { session: '***', keys: ['Ctrl+D'] });
  assert.equal(ctrlD.structuredContent.refused, true);
  const typed = await call('send_keys', { keys: ['exit', 'Enter'] });
  assert.equal(typed.structuredContent.refused, true);

  // Literal text in send_keys.
  const lit = await call('send_keys', { keys: ['echo', ' LIT_OK', 'Enter'] });
  assert.ok(!lit.isError, JSON.stringify(lit));
  let seen = false;
  for (let i = 0; i < 30 && !seen; i++) {
    const sc = await call('get_screen', { settle_ms: 100 });
    seen = sc.structuredContent.screen.some((l) => /^LIT_OK/.test(l));
    if (!seen) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(seen, 'literal text was typed');

  // Repeats: the whole sequence N times, delay between; a combo repeats too.
  const t0 = Date.now();
  const rep = await call('send_keys', { keys: ['x'], times: 3, delay: 100 });
  assert.ok(!rep.isError, JSON.stringify(rep));
  assert.equal(rep.structuredContent.times_sent, 3);
  assert.deepEqual(rep.structuredContent.sent.keys, ['x', 'x', 'x']);
  assert.ok(Date.now() - t0 >= 200, 'delay applied between repeats');
  const cc = await call('send_keys', { keys: ['Ctrl+C'], times: 2, delay: 0 });
  assert.deepEqual(cc.structuredContent.sent.keys, ['C-c', 'C-c']);
  const ctrlD3 = await call('send_keys', { keys: ['Ctrl+D'], times: 3 });
  assert.equal(ctrlD3.structuredContent.refused, true, 'guard still refuses on the first repeat');
  const status = await call('get_status', {});
  assert.equal(status.structuredContent.state, 'shell_prompt');
  assert.equal(status.structuredContent.program, 'shell');

  // open_session reuses the idle shell; reuse:false makes a new one.
  const again = await call('open_session', {});
  assert.equal(again.structuredContent.reused, true);
  assert.equal(again.structuredContent.session.id, id);

  const listed = await call('list_sessions', {});
  assert.equal(listed.structuredContent.default_target, id);
  assert.deepEqual(listed.structuredContent.instances[0].sessions.map((s) => s.alias), ['0a1']);

  const noConfirm = await call('kill_session', { target: '0a1' });
  assert.equal(noConfirm.structuredContent.refused, true);
  const killed = await call('kill_session', { target: '0a1', confirm: true });
  assert.ok(!killed.isError, JSON.stringify(killed));
  assert.equal(killed.structuredContent.killed, true);

  const gone = await call('get_status', { target: id });
  assert.equal(gone.isError, true);
  assert.equal(gone.structuredContent.error.code, 'no-such-session');
  assert.match(gone.structuredContent.error.hint, /Do NOT open a new session/);
});
