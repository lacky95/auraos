// Phase 1 stream B: the report-only policy path. Nothing here may be able to
// change a response, and nothing sensitive may reach the stored report.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { AdminAuth, ApiKeyStore, Authorizer, SYSTEM_PRINCIPAL } from '@aura/core';
import type { AccessPrincipal } from '@aura/core';
import { createDecide } from '../src/lib/access/decide.ts';
import { accessReportOff, captureAccess, createAccessReporter } from '../src/lib/access/guard.ts';
import { refererAppId, refererProxyId } from '../src/lib/access/legacyReferer.ts';
import { combineCandidates, createObserver, observeIdentity, statusClass } from '../src/lib/access/observer.ts';
import type { ObserverDeps } from '../src/lib/access/observer.ts';
import { AccessReport, MAX_REPORT_KEYS, eventKey, readAccessReport, reportKey } from '../src/lib/access/report.ts';
import { candidateRules, dispatchedMethods, handlersOf, normalizeMethod } from '../src/lib/access/resolve.ts';
import { ROUTE_ACCESS_MANIFEST as M } from '../src/lib/access/routeManifest.ts';
import { SURFACE_MANIFEST } from '../src/lib/access/surfaceManifest.ts';
import { ROUTE_METHODS } from '../src/lib/access/types.ts';
import type { AccessEvent, AccessLabel, AccessRule, DecideInput, RequestSnapshot } from '../src/lib/access/types.ts';
import {
  INTERNAL_SERVICE_HEADER, internalServiceHeaders, loopbackUrl, reportSurface, staticSurface, surfaceIdentity,
} from '../server/access-bridge.mjs';
import { dropServiceWorkerScope, stripSessionCookie, stripShellCredentials } from '../server/shell-credentials.mjs';
import { createAppHostRouter } from '../server/app-hosts.mjs';
import { attachWsProxy } from '../server/attach.mjs';
import { streamHeaders } from '../server/sse-mux.mjs';
import { enumerateRoutes } from './helpers/enumerateRoutes.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = Symbol.for('aura.access');
const EARLY = Symbol.for('aura.access.early');
const g = globalThis as unknown as Record<symbol, unknown>;

const anon: AccessPrincipal = { kind: 'anonymous', verification: 'unverified' };
const inst = (appId: string, instanceId = `${appId}-1`): AccessPrincipal =>
  ({ kind: 'instance', appId, instanceId, verification: 'verified' });
const admin: AccessPrincipal = { kind: 'admin', credential: 'shared', sessionId: 'abcd', verification: 'verified' };

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
  identity: { authorization: null, sessionCookie: false, referer: null, instanceId: null },
  ...over,
});

function observerWith(over: Partial<ObserverDeps> = {}) {
  const report = new AccessReport({ redis: () => null });
  const observer = createObserver({ deps: deps(over), report });
  const rows = () => Object.keys(((report as unknown) as { counts: Map<string, number> }).counts ? Object.fromEntries((report as unknown as { counts: Map<string, number> }).counts) : {});
  return { report, observer, rows };
}

const fields = (key: string) => {
  const [surface, subject, method, variant, principal, appId, decision, reason, status, via] = key.split('|');
  return { surface, subject, method, variant, principal, appId, decision, reason, status, via };
};

// ── decide ──────────────────────────────────────────────────────────────────

test('decide: the shared admin satisfies owner, and anonymous does not', async () => {
  const d = createDecide({ authorizer: authorizer() });
  const rule: AccessRule = { allow: ['owner'], target: 'system' };
  assert.deepEqual(await d(input(admin, rule)), { outcome: 'allow', reason: 'owner' });
  assert.deepEqual(await d(input({ kind: 'operator', verification: 'verified' }, rule)), { outcome: 'allow', reason: 'owner' });
  assert.deepEqual(await d(input(anon, rule)), { outcome: 'deny', reason: 'unauthenticated' });
  assert.deepEqual(await d(input(inst('com.a.app'), rule)), { outcome: 'deny', reason: 'wrong-principal' });
});

test('decide: unclassified, empty and public rules', async () => {
  const d = createDecide({ authorizer: authorizer() });
  assert.deepEqual(await d(input(anon, null)), { outcome: 'deny', reason: 'unclassified' });
  assert.deepEqual(await d(input(admin, { allow: [], target: 'system' })), { outcome: 'deny', reason: 'rule-denied' });
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

test('decide: transport and fresh-auth outcomes', async () => {
  const d = createDecide({ authorizer: authorizer() });
  const fresh: AccessRule = { allow: ['owner'], target: 'system', freshAuth: true };
  assert.equal((await d(input(admin, fresh))).outcome, 'needs-operator');
  assert.equal((await d({ ...input(admin, fresh), transport: 'https' })).outcome, 'needs-fresh-auth');
  assert.equal((await d({ ...input(admin, fresh), auth: { fresh: true } })).outcome, 'allow');
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
      const c = candidateRules(M, { route, handlers: handlersOf(M, route) }, v.methods[0]!, { query: q, namespace: ns });
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

test('identity: foreign Authorization is labelled and never a 401', async () => {
  const id = (authorization: string) => ({ authorization, sessionCookie: false, referer: null, instanceId: null });
  for (const header of ['Basic Zm9vOmJhcg==', 'Bearer not-aura', 'Bearer aura1.bad.sig', 'garbage']) {
    const seen = await observeIdentity(id(header), deps());
    assert.equal(seen.via, 'foreign-or-invalid', header);
    assert.equal(seen.principal.kind, 'anonymous');
  }
});

test('identity: a valid instance token is verified', async () => {
  const seen = await observeIdentity({ authorization: `Bearer ${GOOD_INSTANCE_TOKEN}`, sessionCookie: false, referer: null, instanceId: null }, deps());
  assert.equal(seen.via, 'instance-token');
  assert.equal(seen.principal.kind, 'instance');
});

test('identity: an unknown nonce never reaches the token MAC', async () => {
  let verified = 0;
  const mgr = { ...fakeMgr(), tokens: { hasNonce: () => false, verify: () => { verified += 1; return null; } } };
  await observeIdentity({ authorization: `Bearer ${GOOD_INSTANCE_TOKEN}`, sessionCookie: false, referer: null, instanceId: null }, deps({ mgr: () => mgr as never }));
  assert.equal(verified, 0);
});

test('identity: a login cookie or session bearer is observed and grants nothing (D37)', async () => {
  const cookie = await observeIdentity({ authorization: null, sessionCookie: true, referer: null, instanceId: null }, deps());
  assert.equal(cookie.via, 'login-session');
  assert.equal(cookie.principal.kind, 'anonymous');
  const bearer = await observeIdentity({ authorization: 'Bearer aura-sess1.a.b', sessionCookie: false, referer: null, instanceId: null }, deps());
  assert.equal(bearer.via, 'login-session');
  assert.equal(bearer.principal.kind, 'anonymous');
});

test('identity: with Valkey down, keys and sessions are `unverified` and not looked up', async () => {
  let calls = 0;
  const services = {
    apiKeys: { peek: async () => { calls += 1; return null; } },
    admin: { peekSession: async () => { calls += 1; return null; } },
  };
  for (const authorization of ['Bearer aura_k1_x', 'Bearer aura-admin1.a.b']) {
    const seen = await observeIdentity(
      { authorization, sessionCookie: false, referer: null, instanceId: null },
      deps({ services: () => services, redisReady: () => false }),
    );
    assert.equal(seen.via, 'unverified');
  }
  assert.equal(calls, 0);
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

test('AdminAuth.peekSession verifies and leaves rotation to the real path', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'access-admin-'));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keyFile = path.join(dir, 'admin.key');
  const r = memoryRedis();
  const auth = new AdminAuth({ keyFile, redis: () => r as never });
  auth.ensure();
  const credential = fs.readFileSync(keyFile, 'utf8').trim();
  const unlocked = await auth.unlock(credential);
  assert.ok(unlocked.ok);
  const token = (unlocked as { token: string }).token;
  assert.ok(await auth.peekSession(token));
  assert.equal(await auth.peekSession('aura-admin1.bad.sig'), null);

  fs.writeFileSync(keyFile, `${credential}x`.padEnd(credential.length + 8, 'y'));
  r.writes.length = 0;
  assert.equal(await auth.peekSession(token), null);
  assert.deepEqual(r.writes, [], 'no session purge from the observer');
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

test('kill switch: AURA_ACCESS_REPORT=off stops capture, surfaces and the label', () => {
  const prev = process.env['AURA_ACCESS_REPORT'];
  const prevBridge = g[BRIDGE];
  let called = 0;
  g[BRIDGE] = { observeSurface() { called += 1; } };
  process.env['AURA_ACCESS_REPORT'] = 'off';
  try {
    assert.equal(accessReportOff(), true);
    assert.equal(captureAccess(ctxFor('http://x/api/kv/os/x')), null);
    reportSurface({ subject: 'ws-proxy', method: 'UPGRADE', status: 101 });
    assert.equal(called, 0);
    assert.deepEqual(internalServiceHeaders('http://127.0.0.1:3000/api/apps'), {});
  } finally {
    if (prev === undefined) delete process.env['AURA_ACCESS_REPORT']; else process.env['AURA_ACCESS_REPORT'] = prev;
    if (prevBridge) g[BRIDGE] = prevBridge; else delete g[BRIDGE];
  }
});

test('kill switch: credential stripping stays on', () => {
  const prev = process.env['AURA_ACCESS_REPORT'];
  process.env['AURA_ACCESS_REPORT'] = 'off';
  try {
    const h = stripShellCredentials(new Headers({ cookie: 'aura_session=s; app=1' }), 'proxy-http');
    assert.equal(h.get('cookie'), 'app=1');
  } finally {
    if (prev === undefined) delete process.env['AURA_ACCESS_REPORT']; else process.env['AURA_ACCESS_REPORT'] = prev;
  }
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
    appId: null, decision: 'deny', reason: 'unauthenticated', status: '2xx', via: 'none', ...over,
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
      authorization: 'Bearer s3cret-token', sessionCookie: true,
      referer: 'http://x/api/proxy/referer-secret/page?cookie-secret', instanceId: 'body-secret',
    },
  }));
  bridge.observeSurface({
    subject: 'ws-proxy', method: 'UPGRADE', status: 101,
    identity: { authorization: 'Bearer s3cret-token', sessionCookie: false, referer: null, instanceId: null },
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

test('observer: the admin session reports as operator', async () => {
  const { report, observer } = observerWith({
    services: () => ({ admin: { peekSession: async () => ({ sessionId: 'abcd' }) } }),
  });
  await observer.observeRequest(snapshot({ identity: { authorization: 'Bearer aura-admin1.a.b', sessionCookie: false, referer: null, instanceId: null } }));
  const [key] = [...(report as unknown as { counts: Map<string, number> }).counts.keys()].map(fields);
  assert.equal(key!.principal, 'operator');
  assert.equal(key!.decision, 'allow');
  assert.equal(key!.via, 'admin-session');
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
  assert.equal((await run({ ...kv, pathname: '/api/kv/os/nexus/source-seeds', internal: 'internal-secret' })).via, 'internal');
});

test('internal label: only literal loopback gets it', () => {
  assert.ok(internalServiceHeaders('http://127.0.0.1:3000/api/apps')[INTERNAL_SERVICE_HEADER]);
  assert.ok(internalServiceHeaders('http://[::1]:3000/api/apps')[INTERNAL_SERVICE_HEADER]);
  for (const url of ['http://localhost:3000/', 'http://aura-shell:3000/', 'http://127.0.0.1.evil.test/', 'nonsense']) {
    assert.deepEqual(internalServiceHeaders(url), {}, url);
  }
  assert.equal(loopbackUrl('http://localhost:3000/x'), 'http://127.0.0.1:3000/x');
  assert.equal(loopbackUrl('http://aura-shell:3000/x'), null);
});

// ── bridge validation ───────────────────────────────────────────────────────

test('bridge: a mismatched subject, variant, appId or field is dropped', () => {
  const { report, observer } = observerWith();
  const before = () => report.pending().events;
  observer.bridge.report(event({ decision: 'allow', reason: 'owner' }));
  assert.equal(before(), 1, 'a valid event counts');
  const bad: AccessEvent[] = [
    event({ subject: '/raw/path?token=x' as AccessLabel }),
    event({ surface: 'websocket', subject: 'not-a-surface' as AccessLabel }),
    event({ surface: 'static', subject: 'ws-proxy' as AccessLabel }),
    event({ variant: 'made-up' as AccessLabel }),
    event({ appId: 'com.not.installed' as AccessLabel }),
    event({ reason: 'free text' as never }),
    event({ via: 'x' as never }),
    null as never,
  ];
  for (const e of bad) observer.bridge.report(e);
  assert.equal(before(), 1);
  assert.equal(report.pending().meta['dropped'], bad.length);
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

test('surfaceIdentity keeps whether a session cookie exists, not its value', () => {
  const id = surfaceIdentity({ cookie: 'app=1; aura_session=SECRET', authorization: 'Bearer x' })!;
  assert.equal(id.sessionCookie, true);
  assert.ok(!JSON.stringify(id).includes('SECRET'));
  assert.equal(surfaceIdentity({ cookie: 'my_aura_session=1' })!.sessionCookie, false);
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
  for (const value of ['Bearer aura1.a.b', 'Bearer aura_k1_x', 'Bearer app-token', 'Basic Zm9v']) {
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

test('stripShellCredentials counts what it removes and what it forwards', () => {
  const prev = g[BRIDGE];
  const counted: string[] = [];
  g[BRIDGE] = { countCredential: (k: string, s: string) => counted.push(`${k}|${s}`) };
  try {
    stripShellCredentials(new Headers({ authorization: 'Bearer aura1.x.y' }), 'data');
    stripShellCredentials(new Headers({ authorization: 'Bearer aura_k1_x' }), 'data');
    stripShellCredentials(new Headers({ authorization: 'Bearer aura-admin1.x' }), 'ws-proxy');
    stripShellCredentials(new Headers({ cookie: 'aura_session=x' }), 'proxy-http');
    assert.deepEqual(counted, [
      'forwarded-instance-token|data', 'forwarded-api-key|data', 'stripped-admin-bearer|ws-proxy', 'stripped-session-cookie|proxy-http',
    ]);
  } finally {
    if (prev) g[BRIDGE] = prev; else delete g[BRIDGE];
  }
});

test('the proxy and data routes strip on the way in and out', () => {
  const proxy = fs.readFileSync(path.join(root, 'src/pages/api/proxy/[id]/[...path].ts'), 'utf8');
  const data = fs.readFileSync(path.join(root, 'src/pages/api/data/[authority]/[...path].ts'), 'utf8');
  assert.match(proxy, /stripShellCredentials\(new Headers\(request\.headers\), 'proxy-http'\)/);
  assert.match(proxy, /ALL: APIRoute = async \(ctx\) => dropServiceWorkerScope\(await forward\(ctx\)\)/);
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

test('SSE mux: app targets lose shell credentials, shell routes keep them', () => {
  const base = { cookie: 'aura_session=s; app=1', authorization: 'Bearer aura-admin1.x', accept: 'text/event-stream' };
  for (const p of ['/api/proxy/com.a.app/events', '/api/data/com.a/x']) {
    const h = streamHeaders(base, `http://127.0.0.1:3000${p}`);
    assert.equal(h.cookie, 'app=1');
    assert.equal(h.authorization, undefined);
  }
  const shell = streamHeaders(base, 'http://127.0.0.1:3000/api/notifications/stream');
  assert.equal(shell.authorization, base.authorization);
  assert.equal(shell.cookie, base.cookie);
  assert.equal(base.authorization, 'Bearer aura-admin1.x', 'the socket-level headers are not changed');
});

const listen = (s: http.Server) => new Promise<number>((res) => s.listen(0, '127.0.0.1', () => res((s.address() as net.AddressInfo).port)));

test('App Hosts HTTP and raw upgrade strip shell credentials and keep app ones', { timeout: 10_000 }, async () => {
  let httpSeen: http.IncomingHttpHeaders = {};
  let upgradeSeen = '';
  const upstream = http.createServer((req, res) => { httpSeen = req.headers; res.end('ok'); });
  upstream.on('upgrade', (req, socket) => {
    upgradeSeen = req.rawHeaders.join('\n');
    socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: x\r\n\r\n');
  });
  const port = await listen(upstream);
  const apps = [{
    manifest: { id: 'com.a.app', name: 'A', hosts: [{ name: 'aapp' }] },
    instances: [{ instanceId: 'com.a.app-1', port, state: 'resumed', sandbox: 'proot' }],
  }];
  const front = http.createServer((_q, r) => { r.statusCode = 418; r.end(); });
  // Node only parses an upgrade when the server has a listener for it.
  front.on('upgrade', (_q, socket) => socket.destroy());
  createAppHostRouter({ appsList: async () => apps }).attach(front);
  const frontPort = await listen(front);
  try {
    await new Promise<void>((resolve, reject) => {
      http.get({
        port: frontPort, host: '127.0.0.1',
        headers: { host: 'aapp--desk.test', cookie: 'aura_session=SECRET; app=1', authorization: 'Bearer aura-admin1.SECRET' },
      }, (res) => { res.resume(); res.on('end', resolve); }).on('error', reject);
    });
    assert.equal(httpSeen.cookie, 'app=1');
    assert.equal(httpSeen.authorization, undefined);

    await new Promise<void>((resolve, reject) => {
      const req = http.request({
        port: frontPort, host: '127.0.0.1',
        headers: {
          host: 'aapp--desk.test', connection: 'Upgrade', upgrade: 'x',
          cookie: '__Host-aura_session=SECRET; app=2', authorization: 'Bearer aura-sess1.SECRET',
        },
      });
      req.on('upgrade', (_r, socket) => { socket.destroy(); resolve(); });
      req.on('response', (r) => { r.resume(); reject(new Error(`no upgrade: ${r.statusCode}`)); });
      req.on('error', reject);
      req.end();
    });
    assert.ok(!upgradeSeen.includes('SECRET'));
    assert.match(upgradeSeen, /app=2/);
  } finally {
    front.closeAllConnections();
    upstream.closeAllConnections();
    front.close();
    upstream.close();
  }
});

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

test('legacy Referer: one parser with the old semantics', () => {
  const mgr = {
    getInstance: (id: string) => (id === 'com.a.app-1' ? { appId: 'com.a.app' } : undefined),
    getInstancesByApp: (id: string) => (id === 'com.b.app' ? [{ appId: 'com.b.app' }] : []),
  };
  const cases: Array<[string | null, string | null]> = [
    [null, null],
    ['', null],
    ['not a url', null],
    ['http://x/launcher', null],
    ['http://x/api/proxy/com.a.app-1', null],          // no trailing slash: no match
    ['http://x/api/proxy/com.a.app-1/', 'com.a.app'],
    ['http://x/api/proxy/com.b.app/page', 'com.b.app'],
    ['http://x/api/proxy/unknown/page', 'unknown'],
    ['http://x/api/proxy/system/page', 'system'],
  ];
  for (const [referer, want] of cases) assert.equal(refererAppId(referer, mgr), want, String(referer));
  assert.equal(refererProxyId('http://x/api/proxy/a/b'), 'a');
  const src = ['src/pages/api/kv/[...path].ts', 'src/pages/api/data/[authority]/[...path].ts', 'src/lib/customInterfaces.ts', 'src/middleware.ts', 'src/lib/access/identify.ts'];
  for (const f of src) {
    assert.ok(!fs.readFileSync(path.join(root, f), 'utf8').includes('.match(/^\\/api\\/proxy'), `${f} has its own parser`);
  }
});

test('ROUTE_METHODS covers what the observer can name', () => {
  assert.ok(ROUTE_METHODS.includes('OTHER'));
});
