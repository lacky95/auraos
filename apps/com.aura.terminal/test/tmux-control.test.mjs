// Pure helpers of the terminal MCP: key-name mapping, session-id parsing,
// grid padding, pane-state parsing. No tmux, no network — these always run.
// Run via:
//   pnpm --filter com.aura.terminal test

import { test } from 'node:test';
import assert from 'node:assert/strict';

// tmux is probed at import; keep this file independent of whether it exists.
process.env.AURA_TERM_TMUX = '0';
// Pin the OS base: inside an app container it is http://aura-shell:3000.
process.env.OS_API_BASE = 'http://localhost:3000';

const { mapKey, padScreen, parsePaneState, tmuxName, TmuxError } = await import('../src/tmux-control.ts');
const { parseSessionId, proxyUrl } = await import('../src/session-router.ts');

test('mapKey: named keys, modifiers, raw tmux names', () => {
  const cases = {
    'Enter': 'Enter', 'return': 'Enter', 'Tab': 'Tab', 'Shift+Tab': 'BTab', 'BTab': 'BTab',
    'Escape': 'Escape', 'esc': 'Escape', 'Backspace': 'BSpace', 'Delete': 'DC', 'Insert': 'IC',
    'Space': 'Space', ' ': 'Space', 'Up': 'Up', 'down': 'Down', 'PageUp': 'PPage', 'PgDn': 'NPage',
    'F1': 'F1', 'f12': 'F12', 'Home': 'Home', 'End': 'End',
    'Ctrl+C': 'C-c', 'ctrl+c': 'C-c', 'Control+D': 'C-d', 'C-c': 'C-c', 'Ctrl+[': 'C-[',
    'Alt+x': 'M-x', 'M-x': 'M-x', 'Meta+Enter': 'M-Enter', 'Ctrl+Alt+Delete': 'C-M-DC',
    'Shift+Up': 'S-Up', 'Alt+Shift+Tab': 'M-BTab',
    'q': 'q', ':': ':', '-': '-', 'Ctrl+-': 'C-_', 'Ctrl--': 'C-_', 'Ctrl+Space': 'C-Space',
  };
  for (const [input, expected] of Object.entries(cases)) {
    assert.equal(mapKey(input), expected, `mapKey(${JSON.stringify(input)})`);
  }
});

test('mapKey: rejects words, unknown modifiers and ";" with the accepted list', () => {
  for (const bad of ['hello', 'Enterr', 'Super+x', 'Ctrl+é', ';', '', '   ']) {
    assert.throws(() => mapKey(bad), (err) => err instanceof TmuxError && err.code === 'bad-key', `mapKey(${JSON.stringify(bad)}) should be rejected`);
  }
  assert.match(String(assert.throws(() => mapKey('hello')) ?? ''), /.*/); // shape check only
  try { mapKey('hello'); } catch (err) { assert.match(err.message, /Accepted: Enter, Tab/); }
});

test('padScreen: pads lines to cols and the grid to rows, never truncates', () => {
  const grid = padScreen(['ab', '', 'x'.repeat(5)], 4, 5);
  assert.deepEqual(grid, ['ab  ', '    ', 'xxxxx', '    ', '    ']);
  assert.deepEqual(padScreen([], 3, 2), ['   ', '   ']);
  assert.deepEqual(padScreen(['a', 'b', 'c'], 1, 2), ['a', 'b']);   // extra rows dropped
  assert.equal([...padScreen(['日本'], 4, 1)[0]].length, 4);          // by code point
});

test('parsePaneState: tab-separated fields, tolerant of a trailing newline', () => {
  const st = parsePaneState('120\t40\t7\t3\t1\tvim\tmy title\t512\t2\n');
  assert.deepEqual(st, {
    cols: 120, rows: 40, cursorX: 7, cursorY: 3, alternate: true,
    command: 'vim', title: 'my title', historySize: 512, attachedClients: 2,
  });
  assert.equal(parsePaneState('80\t24\t0\t0\t0\tbash\t\t0\t0').alternate, false);
});

test('tmuxName folds everything tmux would parse as addressing', () => {
  assert.equal(tmuxName('com.aura.terminal-16#a12'), 'aura-com_aura_terminal-16_a12');
});

test('parseSessionId: instance prefix and label; rejects anything else', () => {
  assert.deepEqual(parseSessionId('com.aura.terminal-2#a3'), { instanceId: 'com.aura.terminal-2', label: 'a3' });
  assert.deepEqual(parseSessionId('com.aura.terminal#a1'),   { instanceId: 'com.aura.terminal',   label: 'a1' });
  for (const bad of ['foo', 'com.aura.terminal-2', 'other.app-1#a1', 'com.aura.terminal-2#a#b', '']) {
    assert.throws(() => parseSessionId(bad), /not a session id/, bad);
  }
});

test('proxyUrl: the id is encoded in the query, never in the path', () => {
  const url = proxyUrl('com.aura.terminal-2', `/api/sessions/screen?id=${encodeURIComponent('com.aura.terminal-2#a3')}`);
  assert.equal(url, 'http://localhost:3000/api/proxy/com.aura.terminal-2/api/sessions/screen?id=com.aura.terminal-2%23a3');
  assert.ok(!url.includes('#'));
});
