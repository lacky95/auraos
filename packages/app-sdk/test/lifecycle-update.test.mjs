// Phase 6 stream M: the SDK's `onUpdate` hook and stop reason `update`. `createUpdateHandler` hands the app
// {fromVersion, toVersion}, answers {ok:true}, a thrown error is a 500 (the kernel fails the update and rolls
// back); a body without the versions is a 400; `lifecycleContextOf` reads `update` from x-aura-stop-reason and
// keeps unknown values null (older and newer kernels stay compatible; auraContract stays 1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUpdateHandler, lifecycleContextOf } from '../dist/lifecycle.js';

const post = (body) => ({ request: new Request('http://app/api/lifecycle/onUpdate', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'x-aura-maintenance': 'update' } }) });

test('createUpdateHandler: the versions to the app, {ok:true}', async () => {
  const seen = [];
  const res = await createUpdateHandler(async (ctx) => { seen.push(ctx); })(post({ fromVersion: '1.0.0', toVersion: '1.1.0' }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.deepEqual(seen, [{ fromVersion: '1.0.0', toVersion: '1.1.0' }]);
});

test('createUpdateHandler: a throwing migration is a 500; a body without the versions is a 400', async () => {
  const bad = await createUpdateHandler(() => { throw new Error('schema v3 unknown'); })(post({ fromVersion: '1', toVersion: '2' }));
  assert.equal(bad.status, 500);
  assert.match((await bad.json()).error, /schema v3 unknown/);
  const none = await createUpdateHandler(() => {})(post({}));
  assert.equal(none.status, 400);
});

test('lifecycleContextOf: reason update; unknown values stay null', () => {
  assert.deepEqual(lifecycleContextOf(new Headers({ 'x-aura-stop-reason': 'update' })), { reason: 'update' });
  assert.deepEqual(lifecycleContextOf(new Headers({ 'x-aura-stop-reason': 'restart' })), { reason: 'restart' });
  assert.deepEqual(lifecycleContextOf(new Headers({ 'x-aura-stop-reason': 'repair' })), { reason: null });
  assert.deepEqual(lifecycleContextOf(new Headers()), { reason: null });
});
