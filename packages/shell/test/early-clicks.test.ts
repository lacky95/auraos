// Bar clicks before their component's script runs (lib/earlyClicks.ts) and
// open requests before a dialog island mounts (lib/openRequest.ts).
//
//   cd packages/shell && npx tsx --test test/early-clicks.test.ts
import { dom } from './dom.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { claimEarlyClicks } = await import('../src/lib/earlyClicks.ts');
const { requestOpen, onOpenRequest } = await import('../src/lib/openRequest.ts');

type EarlyWin = { __auraEarlyClicks?: string[]; __auraEarlyReady?: Record<string, boolean> };
const w = dom as unknown as EarlyWin;

test('a queued click replays once when its component claims it', () => {
  w.__auraEarlyClicks = ['launcher', 'procman', 'launcher'];
  let runs = 0;
  claimEarlyClicks('launcher', () => runs++);
  assert.equal(runs, 1);
  assert.deepEqual(w.__auraEarlyClicks, ['procman']);
  assert.equal(w.__auraEarlyReady?.['launcher'], true);
  claimEarlyClicks('launcher', () => runs++);   // nothing queued any more
  assert.equal(runs, 1);
});

test('claiming with no queued click only marks the name ready', () => {
  w.__auraEarlyClicks = [];
  let runs = 0;
  claimEarlyClicks('viewport', () => runs++);
  assert.equal(runs, 0);
  assert.equal(w.__auraEarlyReady?.['viewport'], true);
});

test('an open request waits for a listener that registers later', () => {
  let opened = 0;
  requestOpen('aura.test.open');
  const off = onOpenRequest('aura.test.open', () => opened++);
  assert.equal(opened, 1, 'the waiting request is taken on registration');
  requestOpen('aura.test.open');
  assert.equal(opened, 2, 'later requests arrive as events');
  off();
  requestOpen('aura.test.open');
  assert.equal(opened, 2);
  const again = onOpenRequest('aura.test.open', () => opened++);
  assert.equal(opened, 3, 'a request made while nobody listened is kept');
  again();
});
