// OsError / osErrorFrom: the SDK's one decoder of AuraOS's error body
// (error-messages review Pass A). The code stays `error`; the facts of a
// refusal (reason, category, hint, permission, holder, …) become fields, and
// the message carries the fix. Older bodies decode exactly as before.
//
//   pnpm --filter @aura/app-sdk test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OsError, osErrorFrom } from '../dist/errors.js';
import { IntentRejectedError } from '../dist/intent.js';
import { OsSidecarError } from '../dist/os-sidecars.js';

const res = (status, body) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

test('a structured refusal keeps its code, reason, hint and facts; the message names the fix', async () => {
  const err = await osErrorFrom(res(403, {
    error: 'access-denied', reason: 'missing-permission', category: 'missing-declaration',
    message: "com.acme.notes does not declare 'apps.mount' in app.manifest.json permissions[].",
    hint: 'Add "apps.mount" to permissions[] in app.manifest.json.',
    permission: 'apps.mount', holder: 'caller', manifestField: 'permissions[]', details: { x: 1 },
  }), 'mount');
  assert.ok(err instanceof OsError);
  assert.equal(err.status, 403);
  assert.equal(err.code, 'access-denied');
  assert.equal(err.reason, 'missing-permission');
  assert.equal(err.category, 'missing-declaration');
  assert.equal(err.permission, 'apps.mount');
  assert.equal(err.holder, 'caller');
  assert.equal(err.manifestField, 'permissions[]');
  assert.deepEqual(err.details, { x: 1 });
  assert.equal(err.message, `mount → 403 com.acme.notes does not declare 'apps.mount' in app.manifest.json permissions[]. — Add "apps.mount" to permissions[] in app.manifest.json.`);
});

test('older bodies decode as before: code-only, prose in error, plain text, nothing', async () => {
  const codeOnly = await osErrorFrom(res(403, { error: 'gateway-denied' }), 'kv');
  assert.equal(codeOnly.code, 'gateway-denied');
  assert.equal(codeOnly.message, 'kv → 403 gateway-denied');
  assert.equal(codeOnly.reason, undefined);
  assert.equal(codeOnly.hint, undefined);
  const prose = await osErrorFrom(res(500, { error: 'disk full' }), 'storage');
  assert.equal(prose.code, 'disk full');
  assert.equal(prose.message, 'storage → 500 disk full');
  const text = await osErrorFrom(res(502, 'Bad Gateway'), 'x');
  assert.equal(text.code, 'http-502');
  assert.equal(text.message, 'x → 502 Bad Gateway');
  const empty = await osErrorFrom(res(404, ''), 'x');
  assert.equal(empty.code, 'http-404');
  const array = await osErrorFrom(res(400, '[1,2]'), 'x');
  assert.equal(array.code, 'http-400');
  // Non-string facts are ignored, never copied.
  const odd = await osErrorFrom(res(403, { error: 'access-denied', hint: { evil: 1 }, permission: 7 }), 'x');
  assert.equal(odd.hint, undefined);
  assert.equal(odd.permission, undefined);
});

test('subclasses keep their fields: IntentRejectedError.hint, OsSidecarError.permission', () => {
  const rejected = new IntentRejectedError('bad-extra', 'no such note', { hint: 'pass a note id' });
  assert.equal(rejected.hint, 'pass a note id');
  assert.deepEqual(rejected.toReply(), { code: 'bad-extra', message: 'no such note', hint: 'pass a note id', status: 422 });
  assert.equal(new IntentRejectedError('x', 'y').toReply().hint, undefined);
  const sidecar = new OsSidecarError(403, "this app was not granted 'sidecars.tools'");
  assert.equal(sidecar.permission, 'sidecars.tools');
  assert.ok(sidecar instanceof OsError);
  assert.equal(new OsSidecarError(500, "needs 'x.y'").permission, undefined);
});
