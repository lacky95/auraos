// The App Host gateway: path rules, the signed identity, no `system` fallback,
// CSRF, credential stripping, and key injection from a non-shell parent.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import vm from 'node:vm';
import { OsEventBus } from '@aura/core';
import { GATEWAY_IDENTITY_HEADER } from '@aura/core/host-rules';
import type { GatewayIdentityClaim, ProxyConfig } from '@aura/core';
import {
  browserBoundaryError, gatewayShellPath, handleAppGateway, serveAppRuntime,
} from '../server/app-gateway.mjs';
import { gatewayClaimOf, signGatewayClaim, verifyGatewayClaim } from '../server/gateway-identity.mjs';
import { stripShellCredentials } from '../server/shell-credentials.mjs';
import { createDecide } from '../src/lib/access/decide.ts';
import { gatewayEventView, type GatewayEventView } from '../src/lib/access/gatewayEvents.ts';
import { enforceGateway } from '../src/lib/access/gatewayCaller.ts';
import type { ObserverManager } from '../src/lib/access/observer.ts';
import { buildAppRuntimeJs } from '../src/lib/appRuntime.ts';
import { authenticate, type AuthDeps } from '../src/lib/auth.ts';
import { GET as eventsRoute } from '../src/pages/api/apps/events.ts';

const ORIGIN = 'http://notesabcd1234--desk.example:3000';
const record = { appId: 'com.acme.notes', installationId: 'inst-1', instanceScope: { kind: 'user', userId: 'default' } };
const slot = { slot: 1, label: 'notesabcd1234', instanceId: 'com.acme.notes-1', assignedAt: 1 };
const session = { v: 1, aud: ORIGIN, label: slot.label, installationId: 'inst-1', userId: 'default', sid: 's1', iat: 1, exp: 9e9 };

const seen: http.IncomingMessage[] = [];
let shell: http.Server;
let gateway: http.Server;
let gatewayUrl = '';
let ctx: Record<string, unknown> = { record, slot, session };

before(async () => {
  shell = http.createServer((req, res) => {
    seen.push(req);
    req.resume();
    res.writeHead(200, {
      'content-type': 'application/json',
      'set-cookie': 'aura_session=planted; Path=/',
      'access-control-allow-origin': '*',
      location: 'http://127.0.0.1/elsewhere',
    });
    res.end('{"ok":true}');
  });
  await new Promise<void>((r) => shell.listen(0, '127.0.0.1', r));
  process.env.SHELL_PORT = String((shell.address() as AddressInfo).port);
  gateway = http.createServer((req, res) => {
    if (req.url === '/_aura/runtime.js') return void serveAppRuntime(req, res, ctx as never);
    handleAppGateway(req, res, ctx as never);
  });
  await new Promise<void>((r) => gateway.listen(0, '127.0.0.1', r));
  gatewayUrl = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
});
after(() => { shell.close(); gateway.close(); shell.closeAllConnections(); gateway.closeAllConnections(); });

function call(path: string, method = 'GET', headers: Record<string, string> = {}, body?: string) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const u = new URL(path, gatewayUrl);
    const req = http.request(u, { method, headers, agent: false }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const json = { origin: ORIGIN, 'content-type': 'application/json' };

// ── paths ───────────────────────────────────────────────────────────────────

test('only /_aura/os/api/ paths map to the shell, with no way out of them', () => {
  assert.equal(gatewayShellPath('/_aura/os/api/kv/os/theme?x=1'), '/api/kv/os/theme?x=1');
  for (const bad of [
    '/_aura/os/', '/_aura/os/admin', '/api/kv/x', '/_aura/os/api/../admin', '/_aura/os/api/%2e%2e/x',
    '/_aura/os/api/kv%2f..%2fadmin', '/_aura/os/api/kv%5cx', '/_aura/os/api//kv', '/_aura/os/api/a\\b',
    '/_aura/os/api/%00', '/_aura/os/api/%zz',
  ]) assert.equal(gatewayShellPath(bad), null, bad);
});

const liveInstances: Record<string, { appId: string; instanceId: string }> = {
  'com.acme.notes-1': { appId: 'com.acme.notes', instanceId: 'com.acme.notes-1' },
  'com.other.app-1': { appId: 'com.other.app', instanceId: 'com.other.app-1' },
};
const mgr = {
  tokens: { hasNonce: () => false, verify: () => null },
  getInstance: (id: string) => liveInstances[id],
  getInstancesByApp: () => [],
  getManifest: (id: string) => (id === 'com.acme.notes' || id === 'com.other.app' ? {} : undefined),
} as unknown as ObserverManager;
const decide = createDecide({ authorizer: { authorize: async () => ({ allow: false, reason: 'not granted' }) } });

function claim(method: string, path: string, over: Partial<GatewayIdentityClaim> = {}): GatewayIdentityClaim {
  const iat = Math.floor(Date.now() / 1000);
  return {
    v: 1, appId: record.appId, installationId: 'inst-1', instanceId: slot.instanceId, label: slot.label, slot: 1,
    origin: ORIGIN, userId: 'default', method, path, iat, exp: iat + 30, ...over,
  };
}
function apiCtx(method: string, path: string, routePattern: string, params: Record<string, string> = {}, token?: string) {
  const url = new URL(path, 'http://127.0.0.1:3000');
  const request = new Request(url, {
    method, headers: { [GATEWAY_IDENTITY_HEADER]: token ?? signGatewayClaim(claim(method, path)) },
  });
  return { request, url, routePattern, params };
}
const enforce = (c: ReturnType<typeof apiCtx>) => enforceGateway(c, { mgr, decide });

test('the route manifest decides: own data yes, another app or an owner route no', async () => {
  assert.equal(await enforce(apiCtx('GET', '/api/kv/app/com.acme.notes/k', '/api/kv/[...path]', { path: 'app/com.acme.notes/k' })), null);
  assert.equal(await enforce(apiCtx('GET', '/api/instances/com.acme.notes-1/sidecars', '/api/instances/[instanceId]/sidecars', { instanceId: 'com.acme.notes-1' })), null);
  for (const [path, route, params] of [
    ['/api/kv/app/com.other.app/k', '/api/kv/[...path]', { path: 'app/com.other.app/k' }],
    ['/api/instances/com.other.app-1/sidecars', '/api/instances/[instanceId]/sidecars', { instanceId: 'com.other.app-1' }],
    ['/api/os/context', '/api/os/context', {}],
    ['/api/admin/access-report', '/api/admin/access-report', {}],
    ['/api/proxy/com.other.app-1/x', '/api/proxy/[id]/[...path]', { id: 'com.other.app-1', path: 'x' }],
    ['/api/not-in-the-manifest', '/api/not-in-the-manifest', {}],
    ['/somewhere', '/somewhere', {}],
  ] as Array<[string, string, Record<string, string>]>) {
    const res = await enforce(apiCtx('GET', path, route, params));
    assert.equal(res?.status, 403, path);
  }
});

test('an app reaches its own Activity routes, never another instance\'s', async () => {
  const activities: Record<string, { appId: string; parentInstanceId: string }> = {
    'com.acme.notes-1#a1': { appId: 'com.acme.notes', parentInstanceId: 'com.acme.notes-1' },
    'com.other.app-1#a1': { appId: 'com.other.app', parentInstanceId: 'com.other.app-1' },
  };
  const withActivities = { ...mgr, getActivity: (id: string) => activities[id] } as unknown as ObserverManager;
  const state = (id: string, method = 'PUT') => enforceGateway(apiCtx(method, `/api/activities/${encodeURIComponent(id)}/state`,
    '/api/activities/[activityId]/state', { activityId: encodeURIComponent(id) }), { mgr: withActivities, decide });
  assert.equal(await state('com.acme.notes-1#a1'), null);
  assert.equal((await state('com.other.app-1#a1'))?.status, 403);
  assert.equal((await state('com.acme.notes-1#a9'))?.status, 403, 'an unknown activity');
});

test('a body-selected variant counts at its strictest', async () => {
  const strict = createDecide({
    authorizer: { authorize: async (_p, a) => ({ allow: a !== 'sidecars.tools', reason: 'test' }) },
  });
  const c = apiCtx('POST', '/api/instances/com.acme.notes-1/sidecars', '/api/instances/[instanceId]/sidecars', { instanceId: 'com.acme.notes-1' });
  assert.equal((await enforceGateway(c, { mgr, decide: strict }))?.status, 403);
});

// ── what an app may do through the gateway ──────────────────────────────────

const INTENTS = '/api/intents/start';
const TERMINAL = 'com.aura.terminal';
const TERMINAL_INSTANCE = 'com.aura.terminal-1';
const OPEN_TERMINAL = 'aura.intent.action.OPEN_TERMINAL';

/** The gateway's manager, with the Terminal installed in `scopeId`. */
const terminalMgr = (scopeId: string) => ({
  ...mgr,
  getInstance: (id: string) => (id === TERMINAL_INSTANCE ? { appId: TERMINAL, instanceId: id } : liveInstances[id]),
  getManifest: (id: string) => (id === TERMINAL ? { scopeId } : mgr.getManifest?.(id)),
}) as unknown as ObserverManager;

function intentCtx(body: string, appId = record.appId, instanceId = slot.instanceId) {
  const url = new URL(INTENTS, 'http://127.0.0.1:3000');
  const request = new Request(url, {
    method: 'POST',
    headers: {
      [GATEWAY_IDENTITY_HEADER]: signGatewayClaim(claim('POST', INTENTS, { appId, instanceId })),
      'content-type': 'application/json',
    },
    body,
  });
  return { request, url, routePattern: INTENTS, params: {} };
}
const sendIntent = (body: unknown, appId?: string, instanceId?: string, scopeId = 'system') =>
  enforceGateway(intentCtx(JSON.stringify(body), appId, instanceId), { mgr: terminalMgr(scopeId), decide });

test('intents: an app may send one, and the body is still there for the route', async () => {
  assert.equal(await sendIntent({ action: OPEN_TERMINAL, appId: TERMINAL, extras: { background: true } }), null);
  assert.equal(await sendIntent({ action: 'aura.intent.action.VIEW', uri: 'https://example.com' }), null);
  const c = intentCtx(JSON.stringify({ action: 'x' }));
  assert.equal(await enforceGateway(c, { mgr: terminalMgr('system'), decide }), null);
  assert.deepEqual(await c.request.json(), { action: 'x' });
});

test('intents: an ordinary app cannot carry the OPEN_TERMINAL command extra', async () => {
  for (const body of [
    { action: OPEN_TERMINAL, appId: TERMINAL, extras: { command: 'id' } },
    { action: OPEN_TERMINAL, extras: { background: true, command: 'id' } },
    { action: 'some.other.action', appId: TERMINAL, extras: { command: 'id' } },
    { action: OPEN_TERMINAL, extras: { command: null } },
  ]) {
    assert.equal((await sendIntent(body))?.status, 403, JSON.stringify(body));
  }
  const viaProto = '{"action":"' + OPEN_TERMINAL + '","extras":{"__proto__":{"command":"id"}}}';
  const res = await enforceGateway(intentCtx(viaProto), { mgr: terminalMgr('system'), decide });
  assert.equal(res?.status, 403, 'an inherited command is refused too');
  const lastKeyWins = '{"action":"' + OPEN_TERMINAL + '","extras":{"command":"id","background":true,"command":"ls"}}';
  assert.equal((await enforceGateway(intentCtx(lastKeyWins), { mgr: terminalMgr('system'), decide }))?.status, 403);
});

test('intents: only the system Terminal may carry a command', async () => {
  const body = { action: OPEN_TERMINAL, extras: { command: 'id' } };
  assert.equal(await sendIntent(body, TERMINAL, TERMINAL_INSTANCE), null);
  assert.equal((await sendIntent(body, TERMINAL, TERMINAL_INSTANCE, 'user'))?.status, 403, 'a same-id app in another scope');
});

test('intents: a malformed body reaches the route, an oversized one does not', async () => {
  assert.equal(await enforceGateway(intentCtx('{not json'), { mgr: terminalMgr('system'), decide }), null);
  const big = JSON.stringify({ action: 'x', pad: 'x'.repeat(1024 * 1024) });
  assert.equal((await enforceGateway(intentCtx(big), { mgr: terminalMgr('system'), decide }))?.status, 413);
});

test('intents: sending one opens no install or admin route', async () => {
  for (const [path, route, params] of [
    ['/api/nexus/install', '/api/nexus/install', {}],
    ['/api/admin/access-report', '/api/admin/access-report', {}],
  ] as Array<[string, string, Record<string, string>]>) {
    assert.equal((await enforce(apiCtx('POST', path, route, params)))?.status, 403, path);
  }
});

test('themes are readable by an app; the layout and keymap catalogues stay as they were', async () => {
  assert.equal(await enforce(apiCtx('GET', '/api/os/themes', '/api/os/themes')), null);
  for (const p of ['/api/os/layouts', '/api/os/keymap']) {
    assert.equal((await enforce(apiCtx('GET', p, p)))?.status, 403, p);
  }
});

const eventRequest = (token?: string) => new Request('http://127.0.0.1:3000/api/apps/events', {
  headers: token === undefined ? {} : { [GATEWAY_IDENTITY_HEADER]: token },
});
const eventToken = () => signGatewayClaim(claim('GET', '/api/apps/events'));

test('events: the view shows the theme, own app and readable KV, and nothing else', () => {
  const view = gatewayEventView(eventRequest(eventToken()), mgr as never) as GatewayEventView;
  const own = { appId: record.appId, instanceId: slot.instanceId, activityId: 'a', parentInstanceId: slot.instanceId };
  const other = { ...own, appId: 'com.other.app' };
  for (const [type, ev] of [
    ['theme:changed', { themeId: 't' }],
    ['mode:changed', { themeId: 't' }],
    ['app:stateChanged', own],
    ['activity:flightChanged', own],
    ['kv:changed', { namespace: 'os', key: 'theme', value: 1 }],
    ['kv:changed', { namespace: `app/${record.appId}`, key: 'k', value: 1 }],
  ] as Array<[string, unknown]>) {
    assert.equal(view.allows(type, ev), true, type);
  }
  for (const [type, ev] of [
    ['kv:changed', { namespace: 'app/com.other.app', key: 'k', value: 'private' }],
    ['kv:changed', { namespace: 'context', key: 'k', value: 'private' }],
    ['kv:changed', { key: 'k', value: 'private' }],
    ['app:stateChanged', other],
    ['activity:navigated', other],
    ['ui:command', { id: '1', action: 'x', appId: record.appId }],
    ['workspaces:changed', { workspaces: [], activeWorkspaceId: 'w' }],
    ['app:installed', { appId: record.appId }],
    ['some:future-event', own],
  ] as Array<[string, unknown]>) {
    assert.equal(view.allows(type, ev), false, `${type} ${JSON.stringify(ev)}`);
  }
});

test('events: no claim means the unfiltered stream, a bad claim is invalid', () => {
  assert.equal(gatewayEventView(eventRequest(), mgr as never), null);
  assert.equal(gatewayEventView(eventRequest('forged'), mgr as never), 'invalid');
});

test('events: the view closes with its instance', () => {
  const gone = { ...liveInstances };
  const shrinking = { getInstance: (id: string) => gone[id] };
  const view = gatewayEventView(eventRequest(eventToken()), shrinking as never) as GatewayEventView;
  assert.equal(view.live(), true);
  delete gone[slot.instanceId];
  assert.equal(view.live(), false);
  assert.equal(view.allows('theme:changed', {}), false);
});

test('events route: another namespace never reaches the wire, the shell still gets it', async () => {
  const key = '__aura_app_manager__';
  const g = globalThis as Record<string, unknown>;
  const saved = g[key];
  g[key] = mgr;
  const open = async (request: Request) => {
    const res = await eventsRoute({ url: new URL(request.url), request } as never) as Response;
    const reader = res.body!.getReader();
    await reader.read();
    return reader;
  };
  const drain = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
    let text = '';
    const deadline = setTimeout(() => void reader.cancel(), 2000);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
      if (text.includes('marker-value')) break;
    }
    clearTimeout(deadline);
    await reader.cancel();
    assert.ok(text.includes('marker-value'), `stream ended early: ${text.slice(0, 120)}`);
    return text;
  };
  try {
    const app = await open(eventRequest(eventToken()));
    const desktop = await open(eventRequest());
    OsEventBus.emit('kv:changed', { namespace: 'app/com.other.app', key: 'k', value: 'other-app-value' });
    OsEventBus.emit('kv:changed', { namespace: `app/${record.appId}`, key: 'k', value: 'marker-value' });
    const seenByApp = await drain(app);
    const seenByShell = await drain(desktop);
    assert.ok(!seenByApp.includes('other-app-value'));
    assert.ok(seenByShell.includes('other-app-value'));
  } finally {
    g[key] = saved;
  }
});

// ── identity ────────────────────────────────────────────────────────────────

test('a spoofed identity header is replaced on the way in', async () => {
  seen.length = 0;
  const forged = signGatewayClaim(claim('GET', '/api/os/themes', { appId: 'com.aura.settings' })).replace(/.$/, 'x');
  const res = await call('/_aura/os/api/os/themes', 'GET', {
    [GATEWAY_IDENTITY_HEADER]: forged,
    'x-aura-instance-id': 'com.aura.settings-1',
    'x-aura-app-id': 'com.aura.settings',
    referer: 'http://x/api/proxy/com.aura.settings/',
  });
  assert.equal(res.status, 200);
  const h = seen[0]!.headers;
  assert.notEqual(h[GATEWAY_IDENTITY_HEADER], forged);
  const verified = verifyGatewayClaim(String(h[GATEWAY_IDENTITY_HEADER]), { method: 'GET', path: '/api/os/themes' });
  assert.equal(verified?.appId, record.appId);
  assert.equal(verified?.instanceId, slot.instanceId);
  assert.equal(h['x-aura-instance-id'], slot.instanceId);
  assert.equal(h['x-aura-app-id'], record.appId);
  assert.match(String(h.referer), /\/api\/proxy\/com\.acme\.notes-1\/$/);
});

test('a forged, replayed, expired or dead-instance claim is refused', async () => {
  const path = '/api/kv/app/com.acme.notes/k';
  const route = '/api/kv/[...path]';
  const params = { path: 'app/com.acme.notes/k' };
  const good = signGatewayClaim(claim('GET', path));
  const [head, payload] = good.split('.');
  const otherPayload = Buffer.from(JSON.stringify(claim('GET', path, { appId: 'com.aura.settings' }))).toString('base64url');
  for (const token of [
    'nonsense',
    `${head}.${otherPayload}.${good.split('.')[2]}`,
    `${head}.${payload}.AAAA`,
    signGatewayClaim(claim('POST', path)),
    signGatewayClaim(claim('GET', '/api/os/themes')),
    signGatewayClaim(claim('GET', path, { iat: 1, exp: 2 })),
    signGatewayClaim(claim('GET', path, { instanceId: 'gone-1' })),
    signGatewayClaim(claim('GET', path, { appId: 'com.other.app' })),
  ]) {
    assert.equal((await enforce(apiCtx('GET', path, route, params, token)))?.status, 401, token.slice(0, 40));
  }
});

test('authenticate() trusts only a verified claim, and a bad one is never anonymous', async () => {
  const deps = { mgr, apiKeys: { verify: async () => null }, admin: { verifySession: async () => null } } as unknown as AuthDeps;
  const url = 'http://127.0.0.1:3000/api/notifications';
  const ok = await authenticate(new Request(url, { headers: { [GATEWAY_IDENTITY_HEADER]: signGatewayClaim(claim('GET', '/api/notifications')) } }), deps);
  assert.deepEqual(ok, { kind: 'instance', appId: record.appId, instanceId: slot.instanceId, verification: 'verified' });
  const bad = await authenticate(new Request(url, { headers: { [GATEWAY_IDENTITY_HEADER]: 'forged' } }), deps);
  assert.ok(bad instanceof Response);
  assert.equal((bad as Response).status, 401);
  assert.equal(gatewayClaimOf(new Request(url)), null);
});

test('no system fallback: without an instance or session nothing is forwarded', async () => {
  seen.length = 0;
  for (const c of [
    { record, slot: { ...slot, instanceId: null }, session },
    { record, slot, session: null },
    { record, slot, session: { ...session, label: 'other' } },
    { record, slot, session: { ...session, installationId: 'inst-2' } },
  ]) {
    ctx = c;
    const res = await call('/_aura/os/api/kv/os/theme');
    assert.ok(res.status === 401 || res.status === 409, String(res.status));
  }
  ctx = { record, slot: { ...slot, instanceId: null }, session };
  assert.equal((await call('/_aura/runtime.js')).status, 503);
  ctx = { record, slot, session };
  assert.equal(seen.length, 0);
});

// ── CSRF ────────────────────────────────────────────────────────────────────

test('CSRF: mutations need the exact Origin plus JSON or the token', async () => {
  const boundary = (method: string, headers: Record<string, string>) =>
    browserBoundaryError({ method, headers } as unknown as http.IncomingMessage, session);
  assert.equal(boundary('GET', {}), null);
  assert.equal(boundary('GET', { 'sec-fetch-site': 'same-site' }), 'cross-site');
  assert.equal(boundary('GET', { origin: 'http://evil--desk.example:3000' }), 'origin-mismatch');
  assert.equal(boundary('POST', { 'content-type': 'application/json' }), 'origin-required');
  assert.equal(boundary('POST', { origin: `${ORIGIN}.evil.example`, 'content-type': 'application/json' }), 'origin-mismatch');
  assert.equal(boundary('POST', { origin: ORIGIN, 'content-type': 'text/plain' }), 'csrf-required');
  assert.equal(boundary('POST', { origin: ORIGIN, 'content-type': 'text/plain; application/json' }), 'csrf-required');
  assert.equal(boundary('DELETE', { origin: ORIGIN }), 'csrf-required');
  assert.equal(boundary('POST', { origin: ORIGIN, 'x-aura-csrf': 'wrong' }), 'csrf-required');
  assert.equal(boundary('POST', json), null);
  assert.equal(boundary('OPTIONS', { origin: ORIGIN }), 'method-not-allowed');

  const issued = JSON.parse((await call('/_aura/os/_csrf')).body) as { token: string; header: string };
  assert.equal(boundary('POST', { origin: ORIGIN, 'content-type': 'multipart/form-data', [issued.header]: issued.token }), null);
  assert.equal((await call('/_aura/os/api/kv/app/x', 'POST', { origin: ORIGIN, 'content-type': 'text/plain' }, 'x')).status, 403);
  assert.equal((await call('/_aura/os/api/kv/app/x', 'POST', json, '{}')).status, 200);
});

// ── credentials ─────────────────────────────────────────────────────────────

test('shell cookies and credentials never reach the shell API, and none come back', async () => {
  seen.length = 0;
  const res = await call('/_aura/os/api/kv/os/theme', 'GET', {
    cookie: 'aura_session=secret; __Host-aura_session=secret; aura_app=host',
    authorization: 'Bearer aura-admin1.secret',
    'x-aura-internal-service': 'guess',
    'x-forwarded-host': 'evil.example',
    'x-forwarded-for': '1.2.3.4',
  });
  assert.equal(res.status, 200);
  const h = seen[0]!.headers;
  for (const name of ['cookie', 'authorization', 'x-aura-internal-service', 'x-forwarded-host', 'x-forwarded-for']) {
    assert.equal(h[name], undefined, name);
  }
  assert.equal(res.headers['set-cookie'], undefined);
  assert.equal(res.headers['access-control-allow-origin'], undefined);
  assert.equal(res.headers.location, undefined);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
});

test('a signed claim is stripped before anything leaves for an app', () => {
  const name = GATEWAY_IDENTITY_HEADER;
  const node: Record<string, string> = { [name]: 'x', accept: '*/*' };
  stripShellCredentials(node, 'proxy-http');
  assert.deepEqual(Object.keys(node), ['accept']);
  const web = new Headers({ [name]: 'x', accept: '*/*' });
  stripShellCredentials(web, 'data');
  assert.equal(web.has(name), false);
  assert.deepEqual(stripShellCredentials([name, 'x', 'Accept', '*/*'], 'app-hosts-upgrade'), ['Accept', '*/*']);
});

// ── runtime: keys only from the verified Shell ──────────────────────────────

const cfg = {
  injectMeta: false, injectConsoleRelay: false, injectKeyForwarder: true,
  injectIdentityScript: false, injectInputCompat: false, injectEventSourceMux: false,
} as unknown as ProxyConfig;

function bootRuntime(frame: 'window' | 'nested') {
  const listeners: Array<(ev: unknown) => void> = [];
  const typed: string[] = [];
  const el = {
    nodeType: 1, tagName: 'DIV', isConnected: true, classList: { contains: () => false },
    getClientRects: () => [1], dispatchEvent: (e: { type: string }) => { typed.push(e.type); return true; },
  };
  const posted: Array<[{ type: string }, string]> = [];
  const shellWindow = { postMessage: (m: { type: string }, o: string) => { posted.push([m, o]); } };
  const embedder = { postMessage: () => { throw new Error('reported to the embedding app'); } };
  class KeyboardEvent { constructor(public type: string) {} }
  const sandbox: Record<string, unknown> = {
    location: { host: `${slot.label}--desk.example:3000`, protocol: 'http:', origin: ORIGIN, search: '' },
    document: {
      activeElement: el, body: {}, documentElement: {}, head: { appendChild() {} },
      addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], hasFocus: () => true,
      createElement: () => ({}),
    },
    navigator: { vendor: '' },
    addEventListener: (type: string, fn: (ev: unknown) => void) => { if (type === 'message') listeners.push(fn); },
    matchMedia: () => ({ matches: false }),
    KeyboardEvent, URLSearchParams,
    setTimeout, clearTimeout,
    top: shellWindow,
  };
  sandbox.window = sandbox;
  sandbox.parent = frame === 'window' ? shellWindow : embedder;
  const context = vm.createContext(sandbox);
  vm.runInContext(buildAppRuntimeJs({
    appId: record.appId, instanceId: slot.instanceId, label: slot.label, slot: 1, cfg, themeStrategy: 'inherit',
    framework: { id: 'f', version: '1' },
    theme: { themeId: 't', themeIdDark: 'd', themeIdLight: 'l', colorMode: 'dark', resolvedMode: 'dark' },
    keymap: { actions: [], bindings: {} },
  }), context);
  const fire = (source: unknown, origin: string) => {
    for (const l of listeners) l({ data: { type: 'aura.key.synthetic', action: 'keydown', key: 'F5' }, source, origin });
  };
  return { fire, typed, shellWindow, embedder, posted, bootstrap: sandbox.AuraRuntimeBootstrap as { shellOrigin: string } };
}

test('an embedding parent app cannot inject keys', () => {
  const { fire, typed, shellWindow, embedder, bootstrap } = bootRuntime('nested');
  const SHELL = 'http://desk.example:3000';
  assert.equal(bootstrap.shellOrigin, SHELL);
  fire(embedder, 'http://termxabcd1234--desk.example:3000');
  fire(embedder, SHELL);                    // right origin, wrong window
  fire(shellWindow, 'http://evil.example'); // right window, wrong origin
  assert.deepEqual(typed, []);
  fire(shellWindow, SHELL);
  assert.deepEqual(typed, ['keydown']);
});

test('a nested frame reports to the Shell at its exact origin, not through its parent', () => {
  const { posted } = bootRuntime('nested');
  assert.ok(posted.some(([m]) => m.type === 'aura.keyboard.hello'));
  assert.ok(posted.every(([, origin]) => origin === 'http://desk.example:3000'));
});

test('the runtime refuses to start on a host that is not its own label', () => {
  const js = buildAppRuntimeJs({
    appId: record.appId, instanceId: slot.instanceId, label: 'someoneelse', slot: 1, cfg, themeStrategy: 'inherit',
    framework: { id: 'f', version: '1' },
    theme: { themeId: 't', themeIdDark: 'd', themeIdLight: 'l', colorMode: 'dark', resolvedMode: 'dark' },
    keymap: { actions: [], bindings: {} },
  });
  const sandbox: Record<string, unknown> = { location: { host: `${slot.label}--desk.example:3000`, protocol: 'http:', origin: ORIGIN, search: '' } };
  sandbox.window = sandbox;
  vm.runInContext(js, vm.createContext(sandbox));
  assert.equal(sandbox.AuraRuntimeBootstrap, undefined);
});

// ── theme in the runtime ────────────────────────────────────────────────────

function bootThemed(opts: { links?: string[]; parsing?: boolean; strategy?: 'inherit' | 'override' }) {
  const links = (opts.links ?? []).map((href) => {
    const l = { href, getAttribute: () => l.href, setAttribute: (_: string, v: string) => { l.href = v; } };
    return l;
  });
  const written: string[] = [];
  const appended: Array<{ href?: string }> = [];
  const listeners: Array<(ev: unknown) => void> = [];
  const top = {};
  const sandbox: Record<string, unknown> = {
    location: { host: `${slot.label}--desk.example:3000`, protocol: 'http:', origin: ORIGIN, search: '' },
    document: {
      readyState: opts.parsing ? 'loading' : 'complete',
      currentScript: opts.parsing ? { async: false, defer: false } : null,
      head: { appendChild: (e: { href?: string }) => appended.push(e) },
      documentElement: {},
      write: (html: string) => written.push(html),
      createElement: () => ({}),
      querySelector: (s: string) => (s.startsWith('link[') && links.length ? links[0] : null),
      querySelectorAll: (s: string) => (s.startsWith('link[') ? links : []),
      addEventListener() {},
    },
    addEventListener: (type: string, fn: (ev: unknown) => void) => { if (type === 'message') listeners.push(fn); },
    top, URLSearchParams, Date,
  };
  sandbox.window = sandbox;
  vm.runInContext(buildAppRuntimeJs({
    appId: record.appId, instanceId: slot.instanceId, label: slot.label, slot: 1,
    cfg: { ...cfg, injectMeta: true, injectKeyForwarder: false } as ProxyConfig,
    themeStrategy: opts.strategy ?? 'inherit',
    framework: { id: 'f', version: '1' },
    theme: { themeId: 't', themeIdDark: 'd', themeIdLight: 'l', colorMode: 'dark', resolvedMode: 'dark' },
    keymap: { actions: [], bindings: {} },
  }), vm.createContext(sandbox));
  const fire = (type: string, source: unknown, origin: string) => { for (const l of listeners) l({ data: { type }, source, origin }); };
  return { links, written, appended, fire, top };
}
const SHELL_ORIGIN = 'http://desk.example:3000';
const GATEWAY_THEME = '/_aura/os/api/os/theme.css';

test('a page with no theme link gets a parser-blocking one through the gateway', () => {
  const { written, appended } = bootThemed({ parsing: true });
  assert.deepEqual(written, [`<link rel="stylesheet" href="${GATEWAY_THEME}">`]);
  assert.deepEqual(appended.filter((e) => e.href), []);
});

test('after parsing the link is appended, never written', () => {
  const { written, appended } = bootThemed({});
  assert.deepEqual(written, []);
  assert.equal(appended.filter((e) => e.href === GATEWAY_THEME).length, 1);
});

test('a page that links the theme itself is left as it is', () => {
  const { links, written, appended } = bootThemed({ parsing: true, links: ['/api/os/theme.css'] });
  assert.deepEqual(written, []);
  assert.deepEqual(appended.filter((e) => e.href), []);
  assert.equal(links[0]!.href, '/api/os/theme.css');
});

test('an override app gets no theme link', () => {
  const { written, appended } = bootThemed({ parsing: true, strategy: 'override' });
  assert.deepEqual(written, []);
  assert.deepEqual(appended.filter((e) => e.href), []);
});

test('only the verified Shell can refresh the theme, and only theme links change', () => {
  const { links, fire, top } = bootThemed({ links: ['/api/os/theme.css', GATEWAY_THEME, '/own.css'] });
  fire('aura.theme.changed', {}, SHELL_ORIGIN);                 // right origin, wrong window
  fire('aura.theme.changed', top, 'http://evil.example');       // right window, wrong origin
  fire('aura.other', top, SHELL_ORIGIN);
  assert.deepEqual(links.map((l) => l.href), ['/api/os/theme.css', GATEWAY_THEME, '/own.css']);
  fire('aura.mode.changed', top, SHELL_ORIGIN);
  assert.match(links[0]!.href, /^\/api\/os\/theme\.css\?t=\d+$/);
  assert.match(links[1]!.href, /^\/_aura\/os\/api\/os\/theme\.css\?t=\d+$/);
  assert.equal(links[2]!.href, '/own.css');
});

test('the theme and icons are public through the gateway', async () => {
  assert.equal(await enforce(apiCtx('GET', '/api/os/theme.css', '/api/os/theme.css')), null);
  assert.equal(await enforce(apiCtx('GET', '/api/os/icons.svg', '/api/os/icons.svg')), null);
  assert.equal(await enforce(apiCtx('GET', '/api/os/icons/sun.svg', '/api/os/icons/[name].svg', { name: 'sun' })), null);
});
