// TM-16 / TM-17, pure: picking a menu row (label / number / index) and the
// dim-text marking of get_screen, against captured screens WITH their escape
// sequences (what `tmux capture-pane -p -e -N` returns).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectMenu } from '../src/screen-summary.ts';
import { findOption, planMove, menuFromStyled } from '../src/menu-select.ts';
import { parseStyledLine, dimRuns, markDim, ghostText, plainOf } from '../src/screen-styles.ts';

const E = '\x1b';

// Claude Code's trust prompt (numbered, ❯ on option 1).
const TRUST = [
  ' Do you trust the files in this folder?',
  '',
  ' ❯ 1. Yes, proceed',
  '   2. No, exit',
  '',
  ' Enter to confirm · Esc to exit',
];

// A Claude Code AskUserQuestion-style picker, unnumbered labels, ❯ on row 2.
const PICKER = [
  ' Which app should I open?',
  '',
  '   Terminal',
  ' ❯ Console',
  '   Settings',
  '   Type something.',
];

test('findOption: number picks the numbered option; out of range lists the labels', () => {
  const m = detectMenu(TRUST);
  assert.equal(findOption(m, 2).option.label, 'No, exit');
  assert.equal(findOption(m, '1').option.label, 'Yes, proceed');
  const miss = findOption(m, 7);
  assert.equal(miss.error.code, 'option-not-found');
  assert.deepEqual(miss.error.candidates, ['1. Yes, proceed', '2. No, exit']);
});

test('findOption: labels match exact, then prefix, then substring, case-insensitive', () => {
  const m = detectMenu(PICKER);
  assert.equal(findOption(m, 'console').option.index, 1);
  assert.equal(findOption(m, 'Type').option.label, 'Type something.');
  assert.equal(findOption(m, 'ting').option.label, 'Settings');
  assert.equal(findOption(m, 3).option.label, 'Settings', 'unnumbered menu: 1-based index');
  const amb = findOption(m, 'e');
  assert.equal(amb.error.code, 'option-ambiguous');
  assert.ok(amb.error.candidates.length >= 2);
  assert.equal(findOption(m, 'Notepad').error.code, 'option-not-found');
});

test('planMove: arrow direction and count from the selected row', () => {
  const m = detectMenu(PICKER);
  assert.deepEqual(planMove(m, 1), { key: null, count: 0 });
  assert.deepEqual(planMove(m, 3), { key: 'Down', count: 2 });
  assert.deepEqual(planMove(m, 0), { key: 'Up', count: 1 });
});

test('menuFromStyled: a reverse-video highlighted row without a ❯ marker is a menu', () => {
  const styled = [
    'Pick a profile',
    '',
    '  default',
    `  ${E}[7mwork${E}[0m`,
    '  personal',
    '',
  ];
  const m = menuFromStyled(styled);
  assert.ok(m);
  assert.deepEqual(m.options.map((o) => o.label), ['default', 'work', 'personal']);
  assert.equal(m.selected_index, 1);
  assert.equal(m.question, 'Pick a profile');
  // A plain screen with ❯ wins without needing styles.
  assert.equal(menuFromStyled(PICKER).selected_index, 1);
});

// ── TM-17: dim marking ──────────────────────────────────────────────────────

// Captured from tmux 3.x (`capture-pane -p -e -N`): reverse cursor cell, then
// the faint ghost suggestion, the way tmux re-emits SGR 2.
const CLAUDE_GHOST = [
  `${E}[2m────────────────────────────────────────${E}[0m`,
  `> ${E}[7my${E}[0;2m${E}[39m${E}[49mes restart them${E}[0m${E}[39m${E}[49m`,
  `${E}[2m────────────────────────────────────────${E}[0m`,
  `  ${E}[2m? for shortcuts${E}[0m`,
];

test('parseStyledLine: SGR 2 on/off, resets, 256/truecolor params skipped', () => {
  const cells = parseStyledLine(`a${E}[2mbc${E}[22md${E}[1;2me${E}[0mf${E}[2;38;2;1;2;3mg${E}[38;5;2mh`);
  assert.equal(cells.map((c) => c.ch).join(''), 'abcdefgh');
  assert.deepEqual(cells.map((c) => c.dim), [false, true, true, false, true, false, true, true]);
  const grey = parseStyledLine(`${E}[90mx${E}[39my${E}[38;5;244mz${E}[38;2;150;150;150mw`);
  assert.deepEqual(grey.map((c) => c.grey), [true, false, true, true]);
});

test('markDim wraps faint runs; plainOf strips the escapes', () => {
  assert.equal(plainOf(CLAUDE_GHOST[1]), '> yes restart them');
  const marked = markDim(CLAUDE_GHOST);
  assert.equal(marked[1], '> y⟦dim:es restart them⟧');
  assert.equal(marked[3], '  ⟦dim:? for shortcuts⟧');
  assert.equal(markDim(['plain row   '])[0], 'plain row');
  const runs = dimRuns(CLAUDE_GHOST);
  assert.deepEqual(runs.find((r) => r.row === 1), { row: 1, col: 3, text: 'es restart them' });
  assert.ok(!runs.some((r) => r.text.trim() === ''), 'whitespace-only runs are skipped');
});

test('ghostText: the faint tail of the cursor row (cursor cell may be reverse video)', () => {
  assert.equal(ghostText(CLAUDE_GHOST, { x: 2, y: 1 }), 'yes restart them');
  // Real typed text is not a ghost.
  assert.equal(ghostText(['> yes restart them'], { x: 18, y: 0 }), null);
  // Typed text followed by a grey suggestion: only the suggestion.
  assert.equal(ghostText([`> git st${E}[90matus${E}[39m`], { x: 8, y: 0 }), 'atus');
  // A boxed input row: the right border is ignored.
  assert.equal(ghostText([`│ > ${E}[2mTry "fix lint"${E}[22m   │`], { x: 4, y: 0 }), 'Try "fix lint"');
  assert.equal(ghostText(CLAUDE_GHOST, { x: 0, y: 9 }), null);
});

// Captured from a live Claude Code session (tmux `capture-pane -e`, 256 colours):
// it draws hints and recaps in grey 38;5;246 / rules in 38;5;244, never SGR 2,
// with the spaces between words unstyled.
const CLAUDE_256 = [
  `※${E}[39m ${E}[1m${E}[38;5;246mrecap:${E}[0m${E}[39m${E}[49m ${E}[3m${E}[38;5;246mI${E}[0m${E}[39m${E}[49m ${E}[3m${E}[38;5;246madded${E}[0m${E}[39m${E}[49m tests`,
  `${E}[0m${E}[38;5;244m${E}[49m──────────────────────${E}[39m`,
  `${E}[39m❯ ${E}[7my${E}[0m${E}[38;5;246mes restart them${E}[39m`,
  `${E}[39m  ${E}[38;5;220m⏵⏵${E}[39m ${E}[38;5;220mauto mode on${E}[38;5;246m (shift+tab${E}[39m ${E}[38;5;246mto cycle)${E}[39m`,
];

test('Claude Code 256-colour grey counts as faint; words join, rules are skipped', () => {
  const marked = markDim(CLAUDE_256);
  assert.equal(marked[0], '※ ⟦dim:recap: I added⟧ tests');
  assert.equal(marked[1], '──────────────────────', 'a grey rule is not marked');
  assert.equal(marked[2], '❯ y⟦dim:es restart them⟧');
  assert.equal(marked[3], '  ⏵⏵ auto mode on ⟦dim:(shift+tab to cycle)⟧');
  assert.equal(ghostText(CLAUDE_256, { x: 2, y: 2 }), 'yes restart them');
  assert.equal(ghostText(CLAUDE_256, { x: 0, y: 0 }), null, 'cursor row ends in normal text');
});
