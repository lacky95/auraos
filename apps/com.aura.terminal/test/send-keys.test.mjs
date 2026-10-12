// send_keys item classification (B12): key names stay keys, other strings are
// typed literally, near-misses of key names are rejected.

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.AURA_TERM_TMUX = '0';
process.env.OS_API_BASE = 'http://127.0.0.1:9';

const { keysToSteps, looksLikeKeyTypo } = await import('../src/mcp/terminal.ts');

test('keysToSteps: keys, literals, typos', () => {
  assert.deepEqual(keysToSteps(['Escape', ':wq', 'Enter']), [{ key: 'Escape' }, { text: ':wq' }, { key: 'Enter' }]);
  assert.deepEqual(keysToSteps(['Ctrl+C', 'q']), [{ key: 'Ctrl+C' }, { key: 'q' }]);
  assert.deepEqual(keysToSteps(['ls -la', 'Enter']), [{ text: 'ls -la' }, { key: 'Enter' }]);
  assert.deepEqual(keysToSteps(['/exit']), [{ text: '/exit' }]);
  for (const typo of ['Enterr', 'Escpe', 'Ctrl+é', 'Super+x', 'Dwn']) {
    assert.throws(() => keysToSteps([typo]), (e) => e.code === 'bad-key', typo);
  }
  assert.equal(looksLikeKeyTypo('hello'), false);
  assert.equal(looksLikeKeyTypo('exit'), false);
});
