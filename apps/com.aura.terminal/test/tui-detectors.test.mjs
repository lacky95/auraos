// TM-18, pure: the screen detectors are generic — the same code reads a
// generic numbered menu, an fzf-style list, a bash `select` typed-number
// list, a [y/N] question and REPL input lines, with no program name involved.
// Program names only pick the `program` label (tui-profiles.ts data).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectMenu, detectTypedMenu, detectPrompt, summarizeScreen, guardInput } from '../src/screen-summary.ts';
import { PROGRAM_PROFILES, profileFor } from '../src/tui-profiles.ts';
import { findOption, menuFromStyled } from '../src/menu-select.ts';
import { ghostText } from '../src/screen-styles.ts';

const E = '\x1b';
const at = (screen, y, extra = {}) => ({ command: 'mytool', title: '', mode: 'alternate', screen, cursor: { x: 0, y }, ...extra });

// A generic numbered picker with a `>` marker in front of the number.
const NUMBERED = [
  'Pick a profile',
  '  1) default',
  '> 2) work',
  '  3) personal',
  '',
  '(arrows to move, enter to pick)',
];

test('generic numbered menu with a ">" marker', () => {
  const s = summarizeScreen(at(NUMBERED, 5));
  assert.equal(s.program, 'mytool');
  assert.equal(s.state, 'menu');
  assert.equal(s.menu.selection, 'highlight');
  assert.deepEqual(s.menu.options.map((o) => o.label), ['default', 'work', 'personal']);
  assert.equal(s.menu.selected_index, 1);
  assert.equal(s.menu.question, 'Pick a profile');
  assert.equal(findOption(s.menu, 3).option.label, 'personal');
});

// fzf's default layout: list bottom-up, the selected row marked ">", a match
// counter, and the query line ("> co") at the bottom holding the cursor.
const FZF = [
  '  src/menu-select.ts',
  '  src/screen-styles.ts',
  '> src/screen-summary.ts',
  '  3/41 ──────────',
  '> scr',
];

test('fzf-style list: ">" marker with exact-column siblings; counter and query line are not options', () => {
  const s = summarizeScreen(at(FZF, 4, { command: 'fzf' }));
  assert.equal(s.state, 'menu');
  assert.deepEqual(s.menu.options.map((o) => o.label), ['src/menu-select.ts', 'src/screen-styles.ts', 'src/screen-summary.ts']);
  assert.equal(s.menu.options[s.menu.selected_index].label, 'src/screen-summary.ts');
  assert.equal(findOption(s.menu, 'styles').option.index, 1);
});

test('a ">" REPL prompt with output below is NOT a menu', () => {
  const repl = ['> 1 + 1', '2', '> [1, 2].map(String)', "[ '1', '2' ]", '> '];
  const s = summarizeScreen({ command: 'node', title: '', mode: 'normal', screen: repl, cursor: { x: 2, y: 4 } });
  assert.equal(s.state, 'text_input');
  assert.equal(s.menu, null);
  assert.equal(s.prompt.kind, 'line');
  // The query line on the cursor row is never read as the selection.
  assert.equal(detectMenu(['> abc', '  def', '  ghi'], { cursorRow: 0 }), null);
});

// bash `select` inside a script: numbers, no highlight, `#?` prompt.
const SELECT = ['Choose a target:', '1) staging', '2) production', '3) quit', '#? '];

test('typed-number menu (bash select) at a shell: state menu, selection typed, guard knows the numbers', () => {
  const s = summarizeScreen({ command: 'bash', title: '', mode: 'normal', screen: SELECT, cursor: { x: 3, y: 4 } });
  assert.equal(s.program, 'shell');
  assert.equal(s.state, 'menu');
  assert.equal(s.menu.selection, 'typed');
  assert.equal(s.menu.selected_index, -1);
  assert.deepEqual(s.menu.options.map((o) => `${o.number}:${o.label}`), ['1:staging', '2:production', '3:quit']);
  assert.equal(s.menu.question, 'Choose a target:');
  assert.equal(s.menu.options[2].destructive, true, '"quit" is destructive');
  assert.equal(guardInput(s, [{ text: '3' }, { key: 'Enter' }])?.refused, true);
  assert.equal(guardInput(s, [{ text: '1' }, { key: 'Enter' }]), null);
});

test('typed-number menu: "Enter choice [1-3]:" with a digit typed; a shell prompt under a list is NOT one', () => {
  const m = detectTypedMenu(['Options:', '  [1] build', '  [2] test', '  [3] deploy', 'Enter choice [1-3]: 2'], 4);
  assert.deepEqual(m.options.map((o) => o.label), ['build', 'test', 'deploy']);
  assert.equal(detectTypedMenu(['1. foo', '2. bar', 'user@host:~$ '], 2), null);
  const sh = summarizeScreen({ command: 'bash', title: '', mode: 'normal', screen: ['1. foo', '2. bar', 'user@host:~$ '], cursor: { x: 13, y: 2 } });
  assert.equal(sh.state, 'shell_prompt');
  assert.equal(detectTypedMenu(['1) a   3) c', '2) b   4) d', '#? '], 2), null, 'multi-column lists are left alone');
});

test('yes/no prompt: default from the capital letter, destructive question flagged, any program', () => {
  const p = detectPrompt(['Removing 3 packages.', 'Do you want to continue? [Y/n] '], { x: 31, y: 1 });
  assert.deepEqual(p, { kind: 'yes_no', question: 'Do you want to continue?', default: 'yes', destructive: false });
  const d = detectPrompt(['Delete all build artifacts? (y/N) '], { x: 33, y: 0 });
  assert.equal(d.default, 'no');
  assert.equal(d.destructive, true);
  const s = summarizeScreen({ command: 'apt', title: '', mode: 'normal', screen: ['Do you want to continue? [Y/n] '], cursor: { x: 31, y: 0 } });
  assert.equal(s.state, 'text_input');
  assert.equal(s.prompt.kind, 'yes_no');
  // A script's `read -p` at a shell is a question, not the shell prompt …
  const r = summarizeScreen({ command: 'bash', title: '', mode: 'normal', screen: ['Overwrite config? [y/N] '], cursor: { x: 24, y: 0 } });
  assert.equal(r.state, 'text_input');
  // … but a command line that merely contains "[y/N]" is still the shell prompt.
  const c = summarizeScreen({ command: 'bash', title: '', mode: 'normal', screen: ['user@host:~$ echo [y/N]'], cursor: { x: 23, y: 0 } });
  assert.equal(c.state, 'shell_prompt');
});

test('input lines: prompt glyphs and inquirer-style questions, in any program', () => {
  for (const row of ['>>> ', '... ', '❯ ', '› hello', '│ > │', '» ']) {
    assert.equal(detectPrompt([row], { x: 0, y: 0 })?.kind, 'line', row);
  }
  assert.deepEqual(detectPrompt(['? Project name: my-app'], { x: 22, y: 0 }), { kind: 'line', question: 'Project name:' });
  assert.equal(detectPrompt(['compiling…'], { x: 0, y: 0 }), null);
  const s = summarizeScreen(at(['── chat ──', '❯ '], 1, { command: 'sometui' }));
  assert.equal(s.state, 'text_input');
});

test('"esc to interrupt" means busy for any program, even with an input line on screen', () => {
  const s = summarizeScreen(at(['✻ Thinking… (esc to interrupt)', '❯ '], 1, { command: 'sometui' }));
  assert.equal(s.state, 'busy');
});

test('reverse-video highlight is a generic selection (no glyph needed), also on a numbered list', () => {
  const styled = ['Choose:', `  1. alpha`, `  ${E}[7m2. beta${E}[0m`, `  3. gamma`];
  const m = menuFromStyled(styled);
  assert.deepEqual(m.options.map((o) => o.label), ['alpha', 'beta', 'gamma']);
  assert.equal(m.selected_index, 1);
});

test('ghost text after any prompt glyph', () => {
  assert.equal(ghostText([`» ${E}[90mtype a command${E}[39m`], { x: 2, y: 0 }), 'type a command');
});

test('program profiles are data: label + role only; unknown programs keep their command name', () => {
  assert.ok(PROGRAM_PROFILES.every((p) => p.commands instanceof RegExp));
  assert.equal(profileFor('less', '', [])?.role, 'pager');
  assert.equal(profileFor('mytool', '', []), null);
  assert.equal(summarizeScreen({ command: 'nano', title: '', mode: 'alternate', screen: ['x'], cursor: { x: 0, y: 0 } }).state, 'editor');
  assert.equal(summarizeScreen({ command: 'python3.12', title: '', mode: 'normal', screen: ['>>> '], cursor: { x: 4, y: 0 } }).program, 'python');
  // A node-hosted CLI needs a screen signature too; plain node stays "node".
  assert.equal(summarizeScreen({ command: 'node', title: '', mode: 'normal', screen: ['> '], cursor: { x: 2, y: 0 } }).program, 'node');
});
