// Boot timeline: marks, stages, the ?log= / KV log switch
// (lib/bootTimeline.ts, lib/logControl.ts).
//
//   cd packages/shell && npx tsx --test test/boot-timeline.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mark, markTime, markCount, onStage, resolveStage, isStageDone, stage, summaryRows, _resetForTests,
} from '../src/lib/bootTimeline.ts';
import { applyUrlLogParam, applyKvLogValue, LOG_STORAGE_KEY } from '../src/lib/logControl.ts';

beforeEach(() => _resetForTests());

test('marks are recorded in order with their detail', () => {
  mark('a');
  mark('b', { n: 1 });
  mark('b');
  assert.notEqual(markTime('a'), null);
  assert.equal(markTime('missing'), null);
  assert.equal(markCount('b'), 2);
  assert.equal(markCount('*'), 3);
  const rows = summaryRows();
  assert.deepEqual(rows.map((r) => r.mark), ['a', 'b', 'b']);
  assert.equal(rows[1]!.detail, '{"n":1}');
  assert.ok(rows.every((r) => r.delta >= 0));
});

test('onStage runs waiters once the stage resolves, and at once afterwards', async () => {
  const seen: string[] = [];
  onStage('ws:active-loaded', () => seen.push('early'));
  assert.equal(isStageDone('ws:active-loaded'), false);
  resolveStage('ws:active-loaded');
  resolveStage('ws:active-loaded'); // idempotent
  onStage('ws:active-loaded', () => seen.push('late'));
  assert.deepEqual(seen, ['early', 'late']);
  assert.equal(markCount('stage:ws:active-loaded'), 1);
  await stage('ws:active-loaded'); // resolved promise
});

test('onStage timeout releases the waiter once, even if the stage comes later', async () => {
  let runs = 0;
  onStage('never', () => runs++, { timeoutMs: 5 });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(runs, 1);
  resolveStage('never');
  assert.equal(runs, 1);
  assert.equal(markCount('stage-timeout:never'), 1);
});

test('a waiter that throws does not stop the others', () => {
  const seen: number[] = [];
  const origError = console.error;
  console.error = () => undefined;
  try {
    onStage('s', () => { throw new Error('boom'); });
    onStage('s', () => seen.push(2));
    resolveStage('s');
  } finally { console.error = origError; }
  assert.deepEqual(seen, [2]);
});

function memStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, m };
}

test('?log= sets, ?log=off clears, no param leaves the filter alone', () => {
  const st = memStorage();
  assert.equal(applyUrlLogParam('?x=1', st), false);
  assert.equal(applyUrlLogParam('?log=shell:*', st), true);
  assert.equal(st.getItem(LOG_STORAGE_KEY), 'shell:*');
  assert.equal(applyUrlLogParam('?log=off', st), true);
  assert.equal(st.getItem(LOG_STORAGE_KEY), null);
  st.setItem(LOG_STORAGE_KEY, 'keymap');
  applyUrlLogParam('', st);
  assert.equal(st.getItem(LOG_STORAGE_KEY), 'keymap');
});

test('the KV value mirrors into storage; empty / off / non-string clears', () => {
  const st = memStorage();
  applyKvLogValue(' shell:boot ', st);
  assert.equal(st.getItem(LOG_STORAGE_KEY), 'shell:boot');
  applyKvLogValue('', st);
  assert.equal(st.getItem(LOG_STORAGE_KEY), null);
  applyKvLogValue('shell:*', st);
  applyKvLogValue(null, st);
  assert.equal(st.getItem(LOG_STORAGE_KEY), null);
  applyKvLogValue('off', st);
  assert.equal(st.getItem(LOG_STORAGE_KEY), null);
});
