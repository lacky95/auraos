// flight-notice: what an app may put on a flight's tab to ask for attention
// (AppManager.notifyFlight) — clamps, the `at` stamp, and when an open clears it.
//
//   pnpm --filter @aura/core test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanNotice, patchOpensFlight, noticeClearsOnOpen, NOTICE_TEXT_MAX } from '../dist/app-manager/flight-notice.js';

test('cleanNotice keeps a valid notice, stamps at, clamps the rest', () => {
  const n = cleanNotice({ level: 'attention', text: '  Koch: hi there, long text  ', count: 12345.6, blink: 99, ttlMs: 5, clearOnOpen: false }, 1000);
  assert.equal(n.level, 'attention');
  assert.equal(n.at, 1000);
  assert.equal(n.text, 'Koch: hi there, long text'.slice(0, NOTICE_TEXT_MAX));
  assert.equal(n.count, 9999);
  assert.equal(n.blink, 10);
  assert.equal(n.ttlMs, 1000);
  assert.equal(n.clearOnOpen, false);
});

test('cleanNotice drops what is empty or out of range; defaults are absent (the shell applies them)', () => {
  const n = cleanNotice({ level: 'info', text: '   ', count: 0, blink: -2, ttlMs: 10 ** 9, clearOnOpen: true }, 7);
  assert.deepEqual(n, { level: 'info', at: 7, blink: 0, ttlMs: 60_000 });
});

test('cleanNotice refuses an unknown level or a non-object', () => {
  assert.throws(() => cleanNotice({ level: 'loud' }, 1), /level must be/);
  assert.throws(() => cleanNotice(null, 1), /level must be/);
  assert.throws(() => cleanNotice('attention', 1), /level must be/);
});

test('an unfolding patch opens the flight; a notice clears on open unless it opted out', () => {
  assert.equal(patchOpensFlight({ perch: null }), true);
  assert.equal(patchOpensFlight({ folded: false }), true);
  assert.equal(patchOpensFlight({ folded: true }), false);
  assert.equal(patchOpensFlight({ badge: { label: 'x' } }), false);
  assert.equal(patchOpensFlight({ rect: { x: 0, y: 0, w: 100, h: 100 } }), false);
  assert.equal(noticeClearsOnOpen({ level: 'urgent' }), true);
  assert.equal(noticeClearsOnOpen({ level: 'urgent', clearOnOpen: false }), false);
  assert.equal(noticeClearsOnOpen(undefined), false);
});
