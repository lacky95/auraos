// The lifecycle token, app side (Phase 3b F0a): one pre-handler check per
// runtime — the Astro `identity-middleware` the integration injects,
// `runtime/next`, and `sidecars.createServer`. For every lifecycle route: no
// token or a wrong one → 401 and NO side effect (the handler never runs,
// state is unchanged); the right token → today's behaviour. Health without a
// token still answers; health with a wrong one is refused.
//
// The Astro matrix runs the injected health route, the SDK factories every
// app uses, and the REAL hand-written `onSaveState.ts` (the aura-cli template,
// byte-identical to the Excalidraw and TerminalX files), behind the real
// middleware.
//
//   pnpm --filter @aura/app-sdk test
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { lifecycleRequestRefused, LIFECYCLE_TOKEN_HEADER } from '../dist/runtime/lifecycle-guard.js';
import { onRequest } from '../dist/runtime/identity-middleware.js';
import { GET as injectedHealth } from '../dist/runtime/health-route.js';
import {
  createActivityCreateHandler, createActivityDestroyHandler, createIntentHandler, createLifecycleHandler, createSaveStateHandler,
} from '../dist/lifecycle.js';
import { createNextHealthRoute, createNextLifecycleRoutes } from '../dist/runtime/next.js';
import { createSidecars } from '../dist/sidecars.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_SAVE_STATE = join(HERE, '../../aura-cli/src/templates/app/src/pages/api/lifecycle/onSaveState.ts');
const TOKEN = 'the-right-token-0123456789';
const ENV = ['AURA_LIFECYCLE_TOKEN', 'APP_ID', 'APP_INSTANCE_ID'];
let saved;
beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  process.env.AURA_LIFECYCLE_TOKEN = TOKEN;
  process.env.APP_ID = 'com.test.app';
  process.env.APP_INSTANCE_ID = 'com.test.app-1';
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const TOKENS = { none: undefined, wrong: 'wrong-token', valid: TOKEN };

test('lifecycleRequestRefused: the shared rule', () => {
  const r = (path, tok) => lifecycleRequestRefused(path, tok);
  // Hooks need the right token.
  for (const p of ['/api/lifecycle/onDestroy', '/api/lifecycle/onActivityDestroy/a%231', '/api/lifecycle', '/api/lifecycle/onSaveState?x=1']) {
    assert.equal(r(p, undefined), true, p);
    assert.equal(r(p, 'wrong'), true, p);
    assert.equal(r(p, TOKEN), false, p);
  }
  // Encodings, case, slashes and dot segments can't dodge it.
  for (const p of ['/API/Lifecycle/onDestroy', '/api/lifecycle/%6FnDestroy', '//api//lifecycle/onDestroy/', '/x/../api/lifecycle/onDestroy', '/api/%6cifecycle/onStop', '/api/lifecycle/%E0%A4%A']) {
    assert.equal(r(p, undefined), true, p);
  }
  assert.equal(r('/api/lifecycle/onStop', [TOKEN, TOKEN]), true, 'a repeated header is not a token');
  assert.equal(r('/api/lifecycle/onStop', ''), true);
  // Health: no token answers, a wrong one is refused.
  assert.equal(r('/api/lifecycle/health', undefined), false);
  assert.equal(r('/api/lifecycle/health/', undefined), false);
  assert.equal(r('/api/lifecycle/health', 'wrong'), true);
  assert.equal(r('/api/lifecycle/health', TOKEN), false);
  // Everything else is not the guard's business.
  for (const p of ['/', '/api/lifecyclex', '/api/other', '/lifecycle/onStop', '/%E0%A4%A']) assert.equal(r(p, undefined), false, p);
  // Without AURA_LIFECYCLE_TOKEN (older OS, app started by hand) nothing to check.
  assert.equal(lifecycleRequestRefused('/api/lifecycle/onDestroy', undefined, ''), false);
});

// ── Astro: the middleware in front of real routes ───────────────────────────

/** A route table like Astro's: path → handler, each call recorded. */
async function astroApp() {
  const calls = [];
  const state = { created: [], destroyed: [], hooks: [], intents: [], saved: [] };
  const plain = Object.fromEntries(['onCreate', 'onStart', 'onResume', 'onPause', 'onStop', 'onDestroy'].map((h) => [
    `/api/lifecycle/${h}`, createLifecycleHandler(h, (ctx) => { state.hooks.push([h, ctx.reason]); }),
  ]));
  const { POST: templateSaveState } = await import(pathToFileURL(TEMPLATE_SAVE_STATE).href);
  const routes = {
    'GET /api/lifecycle/health': injectedHealth,
    ...Object.fromEntries(Object.entries(plain).map(([p, h]) => [`POST ${p}`, h])),
    'POST /api/lifecycle/onActivityCreate': createActivityCreateHandler(({ activityId }) => { state.created.push(activityId); return { path: '/' }; }),
    'POST /api/lifecycle/onActivityDestroy/a1': createActivityDestroyHandler((id) => { state.destroyed.push(id); }),
    'POST /api/lifecycle/onIntent': createIntentHandler(({ intent }) => { state.intents.push(intent.action); }),
    'POST /api/lifecycle/onSaveState': createSaveStateHandler(({ activityIds }) => { state.saved.push(...activityIds); return { states: {} }; }),
    'POST /api/lifecycle/onSaveState-template': templateSaveState,
  };
  async function request(method, path, token, body, headers = {}) {
    const url = new URL(`http://app.test${path === '/api/lifecycle/onSaveState-template' ? '/api/lifecycle/onSaveState' : path}`);
    const request = new Request(url, {
      method,
      headers: { 'content-type': 'application/json', ...(token !== undefined ? { [LIFECYCLE_TOKEN_HEADER]: token } : {}), ...headers },
      ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
    });
    const handler = routes[`${method} ${path}`];
    const params = { activityId: 'a1' };
    const res = await onRequest({ url, request }, async () => { calls.push(path); return handler({ request, params }); });
    return { status: res.status, body: await res.json(), headers: res.headers };
  }
  return { request, calls, state, routes };
}

const ASTRO_ROUTES = [
  ['GET', '/api/lifecycle/health'],
  ...['onCreate', 'onStart', 'onResume', 'onPause', 'onStop', 'onDestroy'].map((h) => ['POST', `/api/lifecycle/${h}`]),
  ['POST', '/api/lifecycle/onActivityCreate', { activityId: 'a1' }],
  ['POST', '/api/lifecycle/onActivityDestroy/a1'],
  ['POST', '/api/lifecycle/onIntent', { intent: { action: 'aura.intent.action.VIEW' } }],
  ['POST', '/api/lifecycle/onSaveState', { activityIds: ['a1'] }],
  ['POST', '/api/lifecycle/onSaveState-template', { activityIds: ['a1'] }],
];

test('Astro middleware: every lifecycle route — no/wrong token → 401 before the handler; valid → today', async () => {
  const app = await astroApp();
  const snapshot = () => JSON.stringify(app.state);
  const before = snapshot();
  for (const [method, path, body] of ASTRO_ROUTES) {
    for (const kind of ['none', 'wrong']) {
      if (path.endsWith('/health') && kind === 'none') continue;   // below
      const res = await app.request(method, path, TOKENS[kind], body);
      assert.equal(res.status, 401, `${path} ${kind}`);
      assert.equal(res.body.error, 'lifecycle-token-required');
      assert.equal(res.headers.get('x-aura-app-id'), 'com.test.app', 'the 401 still says who answered');
    }
  }
  assert.deepEqual(app.calls, [], 'no handler ran');
  assert.equal(snapshot(), before, 'no state changed');

  for (const [method, path, body] of ASTRO_ROUTES) {
    const res = await app.request(method, path, TOKEN, body);
    assert.equal(res.status, 200, path);
    assert.equal(res.body.ok, true, path);
  }
  assert.equal(app.calls.length, ASTRO_ROUTES.length);
  assert.deepEqual(app.state.created, ['a1']);
  assert.deepEqual(app.state.destroyed, ['a1']);
  assert.deepEqual(app.state.intents, ['aura.intent.action.VIEW']);
  assert.deepEqual(app.state.saved, ['a1']);
  assert.equal(app.state.hooks.length, 6);

  // Health: no token answers with the identity body; the stop reason still arrives.
  const h = await app.request('GET', '/api/lifecycle/health', undefined);
  assert.deepEqual([h.status, h.body], [200, { ok: true, appId: 'com.test.app', instanceId: 'com.test.app-1' }]);
  await app.request('POST', '/api/lifecycle/onStop', TOKEN, {}, { 'x-aura-stop-reason': 'restart' });
  assert.deepEqual(app.state.hooks.at(-1), ['onStop', 'restart']);
});

test('Astro middleware: a hook path in disguise is still refused; other paths pass and get identity', async () => {
  for (const path of ['/API/Lifecycle/onDestroy', '/api/lifecycle/%6FnDestroy', '/api/lifecycle/onDestroy/']) {
    const url = new URL(`http://app.test${path}`);
    let ran = false;
    const res = await onRequest({ url, request: new Request(url, { method: 'POST' }) }, async () => { ran = true; return new Response('x'); });
    assert.equal(res.status, 401, path);
    assert.equal(ran, false);
  }
  const url = new URL('http://app.test/');
  const res = await onRequest({ url, request: new Request(url) }, async () => new Response('page'));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-aura-instance-id'), 'com.test.app-1');
});

// ── runtime/next ────────────────────────────────────────────────────────────

test('runtime/next: every hook — no/wrong token → 401 before the impl; valid → today, with stop reason and onSaveState', async () => {
  const seen = [];
  const hook = (h) => (ctx) => { seen.push([h, ctx?.reason ?? null]); };
  const { POST } = createNextLifecycleRoutes({
    onCreate: hook('onCreate'), onStart: hook('onStart'), onResume: hook('onResume'),
    onPause: hook('onPause'), onStop: hook('onStop'), onDestroy: hook('onDestroy'),
    onActivityCreate: ({ activityId }) => { seen.push(['onActivityCreate', activityId]); return { path: '/x' }; },
    onActivityDestroy: (id) => { seen.push(['onActivityDestroy', id]); },
    onIntent: ({ intent }) => { seen.push(['onIntent', intent.action]); },
    onSaveState: ({ activityIds }) => { seen.push(['onSaveState', ...activityIds]); return { states: { a1: { n: 1 } } }; },
  });
  const { GET } = createNextHealthRoute();
  const call = (segments, token, body, headers = {}) => POST(new Request(`http://app.test/api/lifecycle/${segments.join('/')}`, {
    method: 'POST',
    headers: { ...(token !== undefined ? { [LIFECYCLE_TOKEN_HEADER]: token } : {}), ...headers },
    body: JSON.stringify(body ?? {}),
  }), { params: Promise.resolve({ hook: segments }) });
  const routes = [
    ...['onCreate', 'onStart', 'onResume', 'onPause', 'onStop', 'onDestroy'].map((h) => [[h]]),
    [['onActivityCreate'], { activityId: 'a1' }],
    [['onActivityDestroy', 'a1']],
    [['onIntent'], { intent: { action: 'aura.intent.action.VIEW' } }],
    [['onSaveState'], { activityIds: ['a1'] }],
  ];
  for (const [segments, body] of routes) {
    for (const kind of ['none', 'wrong']) {
      const res = await call(segments, TOKENS[kind], body);
      assert.equal(res.status, 401, `${segments.join('/')} ${kind}`);
    }
  }
  assert.deepEqual(seen, [], 'no impl ran');
  for (const [segments, body] of routes) {
    const res = await call(segments, TOKEN, body);
    assert.equal(res.status, 200, segments.join('/'));
  }
  assert.equal(seen.length, routes.length);
  const saved = await (await call(['onSaveState'], TOKEN, { activityIds: ['a1'] })).json();
  assert.deepEqual(saved, { ok: true, states: { a1: { n: 1 } } });
  await call(['onStop'], TOKEN, {}, { 'x-aura-stop-reason': 'user' });
  assert.deepEqual(seen.at(-1), ['onStop', 'user'], 'runtime/next passes the stop reason');

  const health = (token) => GET(new Request('http://app.test/api/lifecycle/health', { headers: token ? { [LIFECYCLE_TOKEN_HEADER]: token } : {} }));
  assert.equal((await health()).status, 200);
  assert.equal((await health('wrong')).status, 401);
  assert.deepEqual(await (await health(TOKEN)).json(), { ok: true, appId: 'com.test.app', instanceId: 'com.test.app-1' });
});

// ── sidecars.createServer ───────────────────────────────────────────────────

test('sidecars.createServer: no/wrong token → 401 and no teardown/boot; valid → today', async (t) => {
  const host = createSidecars({ appId: 'com.test.app', instanceId: 'com.test.app-1', appPort: 0, services: [] });
  const effects = [];
  host.ensureAll = async () => { effects.push('ensureAll'); };
  host.teardownAll = async () => { effects.push('teardownAll'); };
  const server = host.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, path, token) => fetch(`${base}${path}`, { method, headers: token !== undefined ? { [LIFECYCLE_TOKEN_HEADER]: token } : {} });
  const hooks = ['onCreate', 'onStart', 'onResume', 'onPause', 'onStop', 'onDestroy'];
  for (const h of hooks) {
    for (const kind of ['none', 'wrong']) {
      const res = await call('POST', `/api/lifecycle/${h}`, TOKENS[kind]);
      assert.equal(res.status, 401, `${h} ${kind}`);
      assert.equal(res.headers.get('x-aura-app-id'), 'com.test.app');
    }
  }
  // Hooks the controller does not serve (activity hooks) are refused too, not forwarded.
  assert.equal((await call('POST', '/api/lifecycle/onActivityCreate')).status, 401);
  assert.equal((await call('GET', '/api/lifecycle/health', 'wrong')).status, 401);
  assert.deepEqual(effects, [], 'nothing booted or torn down');

  for (const h of hooks) assert.equal((await call('POST', `/api/lifecycle/${h}`, TOKEN)).status, 200, h);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(effects.sort(), ['ensureAll', 'teardownAll']);
  const health = await call('GET', '/api/lifecycle/health');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).instanceId, 'com.test.app-1');
});
