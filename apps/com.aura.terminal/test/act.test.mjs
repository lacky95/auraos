// act (B11 / TM-11): the act-and-verify flow with injected screen/input — no
// tmux, no network. Guard refusals send nothing, `force` skips only the guard,
// settle vs wait_for, changed rows, and the bad-regex / bad-arguments paths.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.AURA_TERM_TMUX = '0';
process.env.OS_API_BASE = 'http://127.0.0.1:9';

const { act, changedRows, waitMatcher, hasNewMatch, refusalFor, summarize } = await import('../src/mcp/act.ts');

const ROWS = 6;
const pad = (lines) => [...lines, ...Array(ROWS).fill('')].slice(0, ROWS).map((l) => l.padEnd(40));
const view = (lines, extra = {}) => ({
  id: 'com.aura.terminal-0#a1', mode: 'normal', cols: 40, rows: ROWS, cursor: { x: 0, y: Math.max(0, lines.length - 1) },
  command: 'bash', title: '', historySize: 0, inUse: false, settled: true, screen: pad(lines), scrollback: [], ...extra,
});

/** Fake session: `frames` are returned in order (the last one repeats); records every call. */
function fake(frames) {
  const calls = { screen: [], send: [] };
  let i = 0;
  let t = 0;
  return {
    calls,
    deps: {
      screen: async (id, opts) => { calls.screen.push(opts); const f = frames[Math.min(i, frames.length - 1)]; i++; return f; },
      send: async (id, steps, paste) => {
        calls.send.push({ steps, paste });
        return { chars: steps.reduce((n, s) => n + ('text' in s ? s.text.length : 0), 0), keys: steps.filter((s) => 'key' in s).map((s) => s.key) };
      },
      sleep: async (ms) => { t += ms; },
      now: () => t,
    },
  };
}

const PROMPT = 'user@host:~$ ';
const MENU = [
  'Do you trust the files in this folder?',
  '❯ 1. Yes, proceed',
  '  2. No, exit',
  'Enter to confirm · Esc to exit',
];

test('act: one batch, settle, summary and changed rows', async () => {
  const f = fake([view([PROMPT]), view([`${PROMPT}echo hi`, 'hi', PROMPT])]);
  const out = await act(f.deps, 'x', { steps: [{ text: 'echo hi' }, { key: 'Enter' }] });
  assert.ok(!('refused' in out));
  assert.equal(f.calls.send.length, 1, 'exactly one input batch');
  assert.deepEqual(f.calls.send[0].steps, [{ text: 'echo hi' }, { key: 'Enter' }]);
  assert.deepEqual(f.calls.screen[0], { settleMs: 0 }, 'the before-read does not wait');
  assert.equal(f.calls.screen[1].settleMs, 200, 'default settle_ms');
  assert.equal(f.calls.screen[1].timeoutMs, 4000, 'default timeout_ms');
  assert.equal(out.beforeSummary.state, 'shell_prompt');
  assert.equal(out.summary.state, 'shell_prompt');
  assert.deepEqual(out.changed.map((c) => [c.row, c.text]), [[0, `${PROMPT}echo hi`], [1, 'hi'], [2, PROMPT.trimEnd()]]);
  assert.equal(out.changed[0].before, PROMPT.trimEnd());
  assert.deepEqual(out.sent, { chars: 7, keys: ['Enter'] });
});

test('act: B6 guard refuses before sending; force skips only the guard', async () => {
  const exit = fake([view([PROMPT])]);
  const r1 = await act(exit.deps, 'x', { steps: [{ text: 'exit' }, { key: 'Enter' }] });
  assert.equal(r1.refused.refused, true);
  assert.match(r1.refused.reason, /end the shell/);
  assert.equal(exit.calls.send.length, 0, 'nothing sent');

  const ctrlD = fake([view([PROMPT])]);
  assert.equal((await act(ctrlD.deps, 'x', { steps: [{ key: 'Ctrl+D' }] })).refused.refused, true);
  assert.equal(ctrlD.calls.send.length, 0);

  const menu = fake([view(MENU, { command: 'claude' })]);
  const r3 = await act(menu.deps, 'x', { steps: [{ key: 'Down' }, { key: 'Enter' }] });
  assert.equal(r3.refused.refused, true);
  assert.equal(r3.refused.would_select, '2. No, exit');
  assert.equal(r3.refused.screen_state, 'menu');
  assert.equal(menu.calls.send.length, 0);

  const digit = fake([view(MENU, { command: 'claude' })]);
  assert.equal((await act(digit.deps, 'x', { steps: [{ text: '2' }] })).refused.refused, true);

  const dead = fake([view([PROMPT], { dead: true, deadStatus: 0 })]);
  const r4 = await act(dead.deps, 'x', { steps: [{ text: 'ls' }] });
  assert.match(r4.refused.reason, /has exited/);
  assert.equal(r4.refused.respawned, undefined);
  const respawned = fake([view([PROMPT], { dead: true, deadStatus: 0, respawned: true })]);
  const r4b = await act(respawned.deps, 'x', { steps: [{ text: 'ls' }] });
  assert.equal(r4b.refused.respawned, true);
  assert.match(r4b.refused.hint, /fresh shell/);
  assert.equal(respawned.calls.send.length, 0);

  const forced = fake([view([PROMPT]), view(['[exited]'])]);
  const r5 = await act(forced.deps, 'x', { steps: [{ text: 'exit' }, { key: 'Enter' }], force: true });
  assert.ok(!('refused' in r5), 'force sends');
  assert.equal(forced.calls.send.length, 1);
  assert.equal(r5.beforeSummary.state, 'shell_prompt', 'the screen is still read under force');
});

test('act: refuseOnMenu (run_command) refuses any text on a menu', async () => {
  const f = fake([view(MENU, { command: 'claude' })]);
  const r = await act(f.deps, 'x', { steps: [{ text: 'ls' }, { key: 'Enter' }], refuseOnMenu: true });
  assert.equal(r.refused.refused, true);
  assert.match(r.refused.reason, /selection menu/);
  assert.ok(r.refused.menu);
  // Without it a safe key on a menu goes through.
  const g = fake([view(MENU, { command: 'claude' }), view(['ok'], { command: 'claude' })]);
  assert.ok(!('refused' in await act(g.deps, 'x', { steps: [{ key: 'Enter' }] })));
});

test('act: wait_for polls until a NEW matching row appears', async () => {
  const f = fake([
    view([PROMPT, 'DONE old']),          // before: an old DONE is already on screen
    view([PROMPT, 'DONE old']),          // poll 1: nothing new
    view([PROMPT, 'DONE old', 'working']),
    view([PROMPT, 'DONE old', 'working', 'DONE new']),
  ]);
  const out = await act(f.deps, 'x', { steps: [{ text: 'make' }, { key: 'Enter' }], waitFor: 'DONE' });
  assert.deepEqual(out.waitFor, { pattern: 'DONE', matched: true });
  assert.equal(out.after.settled, true);
  assert.equal(f.calls.screen.length, 4);
  assert.ok(f.calls.screen.slice(1).every((o) => o.settleMs === 0), 'wait_for polls without settling');
  assert.equal(out.elapsedMs, 200, 'two 100 ms polls');
});

test('act: wait_for times out with matched:false and settled:false', async () => {
  const f = fake([view([PROMPT]), view([PROMPT, 'still going'])]);
  const out = await act(f.deps, 'x', { steps: [{ key: 'Enter' }], waitFor: '/^ready$/i', timeoutMs: 500 });
  assert.deepEqual(out.waitFor, { pattern: '/^ready$/i', matched: false });
  assert.equal(out.after.settled, false);
  assert.ok(out.elapsedMs >= 500);
});

test('act: a bad wait_for regex throws before anything is sent', async () => {
  const f = fake([view([PROMPT])]);
  await assert.rejects(act(f.deps, 'x', { steps: [{ key: 'Enter' }], waitFor: '/(/' }));
  assert.equal(f.calls.send.length, 0);
});

test('helpers: changedRows, waitMatcher, hasNewMatch, refusalFor', () => {
  assert.deepEqual(changedRows(['a  ', 'b'], ['a', 'c', 'd']), [{ row: 1, text: 'c' }, { row: 2, text: 'd' }]);
  assert.deepEqual(changedRows(['a'], ['b'], true), [{ row: 0, text: 'b', before: 'a' }]);
  assert.equal(waitMatcher('a.b')('xa.by'), true);
  assert.equal(waitMatcher('a.b')('axb'), false, 'plain text is literal');
  assert.equal(waitMatcher('/a.b/')('axb'), true);
  assert.equal(waitMatcher('/^X$/i')('x'), true);
  assert.equal(hasNewMatch(['$ '], ['$ ls', 'f', '$ '], (l) => l.endsWith('$')), true, 'second prompt is new');
  assert.equal(hasNewMatch(['old', 'DONE'], ['DONE', 'x'], (l) => l === 'DONE'), false, 'scrolled, not new');
  const s = summarize(view([PROMPT]));
  assert.equal(refusalFor(s, [{ text: 'ls' }, { key: 'Enter' }]), null);
  assert.equal(refusalFor(s, [{ text: 'logout' }, { key: 'Enter' }]).refused, true);
});
