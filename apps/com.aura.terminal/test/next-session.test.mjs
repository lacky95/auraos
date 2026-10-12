// Pure: where a window goes when `exit` in its root shell ended its session.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickNextSession } from '../src/next-session.ts';

const I = 'com.aura.terminal-3';
const row = (n, inUse = false) => ({ id: `${I}#a${n}`, inUse });
const pick = (rows, ended) => pickNextSession(rows, `${I}#a${ended}`)?.id ?? null;

test('nothing left → null', () => {
  assert.equal(pick([], 1), null);
  assert.equal(pick([row(1)], 1), null, 'the ended session itself is never picked');
});

test('the next higher session after the ended one', () => {
  assert.equal(pick([row(1), row(2), row(3)], 2), `${I}#a3`);
  assert.equal(pick([row(3), row(1), row(5)], 2), `${I}#a3`, 'input order does not matter');
});

test('wraps round to the lowest when the ended one was last', () => {
  assert.equal(pick([row(1), row(2), row(3)], 3), `${I}#a1`);
});

test('numeric order, not string order', () => {
  assert.equal(pick([row(2), row(10), row(9)], 9), `${I}#a10`);
});

test('a session no other window renders beats one that is in use', () => {
  assert.equal(pick([row(1), row(2), row(3, true)], 2), `${I}#a1`);
});

test('all in use → still moves on (to the next one)', () => {
  assert.equal(pick([row(1, true), row(2), row(3, true)], 2), `${I}#a3`);
});

test('rows without an id are ignored', () => {
  assert.equal(pickNextSession([{ id: '' }, null, { id: `${I}#a4` }], `${I}#a1`)?.id, `${I}#a4`);
});
