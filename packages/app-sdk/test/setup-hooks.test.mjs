// D108 P3: the app's setup hooks (createSetupHandler, createValidateHandler,
// createMigrateConfigHandler) as the kernel's maintenance start calls them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSetupHandler, createValidateHandler, createMigrateConfigHandler, parseSetupHookInput } from '../dist/setup.js';

const call = (route, body) => route({ request: new Request('http://app/api/lifecycle/setup', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) });
const INPUT = { configDigest: 'sha256:c', previousDigest: null, attempt: 1, reason: 'setup' };

test('onSetup: the checked input reaches the app; ok, a thrown error is { ok: false, message } (500)', async () => {
  const seen = [];
  const r = await call(createSetupHandler((i) => { seen.push(i); }), INPUT);
  assert.deepEqual([r.status, await r.json()], [200, { ok: true }]);
  assert.deepEqual(seen, [INPUT]);
  const bad = await call(createSetupHandler(() => { throw new Error('db locked'); }), INPUT);
  assert.deepEqual([bad.status, await bad.json()], [500, { ok: false, message: 'db locked' }]);
  assert.equal((await call(createSetupHandler(), { ...INPUT, reason: 'other' })).status, 400);
  assert.equal(parseSetupHookInput({ ...INPUT, attempt: 1.5 }), null);
  assert.equal((await call(createSetupHandler(), INPUT)).status, 200, 'no impl: ok');
});

test('onValidate: the ValidateResult as given; default ok', async () => {
  const r = await call(createValidateHandler(() => ({ ok: false, fieldErrors: { host: 'unreachable' } })), { configDigest: 'd' });
  assert.deepEqual(await r.json(), { ok: false, fieldErrors: { host: 'unreachable' } });
  assert.deepEqual(await (await call(createValidateHandler(), {})).json(), { ok: true });
});

test('onMigrateConfig: values in, values out', async () => {
  const r = await call(createMigrateConfigHandler(({ values }) => ({ values: { ...values, renamed: values.old } })), { fromVersion: 1, toVersion: 2, values: { old: 'x' } });
  assert.deepEqual(await r.json(), { values: { old: 'x', renamed: 'x' } });
  assert.equal((await call(createMigrateConfigHandler(() => ({ values: {} })), { values: {} })).status, 400);
});
