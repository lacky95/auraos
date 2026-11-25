// The app contract in the SDK (D48) and the de-duplication (Phase 3b C):
// one error type, one instance-id resolver, the token on every server call,
// shared lifecycle handlers, context.get, approvals, permissions, aliases.
//
//   pnpm --filter @aura/app-sdk test
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { OsClient } from '../dist/OsClient.js';
import { StorageError } from '../dist/storage.js';
import { UserError, UserConfirmError } from '../dist/user.js';
import { NotificationsError } from '../dist/notifications.js';
import { IntentRejectedError } from '../dist/intent.js';
import { AURA_CONTRACT } from '../dist/contract.js';
import { PermissionsApi } from '../dist/permissions.js';
import { ApprovalsApi, approvalHeader } from '../dist/approvals.js';
import { createHealthEndpoint } from '../dist/lifecycle.js';
import { OsError } from '../dist/errors.js';
import { OsSidecarError } from '../dist/os-sidecars.js';
import { ownAppId, ownInstanceId, identityResponseHeaders, getAppContext } from '../dist/context.js';
import { createNextLifecycleRoutes, createNextHealthRoute, auraIdentityHeaders } from '../dist/runtime/next.js';
import { AURA_CONTRACT as CORE_CONTRACT } from '@aura/core';

const KEYS = ['OS_API_BASE', 'AURA_OS_URL', 'AURA_INSTANCE_TOKEN', 'APP_ID', 'AURA_APP_ID', 'APP_INSTANCE_ID', 'AURA_INSTANCE_ID', 'AURA_LIFECYCLE_TOKEN'];
let saved;
let realFetch;
let calls;
function serve(handler) {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body });
    const [status, body] = handler(String(url), init);
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  };
}
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  realFetch = globalThis.fetch;
});
afterEach(() => {
  delete globalThis.window;
  globalThis.fetch = realFetch;
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});
const server = () => {
  process.env.OS_API_BASE = 'http://aura-shell:3000';
  process.env.AURA_INSTANCE_TOKEN = 'aura1.tok';
  process.env.APP_ID = 'com.ex.notes';
  process.env.APP_INSTANCE_ID = 'com.ex.notes-2';
};

test('auraContract: the SDK and core implement the same version', () => {
  assert.equal(AURA_CONTRACT, 1);
  assert.equal(AURA_CONTRACT, CORE_CONTRACT);
});

test('OsError: one type, the old classes are subclasses so instanceof keeps working', () => {
  const cases = [
    new StorageError(403, 'forbidden'),
    new UserError(401, 'login-required'),
    new UserConfirmError('invalid-payload', 'bad'),
    new NotificationsError(403, 'notifications: no', undefined, 'forbidden'),
    new OsSidecarError(403, "not granted 'sidecars.spawn'"),
    new IntentRejectedError('bad-extra', 'no', { status: 400 }),
  ];
  for (const e of cases) {
    assert.ok(e instanceof OsError, e.name);
    assert.ok(e instanceof Error, e.name);
    assert.equal(typeof e.status, 'number');
    assert.equal(typeof e.code, 'string');
  }
  assert.equal(cases[0].name, 'StorageError');
  assert.equal(cases[3].code, 'forbidden');
  assert.equal(new NotificationsError(500, 'x').code, 'http-500');
  assert.equal(cases[4].permission, 'sidecars.spawn');
  assert.equal(cases[5].status, 400);
  assert.equal(new IntentRejectedError('x', 'y').status, 422);
});

test('one instance-id resolver: env on a server, sidecar env, the bootstrap in a page', () => {
  assert.equal(ownInstanceId(), null);
  assert.equal(ownAppId(), null);
  process.env.AURA_APP_ID = 'com.ex.side';
  process.env.AURA_INSTANCE_ID = 'com.ex.side-1';
  assert.equal(ownInstanceId(), 'com.ex.side-1');
  process.env.APP_ID = 'com.ex.notes';
  process.env.APP_INSTANCE_ID = 'com.ex.notes-2';
  assert.equal(ownInstanceId(), 'com.ex.notes-2');
  assert.equal(ownAppId(), 'com.ex.notes');
  assert.equal(getAppContext().instanceId, 'com.ex.notes-2');
  assert.deepEqual(identityResponseHeaders(), { 'X-Aura-App-Id': 'com.ex.notes', 'X-Aura-Instance-Id': 'com.ex.notes-2' });
  assert.deepEqual(auraIdentityHeaders(), identityResponseHeaders());
});

test('every server-side call sends the instance token; none sends a self-set id header', async () => {
  server();
  serve((url) => {
    if (url.includes('/api/kv/os/theme')) return [200, { value: { themeIdDark: 'd', themeIdLight: 'l', colorMode: 'dark' } }];
    if (url.includes('/api/os/themes')) return [200, { themes: [] }];
    if (url.includes('/status')) return [200, { instance: { state: 'resumed' } }];
    if (url.includes('/api/intents/start')) return [200, { kind: 'noHandler' }];
    if (url.includes('/api/interfaces')) return [200, { interfaces: [], consumers: [] }];
    if (url.includes('/api/activities/')) return [200, { ok: true }];
    return [200, { ok: true }];
  });
  const c = new OsClient();
  await c.theme.getSelection();
  await c.theme.list();
  await c.getState();
  await c.intents.start({ action: 'x' });
  await c.data.query('com.ex.p', 'items');
  await c.data.write('com.ex.p', 'items', { a: 1 });
  await c.interfaces.list();
  await c.interfaces.consumers();
  await c.activity.saveState({ a: 1 }, 'act-1');
  await c.activity.savedState('act-1');
  await c.flight.get('act-1').refresh().catch(() => null);
  assert.ok(calls.length >= 10);
  for (const call of calls) {
    assert.equal(call.headers.Authorization, 'Bearer aura1.tok', call.url);
    for (const h of Object.keys(call.headers)) assert.ok(!/^x-aura-(app|instance)-id$/i.test(h), `${call.url} ${h}`);
    assert.ok(call.url.startsWith('http://aura-shell:3000/'), call.url);
  }
  assert.ok(calls.some((x) => x.url.endsWith('/api/instances/com.ex.notes-2/status')));
});

test('a page never sends the token', async () => {
  process.env.AURA_INSTANCE_TOKEN = 'aura1.tok';
  globalThis.window = {
    location: { origin: 'https://notes.app.test' },
    AuraRuntimeBootstrap: { channelVersion: 1, gatewayBase: '/_aura/os/', appOrigin: 'https://notes.app.test', shellOrigin: 'https://desk.test', appId: 'com.ex.notes', instanceId: 'com.ex.notes-1' },
    addEventListener() {}, removeEventListener() {},
  };
  serve(() => [200, { permissions: { 'sidecars.spawn': true } }]);
  assert.equal(await new PermissionsApi().has('sidecars.spawn'), true);
  assert.equal(calls[0].url, '/_aura/os/api/user/me/permissions?p=sidecars.spawn');
  assert.equal(calls[0].headers.Authorization, undefined);
  assert.equal(ownInstanceId(), 'com.ex.notes-1');
});

test('flat OsClient methods are deprecated aliases of the namespaces', async () => {
  server();
  serve(() => [200, { value: { themeIdDark: 'd', themeIdLight: 'l', colorMode: 'auto' }, themes: [], kind: 'noHandler' }]);
  const c = new OsClient();
  assert.deepEqual(await c.getThemeSelection(), await c.theme.getSelection());
  assert.equal(await c.getModePreference(), 'auto');
  assert.deepEqual(await c.listThemes(), []);
  assert.deepEqual(await c.startIntent({ action: 'x' }), await c.intents.start({ action: 'x' }));
  assert.equal(c.getActiveThemeId(), null);
  assert.equal(c.getThemeStrategy(), 'inherit');
  serve(() => [404, { error: 'nope' }]);
  await assert.rejects(c.queryProvider('com.ex.p', 'x'), (e) => e instanceof OsError && e.status === 404 && /queryProvider com.ex.p\/x/.test(e.message));
});

test('context.get: server only, declared keys through the token, null when not set', async () => {
  server();
  serve((url) => {
    if (url.endsWith('/OPENAI_API_KEY')) return [200, { key: 'OPENAI_API_KEY', value: 'sk-1' }];
    if (url.endsWith('/UNSET_KEY')) return [404, { error: 'not-set' }];
    return [403, { error: 'context-undeclared', message: 'declare it in context[]' }];
  });
  const ctx = new OsClient().context;
  assert.equal(await ctx.get('OPENAI_API_KEY'), 'sk-1');
  assert.equal(calls[0].url, 'http://aura-shell:3000/api/os/context/OPENAI_API_KEY');
  assert.equal(calls[0].headers.Authorization, 'Bearer aura1.tok');
  assert.equal(await ctx.get('UNSET_KEY'), null);
  await assert.rejects(ctx.get('OTHER'), (e) => e instanceof OsError && e.status === 403 && e.code === 'context-undeclared');
  await assert.rejects(ctx.get('lower'), (e) => e instanceof OsError && e.code === 'invalid-key');
  globalThis.window = { location: { origin: 'https://x' } };
  await assert.rejects(ctx.get('OPENAI_API_KEY'), (e) => e instanceof OsError && e.code === 'server-only');
});

test('permissions.check: one call, absent answers are false, errors are OsError', async () => {
  server();
  serve(() => [200, { permissions: { a: true, b: false } }]);
  const p = new PermissionsApi();
  assert.deepEqual(await p.check(['a', 'b', 'c', 'a']), { a: true, b: false, c: false });
  assert.equal(calls[0].url, 'http://aura-shell:3000/api/user/me/permissions?p=a&p=b&p=c');
  assert.deepEqual(await p.check([]), {});
  serve(() => [401, { error: 'login-required' }]);
  await assert.rejects(p.has('a'), (e) => e instanceof OsError && e.status === 401 && e.code === 'login-required');
});

test('approvals.request on a server: create, then poll until the owner decides', async () => {
  server();
  let polls = 0;
  serve((url, init) => {
    if (url.endsWith('/api/approvals') && init.method === 'POST') return [201, { id: 'apr_x', state: 'pending', expiresAt: Date.now() + 60_000 }];
    if (url.endsWith('/api/approvals/apr_x')) { polls += 1; return [200, { id: 'apr_x', action: 'user.confirm', level: 'session', state: polls < 2 ? 'pending' : 'approved', expiresAt: Date.now() + 60_000 }]; }
    return [404, { error: 'not-found' }];
  });
  const r = await new ApprovalsApi().request({ action: 'user.confirm', payload: { action: 'wipe' }, reason: 'Wipes the board' }, { pollMs: 250 });
  assert.deepEqual(r, { approved: true, outcome: 'approved', approvalId: 'apr_x' });
  assert.deepEqual(JSON.parse(calls[0].body), { action: 'user.confirm', payload: { action: 'wipe' }, reason: 'Wipes the board' });
  assert.ok(calls.every((c) => c.headers.Authorization === 'Bearer aura1.tok'));
  assert.deepEqual(approvalHeader('apr_x'), { 'X-Aura-Approval': 'apr_x' });
});

test('approvals: an existing id, denied, blocked, busy and unknown are a "no"; a bad request throws', async () => {
  server();
  serve((url) => (url.endsWith('/apr_d') ? [200, { id: 'apr_d', state: 'denied', expiresAt: Date.now() + 1000 }] : [404, { error: 'not-found' }]));
  const a = new ApprovalsApi();
  assert.deepEqual(await a.request({ approvalId: 'apr_d' }), { approved: false, outcome: 'denied', approvalId: 'apr_d' });
  assert.deepEqual(await a.request({ approvalId: 'apr_gone' }), { approved: false, outcome: 'unavailable', approvalId: 'apr_gone' });
  serve(() => [403, { error: 'blocked' }]);
  assert.deepEqual(await a.request({ action: 'user.confirm', payload: { action: 'x' } }), { approved: false, outcome: 'blocked' });
  serve(() => [429, { error: 'pending-limit' }]);
  assert.deepEqual(await a.request({ action: 'user.confirm', payload: { action: 'x' } }), { approved: false, outcome: 'busy' });
  serve(() => [400, { error: 'invalid-action' }]);
  await assert.rejects(a.request({ action: 'nope' }), (e) => e instanceof OsError && e.code === 'invalid-action');
});

test('approvals in a page: the Shell shows the dialog and answers once', async () => {
  const listeners = [];
  const posted = [];
  globalThis.window = {
    location: { origin: 'https://notes.app.test' },
    AuraRuntimeBootstrap: { channelVersion: 1, gatewayBase: '/_aura/os/', appOrigin: 'https://notes.app.test', shellOrigin: 'https://desk.test', appId: 'com.ex.notes' },
    parent: { postMessage: (m, o) => posted.push([m, o]) },
    addEventListener: (t, f) => listeners.push(f),
    removeEventListener() {},
  };
  globalThis.window.top = globalThis.window.parent;
  const p = new ApprovalsApi().wait('apr_p');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(posted.length, 1);
  const [msg] = posted[0];
  assert.equal(msg.type, 'aura.approval.request');
  assert.equal(msg.approvalId, 'apr_p');
  for (const f of listeners) f({ origin: 'https://desk.test', source: globalThis.window.parent, data: { type: 'aura.approval.result', requestId: msg.requestId, approvalId: 'apr_p', ok: true } });
  assert.deepEqual(await p, { approved: true, outcome: 'approved', approvalId: 'apr_p' });
});

test('runtime/next shares the lifecycle handlers: user, restore, rejection, onAssign', async () => {
  process.env.APP_ID = 'com.ex.next';
  process.env.APP_INSTANCE_ID = 'com.ex.next-1';
  const seen = [];
  const { POST } = createNextLifecycleRoutes({
    onActivityCreate: (req) => { seen.push(req); if (req.data?.bad) throw new IntentRejectedError('bad', 'bad extra', { hint: 'h' }); return { path: '/x' }; },
    onAssign: (req) => { seen.push(req); },
    onIntent: () => ({ result: { n: 1 } }),
  });
  const post = (hook, body) => POST(new Request(`http://app/api/lifecycle/${hook}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }), { params: Promise.resolve({ hook: hook.split('/') }) });
  let res = await post('onActivityCreate', { activityId: 'a1', userId: 'u1', restore: { previousActivityId: 'a0', state: { s: 1 } } });
  assert.deepEqual(await res.json(), { ok: true, path: '/x' });
  assert.deepEqual(seen[0], { activityId: 'a1', userId: 'u1', restore: { previousActivityId: 'a0', state: { s: 1 } } });
  res = await post('onActivityCreate', { activityId: 'a2', data: { bad: true } });
  assert.deepEqual(await res.json(), { ok: false, rejected: { code: 'bad', message: 'bad extra', hint: 'h', status: 422 } });
  res = await post('onAssign', { userId: 'u9' });
  assert.equal(res.status, 200);
  assert.deepEqual(seen.at(-1), { userId: 'u9' });
  res = await post('onIntent', { intent: { action: 'a' } });
  assert.deepEqual(await res.json(), { ok: true, result: { n: 1 } });
  res = await post('onSaveState', { activityIds: [] });
  assert.equal(res.status, 404, 'an optional hook without an impl is "not implemented"');
  res = await createNextLifecycleRoutes({}).POST(new Request('http://app/api/lifecycle/onAssign', { method: 'POST', body: '{}' }), { params: Promise.resolve({ hook: ['onAssign'] }) });
  assert.equal(res.status, 404);
  const health = await createNextHealthRoute().GET(new Request('http://app/api/lifecycle/health'));
  assert.deepEqual(await health.json(), { ok: true, appId: 'com.ex.next', instanceId: 'com.ex.next-1' });
  const astroHealth = await createHealthEndpoint()({});
  assert.deepEqual(await astroHealth.json(), await (await createNextHealthRoute().GET(new Request('http://app/api/lifecycle/health'))).json());
});
