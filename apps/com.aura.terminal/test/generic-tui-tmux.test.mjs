// TM-18 end to end against a REAL tmux server on a throwaway socket: the same
// MCP tools that drive the ❯-style menu fixture also drive a second, generic
// TUI (fixtures/generic-tui.mjs) — an fzf-style list, a typed-number list and
// a [y/N] question — with no program-specific code. Skipped without tmux.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dataDir = mkdtempSync(join(tmpdir(), 'aura-term-generic-'));
process.env.AURA_TERM_TMUX_SOCKET = `aura-generic-test-${process.pid}`;
process.env.AURA_TERM_TMUX = '1';
process.env.AURA_DATA_DIR = dataDir;
process.env.OS_API_BASE = 'http://127.0.0.1:9';
process.env.APP_INSTANCE_ID = 'com.aura.terminal-0';

const haveTmux = (() => { try { return spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0; } catch { return false; } })();
const APP = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'generic-tui.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

after(() => {
  spawnSync('tmux', ['-L', process.env.AURA_TERM_TMUX_SOCKET, 'kill-server'], { stdio: 'ignore' });
  rmSync(dataDir, { recursive: true, force: true });
});

test('generic TUI shapes through the MCP against real tmux', { skip: !haveTmux && 'tmux not installed' }, async () => {
  const { buildTerminalServer } = await import('../src/mcp/terminal.ts');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await buildTerminalServer().connect(serverT);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientT);
  const call = (name, args = {}) => client.callTool({ name, arguments: args });

  const opened = await call('open_session', { rows: 24 });
  assert.ok(!opened.isError, JSON.stringify(opened));
  for (let i = 0; i < 40; i++) {
    const s = await call('get_status', { target: 'a1' });
    if (s.structuredContent?.state === 'shell_prompt' && s.structuredContent.last_lines.length) break;
    await sleep(100);
  }
  const waitState = async (state) => {
    for (let i = 0; i < 50; i++) {
      const s = await call('get_status', { target: 'a1' });
      if (s.structuredContent?.state === state) return s.structuredContent;
      await sleep(100);
    }
    throw new Error(`state ${state} never appeared`);
  };
  const shellShows = async (text) => {
    for (let i = 0; i < 40; i++) {
      const s = await call('get_screen', { target: 'a1', settle_ms: 0 });
      if (s.structuredContent.screen.some((l) => l.includes(text))) return true;
      await sleep(100);
    }
    return false;
  };
  const launch = (flag) => call('run_command', { target: 'a1', command: `clear; ${process.execPath} ${APP} ${flag}`, settle_ms: 0, timeout_ms: 200 });

  // 1. fzf-style list: detected as a menu, picked by label with Up presses, confirmed.
  await launch('--fzf');
  const m = await waitState('menu');
  assert.deepEqual(m.menu.options.map((o) => o.label), ['delta.txt', 'gamma.txt', 'beta.txt', 'alpha.txt']);
  assert.equal(m.menu.options[m.menu.selected_index].label, 'alpha.txt');
  const r1 = await call('select_option', { target: 'a1', option: 'gamma' });
  assert.ok(!r1.isError, JSON.stringify(r1));
  assert.deepEqual(r1.structuredContent.moved, { key: 'Up', count: 2 });
  assert.ok(await shellShows('CHOSE gamma.txt'));

  // 2. Typed-number list (bash select style): select_option types the number + Enter.
  await launch('--select');
  const t = await waitState('menu');
  assert.equal(t.menu.selection, 'typed');
  const r2 = await call('select_option', { target: 'a1', option: 'beta' });
  assert.ok(!r2.isError, JSON.stringify(r2));
  assert.equal(r2.structuredContent.method, 'typed');
  assert.ok(await shellShows('CHOSE beta.txt'));

  // 3. [y/N] question: text_input with a yes_no prompt; act answers it.
  await launch('--yn');
  const q = await waitState('text_input');
  assert.equal(q.prompt.kind, 'yes_no');
  assert.equal(q.prompt.default, 'no');
  assert.equal(q.prompt.destructive, true);
  const r3 = await call('act', { target: 'a1', text: 'n', enter: true });
  assert.ok(!r3.isError, JSON.stringify(r3));
  assert.ok(await shellShows('ANSWER no'));
});
