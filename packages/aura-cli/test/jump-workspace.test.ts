import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jumpWorkspace } from '../src/lib/jump-workspace.js';
test('DevBox jumps use data; other apps and invalid paths retain source cwd', () => {
  assert.equal(jumpWorkspace({ metadata: { kind: 'devbox-v1', 'dev-workspace': { folder: '/data/workspace' } } }), '/data/workspace');
  assert.equal(jumpWorkspace({ metadata: { 'dev-workspace': { folder: '/data/workspace' } } }), undefined);
  for (const folder of ['/home/aura', '/data/../src', '/data/./x', '/data/x\n', '/data/x\\y', null]) {
    assert.equal(jumpWorkspace({ metadata: { kind: 'devbox-v1', 'dev-workspace': { folder } } }), undefined);
  }
});
