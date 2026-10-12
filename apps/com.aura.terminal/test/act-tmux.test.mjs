// The `act` MCP tool (TM-11) end to end against a REAL tmux server on a
// throwaway socket: the three return shapes, wait_for, the B6 guard, argument
// errors, run_command (now a wrapper over act) keeping its output contract, and
// select_option (an alias of select_menu_option with submit) on the menu fixture.
// Skipped when tmux is not installed.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dataDir = mkdtempSync(join(tmpdir(), 'aura-term-act-'));
process.env.AURA_TERM_TMUX_SOCKET = `aura-act-test-${process.pid}`;
process.env.AURA_TERM_TMUX = '1';
process.env.AURA_DATA_DIR = dataDir;
process.env.OS_API_BASE = 'http://127.0.0.1:9';   // OS API down → local instance only
process.env.APP_INSTANCE_ID = 'com.aura.terminal-0';

const APP = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'menu-app.mjs');
const haveTmux = (() => { try { return spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0; } catch { return false; } })();

after(() => {
  spawnSync('tmux', ['-L', process.env.AURA_TERM_TMUX_SOCKET, 'kill-server'], { stdio: 'ignore' });
  rmSync(dataDir, { recursive: true, force: true });
});

test('act tool + run_command wrapper against real tmux', { skip: !haveTmux && 'tmux not installed' }, async () => {
  const { buildTerminalServer } = await import('../src/mcp/terminal.ts');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await buildTerminalServer().connect(serverT);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientT);
  const call = (name, args = {}) => client.callTool({ name, arguments: args });

  const tools = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(tools.includes('act'), tools.join(','));
  assert.ok(tools.includes('run_command'));

  const opened = await call('open_session', {});
  const id = opened.structuredContent.session.id;
  for (let i = 0; i < 40; i++) {
    const s = await call('get_status', {});
    if (s.structuredContent?.state === 'shell_prompt' && s.structuredContent.last_lines.length) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  // Default return: summary + changed rows, no grid.
  const a1 = await call('act', { target: '0a1', text: 'echo ACT_$((6*7))', enter: true });
  assert.ok(!a1.isError, JSON.stringify(a1));
  const s1 = a1.structuredContent;
  assert.equal(s1.target_used, id);
  assert.equal(s1.screen, undefined, 'summary mode has no grid');
  assert.equal(s1.summary.state, 'shell_prompt');
  assert.equal(s1.before.state, 'shell_prompt');
  assert.ok(s1.changed_rows.some((c) => c.text === 'ACT_42'), JSON.stringify(s1.changed_rows));
  assert.ok(s1.changed_rows.every((c) => c.before === undefined));
  assert.deepEqual(s1.sent.keys, ['Enter']);
  assert.equal(s1.settled, true);

  // wait_for + diff.
  const a2 = await call('act', { text: 'sleep 0.3; echo WAITED', enter: true, wait_for: '/^WAITED$/', return: 'diff', timeout_ms: 5000 });
  assert.ok(!a2.isError, JSON.stringify(a2));
  assert.deepEqual(a2.structuredContent.wait_for, { pattern: '/^WAITED$/', matched: true });
  assert.ok(a2.structuredContent.changed_rows.some((c) => c.text === 'WAITED' && typeof c.before === 'string'));

  // keys (literal text items allowed) + return screen.
  const a3 = await call('act', { keys: ['echo', ' KEYS_OK', 'Enter'], return: 'screen' });
  assert.ok(!a3.isError, JSON.stringify(a3));
  assert.ok(a3.structuredContent.screen.some((l) => /^KEYS_OK/.test(l)), 'screen mode returns the grid');
  assert.ok(Array.isArray(a3.structuredContent.changed_rows));

  // Guards and argument errors: nothing is sent, the shell survives.
  const ex = await call('act', { text: 'exit', enter: true });
  assert.equal(ex.structuredContent.refused, true);
  assert.equal(ex.structuredContent.target_used, id);
  const cd = await call('act', { keys: ['Ctrl+D'] });
  assert.equal(cd.structuredContent.refused, true);
  const none = await call('act', {});
  assert.equal(none.isError, true);
  assert.equal(none.structuredContent.error.code, 'bad-arguments');
  const typo = await call('act', { keys: ['Enterr'] });
  assert.equal(typo.isError, true);
  assert.equal(typo.structuredContent.error.code, 'bad-key');
  const badRe = await call('act', { text: 'x', wait_for: '/(/' });
  assert.equal(badRe.isError, true);
  assert.equal(badRe.structuredContent.error.code, 'bad-arguments');
  const st = await call('get_status', {});
  assert.equal(st.structuredContent.state, 'shell_prompt');
  assert.equal(st.structuredContent.input, '', 'the refused / rejected calls typed nothing');

  // run_command keeps its contract: full screen result, summary, settled, refusal shape.
  const rc = await call('run_command', { command: 'echo RC_$((1+1))' });
  assert.ok(!rc.isError, JSON.stringify(rc));
  const r = rc.structuredContent;
  assert.equal(r.target_used, id);
  assert.ok(r.screen.some((l) => l.includes('RC_2')));
  assert.equal(r.summary.state, 'shell_prompt');
  assert.equal(r.settled, true);
  assert.equal(r.changed_rows, undefined, 'run_command output unchanged');
  assert.equal(r.warning, undefined);
  assert.match(rc.content[0].text, /^\[com\.aura\.terminal-0#a1\] alias=0a1/);
  const rcExit = await call('run_command', { command: 'logout' });
  assert.equal(rcExit.structuredContent.refused, true);
  assert.equal(rcExit.structuredContent.target_used, id);

  // On a menu: act's guard simulates the arrows; select_option = select_menu_option + submit.
  await call('run_command', { command: `clear; ${process.execPath} ${APP}`, settle_ms: 0, timeout_ms: 200 });
  let menu = null;
  for (let i = 0; i < 50 && !menu; i++) {
    const s = await call('get_status', {});
    if (s.structuredContent?.state === 'menu') menu = s.structuredContent.menu;
    else await new Promise((res) => setTimeout(res, 100));
  }
  assert.ok(menu, 'menu fixture is up');
  const onMenu = await call('run_command', { command: 'ls' });
  assert.equal(onMenu.structuredContent.refused, true, 'run_command still refuses on a menu');
  const destr = await call('act', { keys: ['Down', 'Down', 'Down'], enter: true });
  assert.equal(destr.structuredContent.refused, true, JSON.stringify(destr.structuredContent));
  assert.equal(destr.structuredContent.would_select, 'No, exit');
  const so1 = await call('select_option', { option: 'No, exit' });
  assert.equal(so1.structuredContent.refused, true);
  assert.equal((await call('get_status', {})).structuredContent.menu.selected_index, 0, 'nothing moved');
  const so2 = await call('select_option', { option: 'Settings' });
  assert.ok(!so2.isError, JSON.stringify(so2));
  assert.equal(so2.structuredContent.selected, 'Settings');
  assert.equal(so2.structuredContent.submitted, true);
  let chose = false;
  for (let i = 0; i < 40 && !chose; i++) {
    const sc = await call('get_screen', { settle_ms: 0 });
    chose = sc.structuredContent.screen.some((l) => l.includes('CHOSE Settings'));
    if (!chose) await new Promise((res) => setTimeout(res, 100));
  }
  assert.ok(chose, 'Enter confirmed the verified option');
});
