// Pure logic behind the voice-safe terminal MCP: target resolution (aliases,
// masked ids, default target), screen summaries / menu detection on captured
// Claude Code screens, and the input guard. No tmux, no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.AURA_TERM_TMUX = '0';

const { resolveTarget, parseSpoken, isMaskedTarget, canonicalId, aliasOf, TargetError } = await import('../src/targets.ts');
const { detectMenu, summarizeScreen, guardInput, killsShell, settleKey, isReadyState } = await import('../src/screen-summary.ts');

const C = (id, inUse = false, command = 'bash') => ({ id, inUse, command });
const cands = [
  C('com.aura.terminal-16#a1', true, 'claude'),
  C('com.aura.terminal-16#a2'),
  C('com.aura.terminal-14#a3'),
  C('com.aura.terminal-20#a1'),
];

test('isMaskedTarget / canonicalId / aliasOf', () => {
  for (const m of [undefined, null, '', '  ', '***', '*', '[redacted]', '<redacted>']) assert.equal(isMaskedTarget(m), true, String(m));
  for (const v of ['16a1', 'a1', 'com.aura.terminal-16#a1']) assert.equal(isMaskedTarget(v), false, v);
  assert.equal(canonicalId('com.aura.terminal-16#A1'), 'com.aura.terminal-16#a1');
  assert.equal(canonicalId('16a1'), null);
  assert.equal(aliasOf('com.aura.terminal-16#a1'), '16a1');
  assert.equal(aliasOf('com.aura.terminal#a1'), 'a1');
});

test('parseSpoken: voice-friendly forms', () => {
  const table = {
    '16A1': { instance: '16', label: 'a1' }, '14 a3': { instance: '14', label: 'a3' },
    '16#a1': { instance: '16', label: 'a1' }, 'terminal 16 a1': { instance: '16', label: 'a1' },
    'Terminal-16 A 1': { instance: '16', label: 'a1' }, 'a1': { instance: null, label: 'a1' },
    'session a3': { instance: null, label: 'a3' }, 'terminal 20': { instance: '20', label: null },
  };
  for (const [input, want] of Object.entries(table)) assert.deepEqual(parseSpoken(input), want, input);
  for (const bad of ['nonsense', 'claude', '']) assert.equal(parseSpoken(bad), null, bad);
});

test('resolveTarget: aliases, ambiguity, defaults', () => {
  assert.equal(resolveTarget('16A1', cands).id, 'com.aura.terminal-16#a1');
  assert.equal(resolveTarget('14 a3', cands).id, 'com.aura.terminal-14#a3');
  assert.equal(resolveTarget('a3', cands).id, 'com.aura.terminal-14#a3', 'unique label');
  assert.equal(resolveTarget('a1', cands).id, 'com.aura.terminal-16#a1', 'ambiguous label → the one in use');
  assert.equal(resolveTarget('16A1', cands).resolved_from, '16A1');
  assert.equal(resolveTarget('com.aura.terminal-99#a1', cands).id, 'com.aura.terminal-99#a1', 'canonical ids pass through');

  // Default target: last touched → single in use → only session.
  assert.equal(resolveTarget('***', cands, { last: 'com.aura.terminal-20#a1' }).id, 'com.aura.terminal-20#a1');
  const d = resolveTarget('***', cands, { last: 'com.aura.terminal-5#a1' });   // stale "last"
  assert.equal(d.id, 'com.aura.terminal-16#a1');
  assert.equal(d.how, 'default:in-use');
  assert.equal(resolveTarget(undefined, [C('com.aura.terminal-3#a1')]).how, 'default:only');

  const err = (fn) => { try { fn(); } catch (e) { return e; } assert.fail('expected TargetError'); };
  const amb = err(() => resolveTarget('a1', [C('com.aura.terminal-16#a1'), C('com.aura.terminal-20#a1')]));
  assert.ok(amb instanceof TargetError);
  assert.equal(amb.code, 'ambiguous-target');
  assert.equal(amb.candidates.length, 2);
  const unk = err(() => resolveTarget('17a1', cands));
  assert.equal(unk.code, 'unknown-target');
  assert.match(unk.hint, /Do NOT open a new session/);
  assert.ok(unk.candidates.some((c) => c.startsWith('16a1 = com.aura.terminal-16#a1')));
  const none = err(() => resolveTarget('***', [C('com.aura.terminal-1#a1'), C('com.aura.terminal-2#a1')]));
  assert.equal(none.code, 'no-target');
});

// Claude Code's folder-trust prompt, as captured from a 100-col pane.
const TRUST = [
  '╭──────────────────────────────────────────────────────────────────────────────────────────╮',
  '│ Do you trust the files in this folder?                                                   │',
  '│                                                                                          │',
  '│ /root                                                                                    │',
  '│                                                                                          │',
  '│ Claude Code may read, write, or execute files contained in this directory.               │',
  '│                                                                                          │',
  '│ ❯ 1. Yes, proceed                                                                        │',
  '│   2. No, exit                                                                            │',
  '│                                                                                          │',
  '╰──────────────────────────────────────────────────────────────────────────────────────────╯',
  '   Enter to confirm · Esc to exit',
  '',
];
const trustView = { command: 'claude', title: '', mode: 'alternate', screen: TRUST, cursor: { x: 0, y: 12 } };

test('detectMenu: the trust prompt, selection and destructive option', () => {
  const m = detectMenu(TRUST);
  assert.ok(m);
  assert.deepEqual(m.options.map((o) => [o.number, o.label, o.selected, o.destructive]),
    [[1, 'Yes, proceed', true, false], [2, 'No, exit', false, true]]);
  assert.equal(m.selected_index, 0);
  assert.equal(m.escape_exits, true);
  assert.match(m.question, /Claude Code may read/);
  const s = summarizeScreen(trustView);
  assert.equal(s.program, 'claude');
  assert.equal(s.state, 'menu');
  assert.ok(isReadyState(s));

  // Second option selected (e.g. after a Down).
  const moved = TRUST.map((l) => l.replace('❯ 1. Yes', '  1. Yes').replace('  2. No, exit', '❯ 2. No, exit'));
  assert.equal(detectMenu(moved).selected_index, 1);

  // Not a menu: a shell prompt, a Claude input box.
  assert.equal(detectMenu(['root@x:~$ ls', 'a  b', 'root@x:~$ ']), null);
  assert.equal(detectMenu(['╭────╮', '│ ❯ hello │', '╰────╯']), null);
  assert.equal(detectMenu(['  > 1. only one option']), null);
});

test('guardInput: trust prompt — Enter on Yes ok; Down+Enter, "2", Escape refused', () => {
  const s = summarizeScreen(trustView);
  assert.equal(guardInput(s, [{ key: 'Enter' }]), null);
  const down = guardInput(s, [{ key: 'Down' }, { key: 'Enter' }]);
  assert.equal(down.refused, true);
  assert.equal(down.would_select, '2. No, exit');
  assert.equal(guardInput(s, [{ key: '2' }]).refused, true);
  assert.equal(guardInput(s, [{ text: '2' }]).refused, true);
  assert.equal(guardInput(s, [{ key: 'Escape' }]).refused, true);
  assert.equal(guardInput(s, [{ key: '1' }]), null);
  assert.equal(guardInput(s, [{ key: 'Up' }, { key: 'Enter' }]).refused, true, 'Up may wrap to the last option');
  assert.equal(guardInput(s, [{ key: 'Down' }, { key: 'Up' }, { key: 'Enter' }]), null, 'Down then Up is back on Yes');
  assert.equal(guardInput(s, [{ key: 'Down' }, { key: 'Down' }, { key: 'Enter' }]).refused, true, 'clamp or wrap: either may be destructive');
  assert.equal(guardInput(s, [{ key: 'Ctrl+C' }]), null, 'Ctrl+C stays allowed (stopping Claude)');
});

const shellView = (row = 'root@aura-shell:~# ') => ({
  command: 'bash', title: '', mode: 'normal', screen: ['root@aura-shell:~# ls', 'a b', row], cursor: { x: row.length, y: 2 },
});

test('guardInput: shell prompt — exit/logout/Ctrl+D refused, normal commands pass', () => {
  const s = summarizeScreen(shellView());
  assert.equal(s.state, 'shell_prompt');
  assert.equal(s.input, '');
  assert.equal(guardInput(s, [{ text: 'ls -la' }, { key: 'Enter' }]), null);
  assert.equal(guardInput(s, [{ text: 'git status' }, { key: 'Enter' }]), null);
  assert.equal(guardInput(s, [{ text: 'claude' }, { key: 'Enter' }]), null);
  for (const bad of ['exit', 'logout', 'exit 0', 'cd /tmp && exit', 'kill -9 $$', 'exec bash', 'tmux kill-server']) {
    assert.equal(guardInput(s, [{ text: bad }, { key: 'Enter' }])?.refused, true, bad);
  }
  assert.equal(guardInput(s, [{ text: 'exit\n' }])?.refused, true, 'newline submits');
  assert.equal(guardInput(s, [{ key: 'Ctrl+D' }])?.refused, true);
  assert.equal(guardInput(s, [{ key: 'C-d' }])?.refused, true);
  assert.equal(guardInput(s, [{ text: 'exit' }]), null, 'typing without Enter is not yet a submit');
  // "exit" already typed on the prompt line, then Enter.
  const typed = summarizeScreen(shellView('root@aura-shell:~# exit'));
  assert.equal(typed.input, 'exit');
  assert.equal(guardInput(typed, [{ key: 'Enter' }])?.refused, true);
  // In Claude, Ctrl+C then exit+Enter may land on the shell: refused.
  const claude = summarizeScreen({ command: 'claude', title: '', mode: 'normal', screen: ['│ > │'], cursor: { x: 3, y: 0 } });
  assert.equal(guardInput(claude, [{ key: 'Ctrl+C' }, { key: 'Ctrl+C' }]), null);
  assert.equal(guardInput(claude, [{ key: 'Ctrl+C' }, { key: 'Ctrl+D' }])?.refused, true);
  assert.equal(guardInput(claude, [{ key: 'Ctrl+C' }, { text: 'exit' }, { key: 'Enter' }])?.refused, true);
  assert.equal(guardInput(claude, [{ text: '/exit' }, { key: 'Enter' }]), null, 'Claude\'s own /exit is fine');
});

test('killsShell and settleKey', () => {
  assert.equal(killsShell('ls; exit'), 'exit');
  assert.equal(killsShell('exiftool x'), null);
  assert.equal(killsShell('echo exit'), null);
  assert.equal(
    settleKey(['✻ Thinking… (12s · ↑ 1.2k tokens · esc to interrupt)']),
    settleKey(['✶ Thinking… (13s · ↑ 1.4k tokens · esc to interrupt)']),
    'spinner, timer and token counter are volatile');
  assert.notEqual(settleKey(['a']), settleKey(['b']));
});

test('summarizeScreen: Claude Code running as node is recognised', () => {
  const screen = ['✻ Waiting for 2 background agents to finish', '', '──────────────── project ─', '❯ check the debug', '─────────────────────────'];
  assert.equal(summarizeScreen({ command: 'node', mode: 'normal', screen, cursor: { x: 0, y: 3 } }).program, 'claude');
  assert.equal(summarizeScreen({ command: 'node', mode: 'normal', screen: ['server listening'], cursor: { x: 0, y: 0 } }).program, 'node');
});

test('summarizeScreen: exited pane, pager, last lines', () => {
  const dead = summarizeScreen({ ...shellView(), dead: true, deadStatus: 0 });
  assert.equal(dead.state, 'exited');
  assert.equal(dead.exit_status, 0);
  assert.equal(summarizeScreen({ command: 'less', mode: 'alternate', screen: ['x'], cursor: { x: 0, y: 0 } }).state, 'pager');
  assert.deepEqual(summarizeScreen(shellView()).last_lines, ['root@aura-shell:~# ls', 'a b', 'root@aura-shell:~#']);
});
