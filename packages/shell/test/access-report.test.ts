// Phase 1 stream B: the report-only policy path. Nothing here may be able to
// change a response, and nothing sensitive may reach the stored report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error ws has no type declarations in this workspace
import { WebSocketServer, WebSocket } from 'ws';
import { ApiKeyStore, Authorizer, SYSTEM_PRINCIPAL } from '@aura/core';
import type { AccessPrincipal } from '@aura/core';
import { createDecide } from '../src/lib/access/decide.ts';
import { captureAccess, createAccessReporter } from '../src/lib/access/guard.ts';
import { refererProxyId } from '../src/lib/access/legacyReferer.ts';
import {
  combineCandidates, createObserver, identifyRequest, observeIdentity, requestFromFacts, statusClass,
} from '../src/lib/access/observer.ts';
import type { ObserverDeps } from '../src/lib/access/observer.ts';
import { AccessReport, MAX_REPORT_KEYS, eventKey, readAccessReport, reportKey } from '../src/lib/access/report.ts';
import { candidateRules, dispatchedMethods, handlersOf, normalizeMethod } from '../src/lib/access/resolve.ts';
import { ROUTE_ACCESS_MANIFEST as M } from '../src/lib/access/routeManifest.ts';
import { SURFACE_MANIFEST } from '../src/lib/access/surfaceManifest.ts';
import { ROUTE_METHODS } from '../src/lib/access/types.ts';
import type { AccessEvent, AccessLabel, AccessRule, DecideInput, RequestSnapshot } from '../src/lib/access/types.ts';
import {
  INTERNAL_SERVICE_HEADER, internalServiceHeaders, reportSurface, staticSurface, surfaceIdentity,
} from '../server/access-bridge.mjs';
import { dropServiceWorkerScope, stripSessionCookie, stripShellCredentials } from '../server/shell-credentials.mjs';
import { attachWsProxy } from '../server/attach.mjs';
import { ACCESS_MODES, accessMode, parseAccessMode, wouldEnforce } from '../server/access-mode.mjs';
import { enumerateRoutes } from './helpers/enumerateRoutes.ts';
import { localSystemId } from '@aura/core/system-identity';
/** The test data dir's own system id (D47): every resolved principal carries it. */
const SYS = localSystemId();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = Symbol.for('aura.access');
const EARLY = Symbol.for('aura.access.early');
const g = globalThis as unknown as Record<symbol, unknown>;

const anon: AccessPrincipal = { kind: 'anonymous', verification: 'unverified' };
const inst = (appId: string, instanceId = `${appId}-1`): AccessPrincipal =>
  ({ kind: 'instance', appId, instanceId, verification: 'verified' });
const operator: AccessPrincipal = { kind: 'operator', verification: 'verified' };

const authorizer = (declared: Record<string, string[]> = {}) => new Authorizer({
  grants: { get: async () => null } as never,
  declared: (id: string) => declared[id],
  appScope: () => 'user',
});

const input = (principal: AccessPrincipal, rule: AccessRule | null, resource: Partial<DecideInput['resource']> = {}): DecideInput => ({
  principal,
  action: { surface: 'api', subject: '/api/x' as AccessLabel, method: 'GET', variant: null, rule },
  resource: { target: rule?.target ?? 'system', ...resource },
  transport: 'http',
  auth: { fresh: false },
  accessProfile: 'open',
  systemMode: 'normal',
  deployment: 'private',
});

function fakeMgr() {
  const instances = new Map([['com.a.app-1', { appId: 'com.a.app', instanceId: 'com.a.app-1' }]]);
  return {
    tokens: {
      hasNonce: (id: string) => id === 'com.a.app-1',
      verify: (t: string) => (t === GOOD_INSTANCE_TOKEN ? { instanceId: 'com.a.app-1' } : null),
    },
    getInstance: (id: string) => instances.get(id),
    getInstancesByApp: (id: string) => [...instances.values()].filter((i) => i.appId === id),
    getManifest: (id: string) => (id === 'com.a.app' ? {} : undefined),
    registry: { getById: (id: string) => (id === 'com.a.app' ? {} : undefined) },
  };
}
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const GOOD_INSTANCE_TOKEN = `aura1.${b64({ i: 'com.a.app-1', n: 'n' })}.sig`;

function deps(over: Partial<ObserverDeps> = {}): ObserverDeps {
  return {
    authorizer: authorizer({ 'com.a.app': [] }),
    mgr: () => fakeMgr() as never,
    services: () => null,
    redisReady: () => true,
    internalSecret: () => 'internal-secret',
    ...over,
  };
}

const snapshot = (over: Partial<RequestSnapshot> = {}): RequestSnapshot => ({
  method: 'GET',
  routePattern: '/api/apps',
  pathname: '/api/apps',
  search: '',
  params: {},
  https: false,
  status: 200,
  internal: null,
  identity: { verified: null, referer: null, instanceId: null },
  ...over,
});

function observerWith(over: Partial<ObserverDeps> = {}) {
  const report = new AccessReport({ redis: () => null });
  const observer = createObserver({ deps: deps(over), report });
  const rows = () => Object.keys(((report as unknown) as { counts: Map<string, number> }).counts ? Object.fromEntries((report as unknown as { counts: Map<string, number> }).counts) : {});
  return { report, observer, rows };
}

const fields = (key: string) => {
  const [surface, subject, method, variant, principal, appId, decision, reason, status, via, wouldEnforce] = key.split('|');
  return { surface, subject, method, variant, principal, appId, decision, reason, status, via, wouldEnforce };
};

/** Run `fn` with AURA_ACCESS_ENFORCE set to `value` (undefined: unset). */
function withMode<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env['AURA_ACCESS_ENFORCE'];
  if (value === undefined) delete process.env['AURA_ACCESS_ENFORCE']; else process.env['AURA_ACCESS_ENFORCE'] = value;
  const restore = () => { if (prev === undefined) delete process.env['AURA_ACCESS_ENFORCE']; else process.env['AURA_ACCESS_ENFORCE'] = prev; };
  try {
    const out = fn();
    if (out instanceof Promise) return out.finally(restore) as T;
    restore();
    return out;
  } catch (err) {
    restore();
    throw err;
  }
}

// ── decide ──────────────────────────────────────────────────────────────────

test('decide: the operator and the owner satisfy owner, and anonymous does not', async () => {
  const d = createDecide({ authorizer: authorizer() });
  const rule: AccessRule = { allow: ['owner'], target: 'system' };
  assert.deepEqual(await d(input(operator, rule)), { outcome: 'allow', reason: 'owner' });
  assert.deepEqual(await d(input({ kind: 'user', userId: 'default', role: 'owner', sessionId: 's', verification: 'verified' }, rule)), { outcome: 'allow', reason: 'owner' });
  assert.equal((await d(input({ kind: 'admin', credential: 'shared', sessionId: 'a', verification: 'verified' } as never, rule))).outcome, 'deny', 'a retired admin look-alike is nobody');
  assert.deepEqual(await d(input(anon, rule)), { outcome: 'deny', reason: 'unauthenticated' });
  // Same decision; the refusal also says it is the owner's only (refusalText.ts).
  assert.deepEqual(await d(input(inst('com.a.app'), rule)), { outcome: 'deny', reason: 'wrong-principal', facts: { ownerOnly: true } });
});

test('decide: unclassified, empty and public rules', async () => {
  const d = createDecide({ authorizer: authorizer() });
  assert.deepEqual(await d(input(anon, null)), { outcome: 'deny', reason: 'unclassified' });
  assert.deepEqual(await d(input(operator, { allow: [], target: 'system' })), { outcome: 'deny', reason: 'rule-denied' });
  assert.deepEqual(await d(input(anon, { allow: ['public'], target: 'system' })), { outcome: 'allow', reason: 'public' });
  assert.deepEqual(await d(input(SYSTEM_PRINCIPAL, null)), { outcome: 'allow', reason: 'system' });
});

test('decide: own-instance checks the specific target', async () => {
  const d = createDecide({ authorizer: authorizer() });
  const rule: AccessRule = { allow: ['own-instance'], target: 'instance' };
  assert.equal((await d(input(inst('com.a.app'), rule, { instanceId: 'com.a.app-1' }))).outcome, 'allow');
  assert.deepEqual(await d(input(inst('com.a.app'), rule, { instanceId: 'com.b.app-1' })), { outcome: 'deny', reason: 'wrong-target' });
});

test('decide: an MVP auto-grant is surfaced, and Authorizer answers are unchanged', async () => {
  const az = authorizer({ 'com.a.app': ['declared.perm'] });
  const d = createDecide({ authorizer: az });
  const rule = (p: string): AccessRule => ({ allow: ['app-permission'], target: 'notification', permissions: [p] });
  assert.deepEqual(await d(input(inst('com.a.app'), rule('some.unenforced'))), { outcome: 'allow', reason: 'auto-granted' });
  assert.deepEqual(await d(input(inst('com.a.app'), rule('declared.perm'))), { outcome: 'allow', reason: 'app-permission' });
  assert.equal((await az.authorize(inst('com.a.app') as never, 'some.unenforced')).allow, true);
  assert.deepEqual(await d(input(inst('com.a.app'), rule('data:x:<unfilled>'))), { outcome: 'deny', reason: 'missing-permission' });
});

test('decide: transport and fresh-auth outcomes (D18, D63)', async () => {
  const d = createDecide({ authorizer: authorizer() });
  const fresh: AccessRule = { allow: ['owner'], target: 'system', freshAuth: true };
  assert.equal((await d(input(operator, fresh))).outcome, 'needs-fresh-auth', 'HTTP: the password by default');
  assert.equal((await d({ ...input(operator, fresh), transport: 'https' })).outcome, 'needs-fresh-auth');
  let asked = 0;
  const strict = createDecide({ authorizer: authorizer(), freshAuthRequiresHttps: async () => { asked += 1; return true; } });
  assert.equal((await strict(input(operator, fresh))).outcome, 'needs-operator', 'HTTPS required: HTTP is the operator\'s');
  assert.equal((await strict({ ...input(operator, fresh), transport: 'https' })).outcome, 'needs-fresh-auth');
  assert.equal(asked, 1, 'the switch is read only for a fresh-auth rule over HTTP');
  assert.equal((await d({ ...input(operator, fresh), auth: { fresh: true } })).outcome, 'allow');
  assert.equal((await d({ ...input(operator, fresh), auth: { fresh: true } })).outcome, 'allow');
  const login: AccessRule = { allow: ['public'], target: 'session' };
  assert.equal((await d(input(anon, login))).outcome, 'allow');
  assert.equal((await d({ ...input(anon, login), deployment: 'public' })).outcome, 'needs-https');
});

test('decide: a throwing Authorizer is a policy-error, never an exception', async () => {
  const d = createDecide({ authorizer: { authorize: async () => { throw new Error('boom'); } } });
  const r = await d(input(inst('com.a.app'), { allow: ['app-permission'], target: 'notification', permissions: ['x'] }));
  assert.deepEqual(r, { outcome: 'deny', reason: 'policy-error' });
});

// ── rule resolution ─────────────────────────────────────────────────────────

test('methods normalize, including OTHER', () => {
  assert.equal(normalizeMethod('get'), 'GET');
  assert.equal(normalizeMethod('PROPFIND'), 'OTHER');
});

test('every manifest route, method and variant resolves to a rule', () => {
  const { routes } = enumerateRoutes(path.join(root, 'src/pages'));
  const facts = { query: new URLSearchParams(), namespace: null };
  for (const r of routes) {
    for (const method of dispatchedMethods(r.handlers)) {
      const c = candidateRules(M, { route: r.route, handlers: handlersOf(M, r.route) }, method, facts);
      assert.ok(c.length > 0, `${method} ${r.route}`);
    }
  }
  for (const [route, ref] of Object.entries(M.routes)) {
    for (const v of ref.variants ?? []) {
      const q = v.match.on === 'query' ? new URLSearchParams({ [v.match.name]: v.match.equals ?? '1' }) : new URLSearchParams();
      const ns = v.match.on === 'namespace' ? v.match.namespace : null;
      const params = v.match.on === 'param' ? { [v.match.name]: v.match.equals } : {};
      const c = candidateRules(M, { route, handlers: handlersOf(M, route) }, v.methods[0]!, { query: q, namespace: ns, params });
      assert.ok(c.some((x) => x.variant === v.id), `${route} ${v.id}`);
    }
  }
});

test('implicit HEAD follows GET, and an ALL route answers OTHER', () => {
  const facts = { query: new URLSearchParams(), namespace: null };
  const head = candidateRules(M, { route: '/api/interfaces', handlers: handlersOf(M, '/api/interfaces') }, 'HEAD', facts);
  assert.equal(head[0]!.rule, M.routes['/api/interfaces']!.methods!.GET);
  assert.deepEqual(handlersOf(M, '/api/proxy/[id]/[...path]'), ['ALL']);
  assert.ok(candidateRules(M, { route: '/api/proxy/[id]/[...path]', handlers: ['ALL'] }, 'OTHER', facts).length);
});

test('the report takes the body variant the gate settled: /api/intents/start is one rule, not `unresolved`', () => {
  const route = '/api/intents/start';
  const at = (bodyVariant?: string | null) => candidateRules(M, { route, handlers: handlersOf(M, route) }, 'POST', {
    query: new URLSearchParams(), namespace: null, ...(bodyVariant !== undefined ? { bodyVariant } : {}),
  }).map((c) => c.variant);
  assert.deepEqual(at(), ['terminal-command', null], 'not settled: both stay candidates');
  assert.deepEqual(at(null), [null], 'the gate read the body: no command');
  assert.deepEqual(at('terminal-command'), ['terminal-command']);
  assert.equal(M.routes[route]!.methods!.POST!.ambiguous, undefined);
});

test('a param variant names a parameter of its own route', () => {
  for (const [route, ref] of Object.entries(M.routes)) {
    for (const v of ref.variants ?? []) {
      if (v.match.on === 'param') assert.ok(route.includes(`[${v.match.name}]`), `${route}#${v.id} matches [${v.match.name}]`);
    }
  }
});

test('body variants stay candidates; disagreement reports `unresolved`', () => {
  const route = '/api/instances/[instanceId]/ports';
  const c = candidateRules(M, { route, handlers: handlersOf(M, route) }, 'POST', { query: new URLSearchParams(), namespace: null });
  assert.deepEqual(c.map((x) => x.variant), ['into', 'host', null]);
  const combined = combineCandidates([
    { variant: 'a', result: { outcome: 'allow', reason: 'owner' } },
    { variant: null, result: { outcome: 'deny', reason: 'wrong-target' } },
  ]);
  assert.equal(combined.variant, 'unresolved');
  assert.deepEqual(combined.result, { outcome: 'deny', reason: 'ambiguous-rule' });
  const same = combineCandidates([
    { variant: 'a', result: { outcome: 'allow', reason: 'owner' } },
    { variant: null, result: { outcome: 'allow', reason: 'owner' } },
  ]);
  assert.equal(same.variant, null);
});

// ── no-touch identity ───────────────────────────────────────────────────────

/** A request's identity as the observer sees it: resolved, then read from the snapshot. */
async function identityOf(headers: Record<string, string>, d: ObserverDeps = deps()) {
  const verified = identifyRequest(new Request('http://shell/api/apps', { headers }), d);
  return observeIdentity({ verified, referer: headers['referer'] ?? null, instanceId: null }, d);
}

const OWNER = { id: 'default', username: 'owner', role: 'owner', disabled: false };
const LIVE_LOGIN = 'aura-sess1.live.mac';
/** Auth services with one live owner login session; `revoked` drops it. */
function loginServices(state: { revoked?: boolean; disabled?: boolean } = {}) {
  return {
    loginSessions: {
      verify: async (t: string) => (t === LIVE_LOGIN && !state.revoked
        ? { sessionId: 'f'.repeat(32), userId: 'default', method: 'password' as const, expiresAt: Date.now() + 60_000 }
        : null),
    },
    users: { getOwner: async () => ({ ...OWNER, disabled: !!state.disabled }) },
  } as never;
}

test('identity: foreign Authorization is labelled and never a 401', async () => {
  for (const header of ['Basic Zm9vOmJhcg==', 'Bearer not-aura', 'Bearer aura1.bad.sig', 'garbage']) {
    const seen = await identityOf({ authorization: header });
    assert.equal(seen.via, 'foreign-or-invalid', header);
    assert.equal(seen.principal.kind, 'anonymous');
  }
});

test('identity: a valid instance token is verified', async () => {
  const seen = await identityOf({ authorization: `Bearer ${GOOD_INSTANCE_TOKEN}` });
  assert.equal(seen.via, 'instance-token');
  assert.equal(seen.principal.kind, 'instance');
});

test('identity: an unknown nonce never reaches the token MAC', async () => {
  let verified = 0;
  const mgr = { ...fakeMgr(), tokens: { hasNonce: () => false, verify: () => { verified += 1; return null; } } };
  await identityOf({ authorization: `Bearer ${GOOD_INSTANCE_TOKEN}` }, deps({ mgr: () => mgr as never }));
  assert.equal(verified, 0);
});

test('identity: a live login cookie or session bearer is the owner; expired or revoked is anonymous', async () => {
  const live = deps({ services: () => loginServices() });
  for (const headers of [{ cookie: `app=1; aura_session=${LIVE_LOGIN}` }, { cookie: `__Host-aura_session=${LIVE_LOGIN}` }, { authorization: `Bearer ${LIVE_LOGIN}` }] as Record<string, string>[]) {
    const seen = await identityOf(headers, live);
    assert.equal(seen.via, 'login-session');
    assert.deepEqual(seen.principal, { kind: 'user', userId: 'default', role: 'owner', sessionId: 'f'.repeat(32), verification: 'verified', systemId: SYS });
  }
  for (const services of [loginServices({ revoked: true }), loginServices({ disabled: true })]) {
    const seen = await identityOf({ cookie: `aura_session=${LIVE_LOGIN}` }, deps({ services: () => services }));
    assert.equal(seen.principal.kind, 'anonymous');
    assert.equal(seen.via, 'foreign-or-invalid');
  }
  const expired = await identityOf({ cookie: 'aura_session=aura-sess1.expired.mac' }, live);
  assert.equal(expired.principal.kind, 'anonymous');
  // Two cookies of one name: one was planted, so neither counts.
  const planted = await identityOf({ cookie: `aura_session=${LIVE_LOGIN}; aura_session=${LIVE_LOGIN}` }, live);
  assert.equal(planted.principal.kind, 'anonymous');
});

test('identity: a verified App Host session is the owner acting through that app', async () => {
  const facts = {
    headers: { cookie: 'aura_app=sealed', authorization: 'Bearer app-own-token' }, method: 'GET', url: '/',
    appHost: { appId: 'com.a.app', instanceId: 'com.a.app-1', userId: 'default', sid: 's'.repeat(32) },
  };
  const { bridge } = createObserver({ deps: deps(), report: new AccessReport({ redis: () => null }) });
  const v = await bridge.identify(facts);
  assert.deepEqual(v, {
    principal: {
      kind: 'user', userId: 'default', role: 'owner', sessionId: 's'.repeat(32), verification: 'verified', systemId: SYS,
      through: { appId: 'com.a.app', instanceId: 'com.a.app-1' },
    },
    via: 'app-host',
  });
  // Anything else under that name is not a session the App Host verified.
  const forged = await bridge.identify({ ...facts, appHost: { appId: 'com.a.app', userId: 7 } });
  assert.notEqual(forged?.principal.kind, 'user');
  assert.equal(requestFromFacts({ headers: { a: 'b' }, method: 'TRACE', url: 'http://evil/x' })?.url, 'http://shell/');
});

test('identity: with Valkey down, keys and sessions are `unverified` and not looked up', async () => {
  let calls = 0;
  const services = {
    apiKeys: { peek: async () => { calls += 1; return null; } },
    loginSessions: { verify: async () => { calls += 1; return null; } },
    users: { getOwner: async () => { calls += 1; return null; } },
  };
  for (const headers of [{ authorization: 'Bearer aura_k1_x' }, { authorization: 'Bearer aura-sess1.a.b' }] as Record<string, string>[]) {
    const seen = await identityOf(headers, deps({ services: () => services as never, redisReady: () => false }));
    assert.equal(seen.via, 'unverified');
  }
  const cookie = await identityOf({ cookie: 'aura_session=aura-sess1.a.b' }, deps({ services: () => services as never, redisReady: () => false }));
  assert.equal(cookie.principal.kind, 'anonymous');
  assert.equal(calls, 0);
});

test('identity: the middleware snapshot holds the verified result, never a token', async () => {
  const secrets = [GOOD_INSTANCE_TOKEN, LIVE_LOGIN, 'aura_session'];
  const loaded = { observeRequest: () => undefined, identifyAccess: (r: Request) => identifyRequest(r, deps({ services: () => loginServices() })) };
  const reporter = createAccessReporter(async () => loaded);
  for (const headers of [{ authorization: `Bearer ${GOOD_INSTANCE_TOKEN}` }, { cookie: `aura_session=${LIVE_LOGIN}` }] as Record<string, string>[]) {
    const request = new Request('http://shell/api/apps', { headers });
    const snap = captureAccess({ request, url: new URL(request.url), routePattern: '/api/apps', params: {} })!;
    reporter.identify(snap, request);
    const verified = await snap.identity.verified;
    assert.ok(verified && verified.principal.kind !== 'anonymous', JSON.stringify(verified));
    const stored = JSON.stringify({ ...snap, identity: { ...snap.identity, verified } });
    for (const s of secrets) assert.ok(!stored.includes(s), s);
  }
});

function memoryRedis() {
  const kv = new Map<string, string>();
  const writes: string[] = [];
  return {
    kv,
    writes,
    async get(k: string) { return kv.get(k) ?? null; },
    async set(k: string, v: string) { writes.push(`set ${k}`); kv.set(k, v); return 'OK'; },
    async zadd() { return 1; },
    async hset(k: string) { writes.push(`hset ${k}`); return 1; },
    async exists(k: string) { return kv.has(k) ? 1 : 0; },
    async del(...keys: string[]) { writes.push(`del ${keys.join(',')}`); let n = 0; for (const k of keys) n += kv.delete(k) ? 1 : 0; return n; },
    async scan() { return ['0', [...kv.keys()].filter((k) => k.startsWith('adminsess:'))]; },
    async incr() { return 1; },
    async pexpire() { return 1; },
  };
}

test('ApiKeyStore.peek verifies without recording a use', async () => {
  const r = memoryRedis();
  const store = new ApiKeyStore(() => r as never);
  const { key, apiKey } = await store.create({ name: 'k', scopes: ['system.notifications'], by: { kind: 'system' } });
  r.writes.length = 0;
  assert.equal((await store.peek(key))?.id, apiKey.id);
  assert.equal(await store.peek(`${key.slice(0, -1)}${key.endsWith('A') ? 'B' : 'A'}`), null);
  assert.deepEqual(r.writes, [], 'apikey:used untouched');
  await store.verify(key);
  assert.ok(r.writes.some((w) => w === 'hset apikey:used'), 'the real verify still records');
});

// ── fail-open ───────────────────────────────────────────────────────────────

const ctxFor = (url: string, init?: RequestInit) => ({ request: new Request(url, init), url: new URL(url), routePattern: '/api/kv/[...path]', params: { path: 'os/x' } });

test('fail-open: a failed import or throwing observer cannot reach the caller', async () => {
  const snap = snapshot();
  const failed = createAccessReporter(async () => { throw new Error('bad build'); });
  assert.doesNotThrow(() => failed(snap, 200));
  const throwing = createAccessReporter(async () => ({ observeRequest() { throw new Error('boom'); } }));
  assert.doesNotThrow(() => throwing(snap, 200));
  const rejecting = createAccessReporter(async () => ({ observeRequest: async () => { throw new Error('boom'); } }));
  assert.doesNotThrow(() => rejecting(snap, 200));
  await new Promise((r) => setTimeout(r, 10));
});

test('fail-open: the import runs once and is not awaited by the request', async () => {
  let loads = 0;
  let seen = 0;
  const reporter = createAccessReporter(() => { loads += 1; return new Promise((res) => setTimeout(() => res({ observeRequest: () => { seen += 1; } }), 5)); });
  reporter(snapshot(), 200);
  reporter(snapshot(), 200);
  assert.equal(seen, 0, 'returned before the observer ran');
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(loads, 1);
  assert.equal(seen, 2);
});

test('fail-open: a capture error yields no snapshot rather than a throw', () => {
  const broken = { get request(): Request { throw new Error('nope'); }, url: new URL('http://x/api/apps') };
  assert.equal(captureAccess(broken as never), null);
});

test('fail-open: a bad manifest or broken deps only produce a counter', async () => {
  const report = new AccessReport({ redis: () => null });
  const bad = createObserver({ deps: deps(), report, manifest: null as never });
  await assert.doesNotReject(bad.observeRequest(snapshot()));
  assert.equal(report.pending().meta['errors'], 1);

  const { observer, report: r2 } = observerWith({ mgr: () => { throw new Error('no manager'); } });
  await assert.doesNotReject(observer.observeRequest(snapshot()));
  assert.ok(r2.pending().events + (r2.pending().meta['errors'] ?? 0) >= 1);
});

test('fail-open: a missing bridge only counts', () => {
  const prev = g[BRIDGE];
  delete g[BRIDGE];
  g[EARLY] = 0;
  try {
    assert.doesNotThrow(() => reportSurface({ subject: 'ws-proxy', method: 'UPGRADE', status: 101, identity: null }));
    assert.equal(g[EARLY], 1);
  } finally {
    if (prev) g[BRIDGE] = prev;
    delete g[EARLY];
  }
});

test('fail-open: a bridge that throws cannot reach a server', () => {
  const prev = g[BRIDGE];
  g[BRIDGE] = { observeSurface() { throw new Error('boom'); } };
  try {
    assert.doesNotThrow(() => reportSurface({ subject: 'ws-proxy', method: 'UPGRADE', status: 101 }));
  } finally {
    if (prev) g[BRIDGE] = prev; else delete g[BRIDGE];
  }
});

test('fail-open: Valkey down skips the flush and keeps the counts', async () => {
  const report = new AccessReport({ redis: () => null });
  report.add(event());
  await report.flush();
  assert.equal(report.pending().events, 1);
});

test('fail-open: a failing pipeline keeps the counts', async () => {
  const report = new AccessReport({
    redis: () => ({
      pipeline: () => ({ hincrby() {}, expire() {}, exec: async () => { throw new Error('down'); } }),
      xadd: async () => 'x',
      expire: async () => 1,
    }),
  });
  report.add(event());
  report.note('dropped');
  await assert.doesNotReject(report.flush());
  assert.equal(report.pending().events, 1);
  assert.equal(report.pending().meta['dropped'], 1);
});

// ── kill switch and body ────────────────────────────────────────────────────

test('access mode: AURA_ACCESS_ENFORCE is off|report|enforce, default report', () => {
  assert.deepEqual([...ACCESS_MODES], ['off', 'report', 'enforce']);
  assert.equal(withMode(undefined, accessMode), 'report');
  assert.equal(withMode('', accessMode), 'report');
  assert.equal(withMode(' Enforce ', accessMode), 'enforce');
  assert.equal(withMode('off', accessMode), 'off');
  assert.equal(parseAccessMode('enforced'), null);
  const warn = console.warn;
  let warned = 0;
  console.warn = () => { warned += 1; };
  try {
    assert.equal(withMode('enforced', accessMode), 'report', 'a typo is the default, never off');
    withMode('nonsense', accessMode);
  } finally { console.warn = warn; }
  assert.ok(warned <= 1, 'an unknown value is logged once');
});

test('access mode: the env variable is read in exactly one place (D36)', () => {
  const readers: string[] = [];
  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dist' || name === '.astro') continue;
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|mjs|js|astro)$/.test(name) && /process\.env(\.|\[['"])AURA_ACCESS_(ENFORCE|REPORT)\b|\bACCESS_MODE_ENV\]/.test(fs.readFileSync(p, 'utf8'))) {
        readers.push(path.relative(root, p));
      }
    }
  };
  walk(path.join(root, 'src'));
  walk(path.join(root, 'server'));
  assert.deepEqual(readers, ['server/access-mode.mjs']);
});

test('wouldEnforce: only in report, only for a non-allow outcome not already enforced', () => {
  for (const outcome of ['deny', 'needs-approval', 'needs-fresh-auth', 'needs-https', 'needs-operator']) {
    assert.equal(wouldEnforce('report', outcome), true, outcome);
    assert.equal(wouldEnforce('report', outcome, true), false, `${outcome}, already enforced`);
    assert.equal(wouldEnforce('enforce', outcome), false, `${outcome} in enforce`);
    assert.equal(wouldEnforce('off', outcome), false, `${outcome} in off`);
  }
  assert.equal(wouldEnforce('report', 'allow'), false);
});

test('kill switch: AURA_ACCESS_ENFORCE=off stops capture, surfaces and the label', () => {
  const prevBridge = g[BRIDGE];
  let called = 0;
  g[BRIDGE] = { observeSurface() { called += 1; } };
  try {
    withMode('off', () => {
      assert.equal(captureAccess(ctxFor('http://x/api/kv/os/x')), null);
      reportSurface({ subject: 'ws-proxy', method: 'UPGRADE', status: 101 });
      assert.equal(called, 0);
      assert.deepEqual(internalServiceHeaders('http://127.0.0.1:3000/api/apps'), {});
    });
    for (const mode of ['report', 'enforce']) {
      withMode(mode, () => assert.notEqual(captureAccess(ctxFor('http://x/api/kv/os/x')), null, `${mode} keeps capturing`));
    }
  } finally {
    if (prevBridge) g[BRIDGE] = prevBridge; else delete g[BRIDGE];
  }
});

test('kill switch: credential stripping stays on', () => {
  withMode('off', () => {
    const h = stripShellCredentials(new Headers({ cookie: 'aura_session=s; app=1' }), 'proxy-http');
    assert.equal(h.get('cookie'), 'app=1');
  });
});

test('no body is consumed by capture or observation', async () => {
  const ctx = ctxFor('http://x/api/kv/os/x', { method: 'PUT', body: '{"value":"keep me"}' });
  const snap = captureAccess(ctx)!;
  const { observer } = observerWith();
  await observer.observeRequest({ ...snap, status: 200 });
  assert.equal(ctx.request.bodyUsed, false);
  assert.equal(await ctx.request.text(), '{"value":"keep me"}');
});

test('the middleware hands off without awaiting the observer or reading the body', () => {
  const src = fs.readFileSync(path.join(root, 'src/middleware.ts'), 'utf8');
  assert.ok(!/await\s+reportAccess/.test(src));
  assert.ok(!/request\.(json|text|formData|arrayBuffer|blob|clone)\(/.test(src));
  assert.match(src, /import\('\.\/lib\/access\/observer\.ts'\)/);
  assert.ok(!/^import .*access\/observer/m.test(src), 'the observer is never a static import');
});

// ── report ──────────────────────────────────────────────────────────────────

function event(over: Partial<AccessEvent> = {}): AccessEvent {
  return {
    surface: 'api', subject: '/api/apps' as AccessLabel, method: 'GET', variant: null, principal: 'anonymous',
    appId: null, decision: 'deny', reason: 'unauthenticated', status: '2xx', via: 'none', wouldEnforce: true, ...over,
  };
}

function flushRedis() {
  const hash = new Map<string, number>();
  const stream: unknown[][] = [];
  const expires: string[] = [];
  return {
    hash, stream, expires,
    pipeline() {
      const ops: Array<() => [null, unknown]> = [];
      return {
        hincrby(_k: string, f: string, n: number) { ops.push(() => { const v = (hash.get(f) ?? 0) + n; hash.set(f, v); return [null, v]; }); },
        expire(k: string) { ops.push(() => { expires.push(k); return [null, 1]; }); },
        exec: async () => ops.map((o) => o()),
      };
    },
    async xadd(...args: Array<string | number>) { stream.push(args); return 'id'; },
    async expire(k: string) { expires.push(k); return 1; },
  };
}

test('report: events aggregate into one field, with a TTL', async () => {
  const r = flushRedis();
  const report = new AccessReport({ redis: () => r, now: () => Date.UTC(2026, 10, 23) });
  report.add(event());
  report.add(event());
  report.add(event({ decision: 'allow', reason: 'owner' }));
  await report.flush();
  assert.equal(r.hash.get(eventKey(event())), 2);
  assert.ok(r.expires.includes(reportKey('2026-11-23')));
  assert.equal(report.pending().events, 0);
});

test('report: only the first of each new would-deny is sampled', async () => {
  const r = flushRedis();
  const report = new AccessReport({ redis: () => r });
  report.add(event());
  report.add(event({ decision: 'allow', reason: 'owner' }));
  await report.flush();
  assert.equal(r.stream.length, 1);
  report.add(event());
  await report.flush();
  assert.equal(r.stream.length, 1, 'already sampled today');
  assert.ok(r.stream[0]!.includes('MAXLEN'), 'the stream is bounded');
});

test('report: keys are capped and the rest is counted as overflow', () => {
  const report = new AccessReport({ redis: () => null, maxKeys: 3 });
  assert.equal(MAX_REPORT_KEYS, 5000);
  for (let i = 0; i < 5; i += 1) report.add(event({ subject: `/api/s${i}` as AccessLabel }));
  report.add(event({ subject: '/api/s0' as AccessLabel }));
  const p = report.pending();
  assert.equal(p.keys, 3);
  assert.equal(p.events, 4);
  assert.equal(p.meta['overflow'], 2);
});

test('report: reading parses rows and counters', async () => {
  const now = Date.UTC(2026, 10, 23);
  const out = await readAccessReport({
    hgetall: async (k): Promise<Record<string, string>> => (k === reportKey('2026-11-23') ? { [eventKey(event())]: '4', '#overflow': '2' } : {}),
    xrevrange: async () => [['1-0', ['at', '1', 'subject', '/api/apps']]],
  }, 2, now);
  assert.equal(out.days.length, 2);
  assert.equal(out.days[0]!.rows[0]!.count, 4);
  assert.equal(out.days[0]!.counters['overflow'], 2);
  assert.equal(out.samples[0]!['subject'], '/api/apps');
});

test('report: wouldEnforce is part of the row, and rows stored before it still parse', async () => {
  const now = Date.UTC(2026, 10, 23);
  const legacy = eventKey(event()).split('|').slice(0, -1).join('|');
  const out = await readAccessReport({
    hgetall: async (k): Promise<Record<string, string>> => (k === reportKey('2026-11-23') ? {
      [eventKey(event())]: '5',
      [eventKey(event({ decision: 'allow', reason: 'owner', wouldEnforce: false }))]: '3',
      [legacy]: '2',
      [`${legacy}|maybe`]: '1',
    } : {}),
    xrevrange: async () => [],
  }, 1, now);
  const rows = out.days[0]!.rows;
  assert.deepEqual(rows.map((r) => [r.count, r.decision, r.wouldEnforce]), [[5, 'deny', true], [3, 'allow', false], [2, 'deny', false]]);
  assert.equal(eventKey(event()).endsWith('|1'), true);
  assert.equal(eventKey(event({ wouldEnforce: false })).endsWith('|0'), true);
});

test('report: a sample carries wouldEnforce', async () => {
  const r = flushRedis();
  const report = new AccessReport({ redis: () => r });
  report.add(event());
  await report.flush();
  const args = r.stream[0]!.map(String);
  assert.equal(args[args.indexOf('wouldEnforce') + 1], 'true');
});

test('observer: wouldEnforce follows the mode; a gateway refusal is already enforced', async () => {
  const gatewayIdentity = { verified: { principal: inst('com.a.app'), via: 'gateway' as const }, referer: null, instanceId: null };
  const flags = async (mode: string, over: Partial<RequestSnapshot> = {}) => {
    const prev = process.env['AURA_ACCESS_ENFORCE'];
    process.env['AURA_ACCESS_ENFORCE'] = mode;
    try {
      const { report, observer } = observerWith();
      await observer.observeRequest(snapshot({ routePattern: '/404', pathname: '/nope', ...over }));
      return [...(report as unknown as { counts: Map<string, number> }).counts.keys()].map(fields)[0]!;
    } finally {
      if (prev === undefined) delete process.env['AURA_ACCESS_ENFORCE']; else process.env['AURA_ACCESS_ENFORCE'] = prev;
    }
  };
  const report = await flags('report');
  assert.equal(report.decision, 'deny');
  assert.equal(report.wouldEnforce, '1');
  assert.equal((await flags('enforce')).wouldEnforce, '0');
  // Refused at the gateway already: nothing for enforce to add.
  assert.equal((await flags('report', { identity: gatewayIdentity, status: 403 })).wouldEnforce, '0');
  // Served by the gateway, but enforce would refuse it (an auto-grant stops counting there).
  assert.equal((await flags('report', { identity: gatewayIdentity, status: 200 })).wouldEnforce, '1');
});

test('redaction: nothing from the request reaches the stored report', async () => {
  const secrets = ['s3cret-token', 'private-kv-key', 'query-secret', 'cookie-secret', 'referer-secret', 'body-secret'];
  const r = flushRedis();
  const report = new AccessReport({ redis: () => r });
  const { bridge, observeRequest } = createObserver({ deps: deps(), report });
  await observeRequest(snapshot({
    method: 'PUT',
    routePattern: '/api/kv/[...path]',
    pathname: '/api/kv/os/private-kv-key',
    search: '?token=query-secret',
    params: { path: 'os/private-kv-key' },
    identity: {
      verified: identifyRequest(new Request('http://x/', { headers: { authorization: 'Bearer s3cret-token', cookie: 'aura_session=cookie-secret' } }), deps()),
      referer: 'http://x/api/proxy/referer-secret/page?cookie-secret', instanceId: 'body-secret',
    },
  }));
  bridge.observeSurface({
    subject: 'ws-proxy', method: 'UPGRADE', status: 101,
    identity: { verified: bridge.identify({ headers: { authorization: 'Bearer s3cret-token' } }), referer: null, instanceId: null },
  });
  await new Promise((res) => setTimeout(res, 5));
  await report.flush();
  assert.ok(r.hash.size >= 2);
  const stored = JSON.stringify([[...r.hash.keys()], r.stream]);
  for (const s of secrets) assert.ok(!stored.includes(s), s);
});

test('observer: an unmatched route is unclassified, and the variant is reported', async () => {
  const { report, observer } = observerWith();
  await observer.observeRequest(snapshot({ routePattern: '/404', pathname: '/nope' }));
  await observer.observeRequest(snapshot({ method: 'POST', routePattern: '/api/instances/[instanceId]/ports', params: { instanceId: 'com.a.app-1' } }));
  const keys = [...(report as unknown as { counts: Map<string, number> }).counts.keys()].map(fields);
  const miss = keys.find((k) => k.subject === 'unmatched')!;
  assert.equal(miss.decision, 'deny');
  assert.equal(miss.reason, 'unclassified');
  assert.ok(keys.some((k) => k.subject === '/api/instances/[instanceId]/ports'));
});

test('observer: a retired admin session bearer (D50) is no credential: refused, never the operator', async () => {
  const { report, observer } = observerWith();
  const verified = identifyRequest(new Request('http://x/', { headers: { authorization: 'Bearer aura-admin1.a.b' } }), deps());
  await observer.observeRequest(snapshot({ identity: { verified, referer: null, instanceId: null } }));
  const [key] = [...(report as unknown as { counts: Map<string, number> }).counts.keys()].map(fields);
  assert.equal(key!.principal, 'anonymous');
  assert.equal(key!.via, 'foreign-or-invalid');
});

test('observer: the internal label needs the secret AND an allowlisted route', async () => {
  const run = async (s: Partial<RequestSnapshot>) => {
    const { report, observer } = observerWith();
    await observer.observeRequest(snapshot(s));
    return [...(report as unknown as { counts: Map<string, number> }).counts.keys()].map(fields)[0]!;
  };
  assert.equal((await run({ internal: 'internal-secret' })).via, 'internal');
  assert.notEqual((await run({ internal: 'wrong' })).via, 'internal');
  assert.notEqual((await run({ internal: 'internal-secret', method: 'DELETE' })).via, 'internal');
  assert.notEqual((await run({ internal: 'internal-secret', routePattern: '/api/proxy/[id]/[...path]' })).via, 'internal');
  const kv = { routePattern: '/api/kv/[...path]', params: { path: 'os/other' } };
  assert.notEqual((await run({ ...kv, pathname: '/api/kv/os/other', internal: 'internal-secret' })).via, 'internal');
  assert.notEqual((await run({ ...kv, pathname: '/api/kv/os/nexus/source-seeds', internal: 'internal-secret' })).via, 'internal');
});

test('internal label: only literal loopback gets it', () => {
  assert.ok(internalServiceHeaders('http://127.0.0.1:3000/api/apps')[INTERNAL_SERVICE_HEADER]);
  assert.ok(internalServiceHeaders('http://[::1]:3000/api/apps')[INTERNAL_SERVICE_HEADER]);
  for (const url of ['http://localhost:3000/', 'http://aura-shell:3000/', 'http://127.0.0.1.evil.test/', 'nonsense']) {
    assert.deepEqual(internalServiceHeaders(url), {}, url);
  }
});

// ── bridge validation ───────────────────────────────────────────────────────

test('bridge: there is no way to write a finished event into the report', () => {
  const { observer } = observerWith();
  assert.equal('report' in observer.bridge, false);
});

test('bridge: a surface observation is validated before it counts', async () => {
  const { report, observer } = observerWith();
  observer.bridge.observeSurface({ subject: 'nope', method: 'GET', status: 200 });
  observer.bridge.observeSurface({ subject: 'ws-proxy', method: 'UPGRADE', status: 101, appId: 'com.not.installed' });
  observer.bridge.observeSurface({ subject: 'ws-proxy', method: 'UPGRADE', status: 101, via: 'made-up' as never });
  observer.bridge.observeSurface({ subject: 'ws-proxy', method: 'UPGRADE', status: 101, appId: 'com.a.app' });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(report.pending().events, 1);
  assert.equal(report.pending().meta['dropped'], 3);
});

test('bridge: counters take closed labels only', () => {
  const { report, observer } = observerWith();
  observer.bridge.countEvent('socketio-kv');
  observer.bridge.countEvent('raw value');
  observer.bridge.countCredential('stripped-admin-bearer', 'proxy-http');
  observer.bridge.countCredential('stripped-admin-bearer', 'elsewhere');
  const meta = report.pending().meta;
  assert.equal(meta['event|socketio-kv'], 1);
  assert.equal(meta['cred|stripped-admin-bearer|proxy-http'], 1);
  assert.equal(meta['dropped'], 2);
});

test('every surface the servers report exists in the manifest', () => {
  const ids = new Set(SURFACE_MANIFEST.map((s) => s.id));
  for (const file of ['app-hosts.mjs', 'attach.mjs', 'sse-mux.mjs']) {
    const src = fs.readFileSync(path.join(root, 'server', file), 'utf8');
    for (const m of src.matchAll(/subject: '([^']+)'/g)) assert.ok(ids.has(m[1]!), `${file}: ${m[1]}`);
  }
  for (const id of ['terminal-pty', 'socketio-kv', 'socketio-os-events', 'shell-static-assets', 'vite-dev-server']) assert.ok(ids.has(id));
});

test('static surfaces: /_astro, favicon and dev-only Vite paths', () => {
  const prev = process.env['AURA_SHELL_RUNTIME'];
  try {
    delete process.env['AURA_SHELL_RUNTIME'];
    assert.equal(staticSurface('/_astro/a.js?v=1'), 'shell-static-assets');
    assert.equal(staticSurface('/favicon.ico'), 'shell-static-assets');
    assert.equal(staticSurface('/@vite/client'), 'vite-dev-server');
    assert.equal(staticSurface('/api/apps'), null);
    process.env['AURA_SHELL_RUNTIME'] = 'prod';
    assert.equal(staticSurface('/src/x.ts'), null);
    assert.equal(staticSurface('/_astro/a.js'), 'shell-static-assets');
  } finally {
    if (prev === undefined) delete process.env['AURA_SHELL_RUNTIME']; else process.env['AURA_SHELL_RUNTIME'] = prev;
  }
});

test('surfaceIdentity keeps the verdict and the hints, never a credential', async () => {
  const prev = g[BRIDGE];
  let seenFacts: unknown = null;
  g[BRIDGE] = { identify: async (facts: unknown) => { seenFacts = facts; return { principal: anon, via: 'foreign-or-invalid' }; } };
  try {
    const id = surfaceIdentity({ cookie: 'app=1; aura_session=SECRET', authorization: 'Bearer TOKEN', referer: 'http://r/' }, { url: '/x' })!;
    assert.ok(seenFacts, 'the credentials went to the resolver at once');
    const verified = await id.verified;
    assert.equal(verified?.via, 'foreign-or-invalid');
    const kept = JSON.stringify({ ...id, verified });
    assert.ok(!kept.includes('SECRET') && !kept.includes('TOKEN'), kept);
    assert.equal(id.referer, 'http://r/');
    g[BRIDGE] = undefined;
    assert.equal(surfaceIdentity({ authorization: 'Bearer TOKEN' })!.verified, null, 'no observer yet: unverified');
  } finally {
    g[BRIDGE] = prev;
  }
});

test('statusClass covers dropped sockets', () => {
  assert.equal(statusClass(101), '1xx');
  assert.equal(statusClass(503), '5xx');
  assert.equal(statusClass(0), 'none');
});

// ── credential stripping ────────────────────────────────────────────────────

test('stripSessionCookie removes only the Aura session cookies', () => {
  assert.equal(stripSessionCookie('aura_session=s'), null);
  assert.equal(stripSessionCookie('__Host-aura_session=s; app=1'), 'app=1');
  assert.equal(stripSessionCookie('a=1; aura_session=s; b=2'), 'a=1; b=2');
  const untouched = 'session=abc;  my_aura_session=1;aura_session_x=2; AURA_SESSION=3';
  assert.equal(stripSessionCookie(untouched), untouched, 'byte for byte when nothing matches');
});

test('stripShellCredentials: bearers', () => {
  for (const token of ['aura-sess1.a.b', 'aura-admin1.a.b']) {
    assert.equal(stripShellCredentials(new Headers({ authorization: `Bearer ${token}` }), 'data').get('authorization'), null);
    assert.equal(stripShellCredentials(new Headers({ authorization: `bearer  ${token}` }), 'data').get('authorization'), null);
  }
  // D89 B2: instance tokens and API keys never reach an app either; the app's own auth does.
  for (const token of ['aura1.a.b', 'aura_k1_x']) {
    for (const surface of ['proxy-http', 'ws-proxy', 'app-hosts-http', 'data']) {
      assert.equal(stripShellCredentials(new Headers({ authorization: `Bearer ${token}` }), surface).get('authorization'), null, `${token} ${surface}`);
    }
    assert.deepEqual(stripShellCredentials(['Authorization', `bearer ${token}`, 'X-App', 'k'], 'app-hosts-upgrade'), ['X-App', 'k']);
    const obj: Record<string, unknown> = { authorization: `Bearer ${token}` };
    stripShellCredentials(obj, 'ws-proxy');
    assert.deepEqual(obj, {});
  }
  for (const value of ['Bearer app-token', 'Bearer aura1x', 'Basic Zm9v']) {
    assert.equal(stripShellCredentials(new Headers({ authorization: value }), 'data').get('authorization'), value);
  }
});

test('stripShellCredentials: each header form', () => {
  const obj: Record<string, unknown> = { cookie: 'aura_session=s; app=1', authorization: 'Bearer aura-admin1.x', [INTERNAL_SERVICE_HEADER]: 'l', accept: '*/*' };
  stripShellCredentials(obj, 'app-hosts-http');
  assert.deepEqual(obj, { cookie: 'app=1', accept: '*/*' });

  const raw = ['Cookie', 'aura_session=s; app=1', 'Authorization', 'Bearer aura-sess1.x', 'Authorization', 'Bearer app', 'X-App', 'keep', 'X-Aura-Internal-Service', 'l'];
  assert.deepEqual(stripShellCredentials(raw, 'app-hosts-upgrade'), ['Cookie', 'app=1', 'Authorization', 'Bearer app', 'X-App', 'keep']);

  const h = stripShellCredentials(new Headers({ cookie: 'aura_session=s', [INTERNAL_SERVICE_HEADER]: 'l', 'x-app': 'keep' }), 'proxy-http');
  assert.equal(h.get('cookie'), null);
  assert.equal(h.get(INTERNAL_SERVICE_HEADER), null);
  assert.equal(h.get('x-app'), 'keep');
});

test('stripShellCredentials counts what it removes', () => {
  const prev = g[BRIDGE];
  const counted: string[] = [];
  g[BRIDGE] = { countCredential: (k: string, s: string) => counted.push(`${k}|${s}`) };
  try {
    stripShellCredentials(new Headers({ authorization: 'Bearer aura1.x.y' }), 'data');
    stripShellCredentials(new Headers({ authorization: 'Bearer aura_k1_x' }), 'data');
    stripShellCredentials(new Headers({ authorization: 'Bearer aura-admin1.x' }), 'ws-proxy');
    stripShellCredentials(new Headers({ cookie: 'aura_session=x' }), 'proxy-http');
    assert.deepEqual(counted, [
      'stripped-instance-token|data', 'stripped-api-key|data', 'stripped-admin-bearer|ws-proxy', 'stripped-session-cookie|proxy-http',
    ]);
  } finally {
    if (prev) g[BRIDGE] = prev; else delete g[BRIDGE];
  }
});

test('the proxy and data routes strip on the way in and out', () => {
  const proxy = fs.readFileSync(path.join(root, 'src/pages/api/proxy/[id]/[...path].ts'), 'utf8');
  const data = fs.readFileSync(path.join(root, 'src/pages/api/data/[authority]/[...path].ts'), 'utf8');
  assert.match(proxy, /stripShellCredentials\(new Headers\(request\.headers\), 'proxy-http'\)/);
  assert.match(proxy, /ALL: APIRoute = async \(ctx\) => machineOnly\(dropServiceWorkerScope\(await forward\(ctx\)\)\)/);
  assert.match(data, /stripShellCredentials\(new Headers\(request\.headers\), 'data'\)/);
  assert.match(data, /dropServiceWorkerScope\(new Response/);
  for (const src of [proxy, data]) assert.equal((src.match(/new Headers\(request\.headers\)/g) ?? []).length, 1);
});

test('dropServiceWorkerScope handles mutable and immutable responses', async () => {
  const open = dropServiceWorkerScope(new Response('x', { headers: { 'service-worker-allowed': '/', 'x-app': '1' } }));
  assert.equal(open.headers.get('service-worker-allowed'), null);
  assert.equal(open.headers.get('x-app'), '1');
  const locked = Response.redirect('http://x/y', 302);
  assert.equal(dropServiceWorkerScope(locked), locked, 'nothing to remove, same object');
  const frozen = new Response('body', { status: 201, headers: { 'service-worker-allowed': '/' } });
  Object.defineProperty(frozen.headers, 'delete', { value() { throw new TypeError('immutable'); } });
  const copy = dropServiceWorkerScope(frozen);
  assert.equal(copy.status, 201);
  assert.equal(copy.headers.get('service-worker-allowed'), null);
  assert.equal(await copy.text(), 'body');
});

const listen = (s: http.Server) => new Promise<number>((res) => s.listen(0, '127.0.0.1', () => res((s.address() as net.AddressInfo).port)));

test('WS proxy strips shell credentials and keeps app cookies', { timeout: 10_000 }, async () => {
  let seen: http.IncomingHttpHeaders = {};
  const upstream = http.createServer();
  const wss = new WebSocketServer({ server: upstream });
  wss.on('connection', (ws: { close(): void }, req: http.IncomingMessage) => { seen = req.headers; ws.close(); });
  const port = await listen(upstream);
  const shell = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify([{
      manifest: { id: 'com.a.app' },
      instances: [{ instanceId: 'com.a.app-1', appId: 'com.a.app', port, state: 'resumed', sandbox: 'proot', inPool: false }],
    }]));
  });
  attachWsProxy(shell);
  const shellPort = await listen(shell);
  const prev = process.env['SHELL_PORT'];
  process.env['SHELL_PORT'] = String(shellPort);
  try {
    await new Promise<void>((resolve, reject) => {
      const c = new WebSocket(`ws://127.0.0.1:${shellPort}/api/proxy/com.a.app-1/ws`, {
        headers: { cookie: 'aura_session=SECRET; app=1', authorization: 'Bearer aura-admin1.SECRET' },
      });
      c.on('close', () => resolve());
      c.on('error', reject);
    });
    assert.equal(seen.cookie, 'app=1');
    assert.equal(seen.authorization, undefined);
  } finally {
    if (prev === undefined) delete process.env['SHELL_PORT']; else process.env['SHELL_PORT'] = prev;
    wss.close();
    shell.closeAllConnections();
    upstream.closeAllConnections();
    shell.close();
    upstream.close();
  }
});

// ── legacy Referer ──────────────────────────────────────────────────────────

test('legacy Referer: one parser, and no route trusts it', () => {
  assert.equal(refererProxyId('http://x/api/proxy/a/b'), 'a');
  const src = ['src/pages/api/kv/[...path].ts', 'src/pages/api/data/[authority]/[...path].ts', 'src/lib/customInterfaces.ts', 'src/middleware.ts', 'src/lib/access/identify.ts'];
  for (const f of src) {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    assert.ok(!text.includes('.match(/^\\/api\\/proxy'), `${f} has its own parser`);
    assert.ok(!text.includes('legacyReferer'), `${f} trusts a Referer`);
  }
});

test('ROUTE_METHODS covers what the observer can name', () => {
  assert.ok(ROUTE_METHODS.includes('OTHER'));
});
