// D102 in the SDK: a request the owner put on hold, the owner's denial
// feedback, cancelled requests, and withdrawing one's own request.
//
//   pnpm --filter @aura/app-sdk test
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { ApprovalsApi } from '../dist/approvals.js';
import { CredentialsApi } from '../dist/credentials.js';

const KEYS = ['OS_API_BASE', 'AURA_OS_URL', 'AURA_INSTANCE_TOKEN', 'APP_ID', 'AURA_APP_ID', 'APP_INSTANCE_ID', 'AURA_INSTANCE_ID'];
let saved;
let realFetch;
let calls;
function serve(handler) {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body });
    const [status, body] = handler(String(url), init);
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  };
}
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  realFetch = globalThis.fetch;
  process.env.OS_API_BASE = 'http://aura-shell:3000';
  process.env.AURA_INSTANCE_TOKEN = 'aura1.tok';
  process.env.APP_ID = 'com.ex.notes';
  process.env.APP_INSTANCE_ID = 'com.ex.notes-1';
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

test('returnOnHold: a held request answers on_hold at once, with its deadline; it authorizes nothing', async () => {
  const until = Date.now() + 86_400_000;
  serve(() => [200, { id: 'apr_h', state: 'pending', heldAt: Date.now(), expiresAt: until }]);
  const r = await new ApprovalsApi().wait('apr_h', { returnOnHold: true, pollMs: 250 });
  assert.deepEqual(r, { approved: false, outcome: 'on_hold', approvalId: 'apr_h', heldUntil: until });
});

test('without returnOnHold a held request keeps waiting until decided (old callers never see on_hold)', async () => {
  let polls = 0;
  serve(() => { polls += 1; return [200, { id: 'apr_h', state: polls < 2 ? 'pending' : 'approved', heldAt: 1, expiresAt: Date.now() + 86_400_000 }]; });
  const r = await new ApprovalsApi().wait('apr_h', { pollMs: 250 });
  assert.equal(r.outcome, 'approved');
});

test('a denial carries the owner\'s feedback; cancelled is its own outcome', async () => {
  serve(() => [200, { id: 'apr_d', state: 'denied', feedback: 'Not on the prod board.', expiresAt: Date.now() }]);
  assert.deepEqual(await new ApprovalsApi().wait('apr_d'), { approved: false, outcome: 'denied', approvalId: 'apr_d', feedback: 'Not on the prod board.' });
  serve(() => [200, { id: 'apr_c', state: 'cancelled', expiresAt: Date.now() }]);
  assert.equal((await new ApprovalsApi().wait('apr_c')).outcome, 'cancelled');
});

test('cancel: POST …/cancel with the instance token', async () => {
  serve(() => [200, { ok: true, state: 'cancelled' }]);
  assert.equal(await new ApprovalsApi().cancel('apr_x'), true);
  assert.equal(calls[0].url, 'http://aura-shell:3000/api/approvals/apr_x/cancel');
  assert.equal(calls[0].method, 'POST');
});

test('credentials.request: on hold returns the request id to resume; a denial the feedback', async () => {
  serve((url, init) => {
    if (url.endsWith('/api/credentials/requests') && init.method === 'POST') return [201, { id: 'apr_k', state: 'pending', expiresAt: Date.now() + 60_000 }];
    return [200, { id: 'apr_k', state: 'pending', heldAt: 1, expiresAt: 99 }];
  });
  const held = await new CredentialsApi().request({ name: 'GITHUB_TOKEN' }, { returnOnHold: true });
  assert.deepEqual(held, { ok: false, outcome: 'on_hold', approvalId: 'apr_k', heldUntil: 99 });
  assert.ok(!calls.some((c) => c.url.endsWith('/api/credentials/requests/apr_k')), 'nothing collected');
  serve((url, init) => {
    if (url.endsWith('/api/credentials/requests') && init.method === 'POST') return [201, { id: 'apr_k', state: 'pending', expiresAt: Date.now() + 60_000 }];
    return [200, { id: 'apr_k', state: 'denied', feedback: 'Use a fine-grained token.' }];
  });
  const no = await new CredentialsApi().request({ name: 'GITHUB_TOKEN' });
  assert.deepEqual(no, { ok: false, outcome: 'denied', approvalId: 'apr_k', feedback: 'Use a fine-grained token.' });
});
