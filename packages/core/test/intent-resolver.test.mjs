// Tests for IntentResolver scoring + ranking.
// Run via:
//   pnpm --filter @aura/core build
//   node --test packages/core/test/intent-resolver.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { IntentResolver, scoreFilter } from '../dist/app-manager/IntentResolver.js';

const baseFilter = {
  action: 'aura.intent.action.SEND',
  category: [],
  dataMime: [],
  dataScheme: [],
  priority: 0,
};

test('scoreFilter: exact mime > wildcard major > catch-all', () => {
  const fExact = { ...baseFilter, dataMime: ['text/plain'] };
  const fMajor = { ...baseFilter, dataMime: ['text/*']     };
  const fAny   = { ...baseFilter, dataMime: ['*/*']        };
  const intent = { action: 'aura.intent.action.SEND', type: 'text/plain' };
  assert.equal(scoreFilter(fExact, intent), 100);
  assert.equal(scoreFilter(fMajor, intent),  50);
  assert.equal(scoreFilter(fAny,   intent),  10);
});

test('scoreFilter: declared mime but no match → null (filter dropped)', () => {
  const f = { ...baseFilter, dataMime: ['image/png'] };
  assert.equal(scoreFilter(f, { action: 'aura.intent.action.SEND', type: 'text/plain' }), null);
});

test('scoreFilter: intent without type cannot satisfy a mime-constrained filter', () => {
  const f = { ...baseFilter, dataMime: ['text/plain'] };
  assert.equal(scoreFilter(f, { action: 'aura.intent.action.SEND' }), null);
});

test('scoreFilter: scheme exact match → +30; mismatch → null', () => {
  const f = { ...baseFilter, dataScheme: ['aura'] };
  assert.equal(scoreFilter(f, { action: 'aura.intent.action.SEND', uri: 'aura://settings/theme' }), 30);
  assert.equal(scoreFilter(f, { action: 'aura.intent.action.SEND', uri: 'http://example.com'    }), null);
  assert.equal(scoreFilter(f, { action: 'aura.intent.action.SEND' }),                                null);
});

test('scoreFilter: category overlap each adds +5', () => {
  const f = { ...baseFilter, category: ['aura.intent.category.DEFAULT', 'extra'] };
  const s = scoreFilter(f, { action: 'aura.intent.action.SEND',
    category: ['aura.intent.category.DEFAULT', 'extra'] });
  assert.equal(s, 10);
});

test('scoreFilter: priority added as-is', () => {
  const f = { ...baseFilter, priority: 7 };
  const s = scoreFilter(f, { action: 'aura.intent.action.SEND' });
  assert.equal(s, 7);
});

test('IntentResolver: ranks candidates by score descending', () => {
  const r = new IntentResolver();
  r.reload([
    { id: 'a.viewer.png',   intentFilters: [{ ...baseFilter, action: 'aura.intent.action.VIEW', dataMime: ['image/png'] }] },
    { id: 'a.viewer.any',   intentFilters: [{ ...baseFilter, action: 'aura.intent.action.VIEW', dataMime: ['*/*']        }] },
    { id: 'a.viewer.image', intentFilters: [{ ...baseFilter, action: 'aura.intent.action.VIEW', dataMime: ['image/*']    }] },
  ]);
  const out = r.resolve({ action: 'aura.intent.action.VIEW', type: 'image/png' });
  assert.equal(out.length, 3);
  assert.deepEqual(out.map(m => m.appId), ['a.viewer.png', 'a.viewer.image', 'a.viewer.any']);
  assert.deepEqual(out.map(m => m.score), [100, 50, 10]);
});

test('IntentResolver: action mismatch drops all candidates', () => {
  const r = new IntentResolver();
  r.reload([
    { id: 'a.send', intentFilters: [{ ...baseFilter, action: 'aura.intent.action.SEND' }] },
  ]);
  const out = r.resolve({ action: 'aura.intent.action.VIEW' });
  assert.equal(out.length, 0);
});

test('IntentResolver: priority breaks ties between same-specificity filters', () => {
  const r = new IntentResolver();
  r.reload([
    { id: 'a.low',  intentFilters: [{ ...baseFilter, action: 'a', dataMime: ['text/plain'], priority: 1 }] },
    { id: 'a.high', intentFilters: [{ ...baseFilter, action: 'a', dataMime: ['text/plain'], priority: 9 }] },
  ]);
  const out = r.resolve({ action: 'a', type: 'text/plain' });
  assert.deepEqual(out.map(m => m.appId), ['a.high', 'a.low']);
  assert.equal(out[0].score, 109);
  assert.equal(out[1].score, 101);
});
