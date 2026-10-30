// Scrollback replayed to a newly granted window: the newest part only, cut at
// a line start (src/replay-tail.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replayTail, replayBudget, DEFAULT_REPLAY_BYTES } from '../src/replay-tail.ts';

test('short scrollback is replayed whole', () => {
  assert.equal(replayTail('a\nb\n', 100), 'a\nb\n');
});

test('long scrollback keeps the newest part, starting at a line start', () => {
  const lines = Array.from({ length: 100 }, (_, i) => `\x1b[32mline ${i}\x1b[0m`).join('\r\n');
  const out = replayTail(lines, 200);
  assert.ok(out.length <= 200);
  assert.ok(lines.endsWith(out));
  assert.match(out, /^\x1b\[32mline \d+/, 'starts at the beginning of a line, not inside an escape');
});

test('no newline near the cut: cut exactly at the budget', () => {
  const s = 'x'.repeat(10_000);
  assert.equal(replayTail(s, 100).length, 100);
});

test('budget from TERMINAL_REPLAY_BYTES, default otherwise', () => {
  assert.equal(replayBudget({}), DEFAULT_REPLAY_BYTES);
  assert.equal(replayBudget({ TERMINAL_REPLAY_BYTES: '131072' }), 131072);
  assert.equal(replayBudget({ TERMINAL_REPLAY_BYTES: 'nope' }), DEFAULT_REPLAY_BYTES);
  assert.equal(replayBudget({ TERMINAL_REPLAY_BYTES: '0' }), DEFAULT_REPLAY_BYTES);
});
