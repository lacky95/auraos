// TM-16 / TM-17 end to end against a REAL tmux server on a throwaway socket:
// select_menu_option moves to a row by label / number, verifies, never
// presses Enter unless submit, refuses submitting a destructive row, works on
// a reverse-video menu and in step mode; get_screen marks faint text and
// reports the ghost suggestion. Skipped when tmux is not installed.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dataDir = mkdtempSync(join(tmpdir(), 'aura-term-menu-'));
process.env.AURA_TERM_TMUX_SOCKET = `aura-menu-test-${process.pid}`;
process.env.AURA_TERM_TMUX = '1';
process.env.AURA_DATA_DIR = dataDir;
process.env.OS_API_BASE = 'http://127.0.0.1:9';
process.env.APP_INSTANCE_ID = 'com.aura.terminal-0';

const haveTmux = (() => { try { return spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0; } catch { return false; } })();
const APP = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'menu-app.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

after(() => {
  spawnSync('tmux', ['-L', process.env.AURA_TERM_TMUX_SOCKET, 'kill-server'], { stdio: 'ignore' });
  rmSync(dataDir, { recursive: true, force: true });
});

test('select_menu_option + mark_dim against real tmux', { skip: !haveTmux && 'tmux not installed' }, async () => {
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
  for (let i = 0; i < 40; i++) {
    const s = await call('get_status', { target: 'a1' });
    if (s.structuredContent?.state === 'shell_prompt' && s.structuredContent.last_lines.length) break;
    await sleep(100);
  }
  const waitMenu = async () => {
    for (let i = 0; i < 50; i++) {
      const s = await call('get_status', { target: 'a1' });
      if (s.structuredContent?.state === 'menu') return s.structuredContent;
      await sleep(100);
    }
    throw new Error('menu never appeared');
  };
  const shellShows = async (text) => {
    for (let i = 0; i < 40; i++) {
      const s = await call('get_screen', { target: 'a1', settle_ms: 0 });
      if (s.structuredContent.screen.some((l) => l.includes(text))) return true;
      await sleep(100);
    }
    return false;
  };

  const launch = async (flags = '') => {
    await call('run_command', { target: 'a1', command: `clear; ${process.execPath} ${APP} ${flags}`, settle_ms: 0, timeout_ms: 200 });
    if (flags.includes('--reverse')) { assert.ok(await shellShows('Type something.')); return null; }
    return waitMenu();
  };
  // No menu on a bare shell prompt: a clear error, nothing sent.
  const none = await call('select_menu_option', { target: 'a1', option: 'Console' });
  assert.ok(none.isError);
  assert.match(none.content[0].text, /no-menu/);

  // 1. By label, fast mode: moves, verifies, does NOT press Enter.
  await launch();
  const r1 = await call('select_menu_option', { target: 'a1', option: 'settings' });
  assert.ok(!r1.isError, JSON.stringify(r1));
  assert.equal(r1.structuredContent.selected, 'Settings');
  assert.equal(r1.structuredContent.verified, true);
  assert.equal(r1.structuredContent.submitted, false);
  assert.deepEqual(r1.structuredContent.moved, { key: 'Down', count: 2 });
  assert.ok(r1.structuredContent.screen_tail.some((l) => l.includes('❯ Settings')));
  assert.equal((await call('get_status', { target: 'a1' })).structuredContent.state, 'menu', 'still in the menu');

  // Unknown label: error listing the labels.
  const miss = await call('select_menu_option', { target: 'a1', option: 'Notepad' });
  assert.ok(miss.isError);
  assert.match(miss.content[0].text, /option-not-found/);
  assert.match(miss.content[0].text, /Type something\./);

  // Submitting a destructive row is refused before anything moves.
  const bad = await call('select_menu_option', { target: 'a1', option: 'No, exit', submit: true });
  assert.equal(bad.structuredContent.refused, true, JSON.stringify(bad));
  assert.equal((await call('get_status', { target: 'a1' })).structuredContent.menu.options[2].selected, true, 'cursor untouched');

  // 2. Step mode upward with submit: one row at a time, then Enter.
  const r2 = await call('select_menu_option', { target: 'a1', option: 1, mode: 'step', submit: true });
  assert.ok(!r2.isError, JSON.stringify(r2));
  assert.equal(r2.structuredContent.submitted, true);
  assert.deepEqual(r2.structuredContent.steps.map((s) => s.selected), ['Console', 'Terminal']);
  assert.ok(await shellShows('CHOSE Terminal'));

  // 3. Numbered menu + prefer_digit + submit: one digit press.
  await launch('--numbered');
  const r3 = await call('select_menu_option', { target: 'a1', option: 2, prefer_digit: true, submit: true });
  assert.ok(!r3.isError, JSON.stringify(r3));
  assert.equal(r3.structuredContent.method, 'digit');
  assert.ok(await shellShows('CHOSE Console'));

  // 4. Reverse-video menu (no ❯ marker), free-text row with text (typed, not submitted).
  await launch('--reverse');
  const r4 = await call('select_menu_option', { target: 'a1', option: 'Settings' });
  assert.ok(!r4.isError, JSON.stringify(r4));
  assert.equal(r4.structuredContent.verified, true);
  assert.equal(r4.structuredContent.detected_by, 'reverse-video');
  await call('send_keys', { target: 'a1', keys: ['Ctrl+C'] });

  // TM-17: faint ghost text on the cursor row.
  await call('run_command', { target: 'a1', command: "clear; printf '> \\033[7my\\033[0m\\033[2mes restart them\\033[0m'; read -r _", settle_ms: 0, timeout_ms: 300 });
  await sleep(400);
  const plain = await call('get_screen', { target: 'a1' });
  assert.ok(!plain.content[0].text.includes('⟦dim:'), 'off by default: the grid text is unchanged');
  const marked = await call('get_screen', { target: 'a1', mark_dim: true });
  assert.ok(!marked.isError, JSON.stringify(marked));
  assert.ok(marked.content[0].text.includes('> y⟦dim:es restart them⟧'), marked.content[0].text);
  assert.equal(marked.structuredContent.ghost_text, 'yes restart them');
  assert.ok(marked.structuredContent.dim.some((d) => d.text === 'es restart them'));
  assert.ok(marked.structuredContent.screen.some((l) => l.startsWith('> yes restart them')), 'structured grid stays plain');
  await call('send_keys', { target: 'a1', keys: ['Ctrl+C'] });
});
