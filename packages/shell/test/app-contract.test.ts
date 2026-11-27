// Phase 3b stream E: the app contract (D48). `osClient.context.get` behind
// GET /api/os/context/<KEY>, `osClient.permissions` behind
// /api/user/me/permissions, the contract report, the access-report signals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as core from '@aura/core';
import { checkPermissions, contractReport, readContext, type ContextReadDeps } from '../src/lib/appContract.ts';
import { ROUTE_ACCESS_MANIFEST } from '../src/lib/access/routeManifest.ts';
import { effectiveRule } from '../src/lib/access/resolve.ts';
import { createObserver } from '../src/lib/access/observer.ts';
import { AccessReport } from '../src/lib/access/report.ts';
import { permissionHeld } from '../src/lib/access/decide.ts';
import type { ResolvedPrincipal } from '../src/lib/access/identify.ts';

const inst = (appId: string, via: ResolvedPrincipal['via'] = 'instance-token'): ResolvedPrincipal =>
  ({ principal: { kind: 'instance', appId, instanceId: `${appId}-1`, verification: 'verified' }, via });
const req = (path: string) => new Request(`http://shell${path}`);

function ctxDeps(resolved: ResolvedPrincipal, values: Record<string, string> = { OPENAI_API_KEY: 'sk-1' }, granted: string[] = ['OPENAI_API_KEY', 'UNSET_KEY']) {
  const signals: string[] = [];
  const d: ContextReadDeps = {
    resolve: async () => resolved,
    declared: (appId) => (appId === 'com.ex.notes' ? ['OPENAI_API_KEY', 'UNSET_KEY'] : appId === 'com.ex.bare' ? [] : undefined),
    // Stream C: the system Context behind context.read:<KEY> grants (no vault here: the instance acts for no user).
    context: {
      systemGranted: async (_app, key) => granted.includes(key),
      vaultGranted: async () => false,
      systemEnv: async () => ({}),
      systemValue: async (k) => values[k] ?? null,
      vaultValue: async () => null,
    },
    signal: (s, appId) => signals.push(`${s}|${appId}`),
  };
  return { d, signals };
}

test('context.get: a declared and granted key to the app\'s own server', async () => {
  const { d, signals } = ctxDeps(inst('com.ex.notes'));
  const res = await readContext(req('/api/os/context/OPENAI_API_KEY'), 'OPENAI_API_KEY', d);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { key: 'OPENAI_API_KEY', value: 'sk-1' });
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(signals, ['context-get|com.ex.notes']);
  const unset = await readContext(req('/x'), 'UNSET_KEY', d);
  assert.equal(unset.status, 404);
  assert.equal((await unset.json()).error, 'not-set');
});

test('context.get: a declared key the owner has not granted is refused, naming the grant (stream C)', async () => {
  const { d } = ctxDeps(inst('com.ex.notes'), undefined, []);
  const res = await readContext(req('/x'), 'OPENAI_API_KEY', d);
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error, 'context-not-granted');
  assert.match(body.message, /context\.read:OPENAI_API_KEY/);
  assert.ok(!JSON.stringify(body).includes('sk-1'));
});

test('context.get: an undeclared key is refused and counted; pages, owners and anonymous get nothing', async () => {
  const { d, signals } = ctxDeps(inst('com.ex.bare'));
  const res = await readContext(req('/x'), 'OPENAI_API_KEY', d);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'context-undeclared');
  assert.deepEqual(signals, ['context-undeclared|com.ex.bare']);

  const page = await readContext(req('/x'), 'OPENAI_API_KEY', ctxDeps(inst('com.ex.notes', 'gateway')).d);
  assert.equal(page.status, 403);
  assert.equal((await page.json()).error, 'server-only');
  const owner = await readContext(req('/x'), 'OPENAI_API_KEY', ctxDeps({ principal: { kind: 'user', userId: 'u', role: 'owner', verification: 'verified' } as never, via: 'login-session' }).d);
  assert.equal(owner.status, 403);
  const anon = await readContext(req('/x'), 'OPENAI_API_KEY', ctxDeps({ principal: { kind: 'anonymous', verification: 'unverified' }, via: 'none' as never }).d);
  assert.equal(anon.status, 401);
  const bad = await readContext(req('/x'), 'lower', ctxDeps(inst('com.ex.notes')).d);
  assert.equal(bad.status, 422);
  const rejected = await readContext(req('/x'), 'OPENAI_API_KEY', ctxDeps({ ...inst('com.ex.notes'), rejected: { reason: 'expired' as never } }).d);
  assert.equal(rejected.status, 401);
});

test('the route manifest: context GET is the instance token only; permissions reflect the caller; the report is the owner\'s', () => {
  const ctx = effectiveRule(ROUTE_ACCESS_MANIFEST, { route: '/api/os/context/[key]', handlers: ['GET', 'DELETE'] }, 'GET');
  assert.deepEqual(ctx?.allow, ['own-instance']);
  assert.deepEqual(ctx?.credentials, ['instance-token']);
  const del = effectiveRule(ROUTE_ACCESS_MANIFEST, { route: '/api/os/context/[key]', handlers: ['GET', 'DELETE'] }, 'DELETE');
  assert.equal(del?.freshAuth, true, 'DELETE is unchanged');
  const perms = effectiveRule(ROUTE_ACCESS_MANIFEST, { route: '/api/user/me/permissions', handlers: ['GET'] }, 'GET');
  assert.deepEqual(perms?.allow, ['own-instance', 'app-permission', 'owner']);
  const report = effectiveRule(ROUTE_ACCESS_MANIFEST, { route: '/api/admin/contract-report', handlers: ['GET'] }, 'GET');
  assert.ok(report && !report.allow.includes('public') && !report.allow.includes('app-permission'));
});

test('permissions.check: the app behind the call, as a rule decides; the owner holds all', async () => {
  const authorizer = new core.Authorizer({
    grants: { get: async () => null } as never,
    declared: (id: string) => (id === 'com.ex.notes' ? ['sidecars.spawn', 'notifications.popup'] : undefined),
    appBinding: async () => ({ scope: 'user', installationId: 'inst-1' }),
  });
  const held = (p: core.Principal, n: string) => permissionHeld({ authorizer }, p, n, true);
  const call = (resolved: ResolvedPrincipal, q: string) => checkPermissions(req(`/api/user/me/permissions?${q}`), { resolve: async () => resolved, held });
  let res = await call(inst('com.ex.notes'), 'p=sidecars.spawn&p=apps.mount&p=notifications.popup&p=network.internet');
  assert.deepEqual((await res.json()).permissions, {
    'sidecars.spawn': true, 'apps.mount': false, 'notifications.popup': false, 'network.internet': false,
  }, 'popup needs the owner\'s grant; strict: an auto-grant is not held');
  // A page through the gateway: the app behind it.
  res = await call({ principal: { kind: 'user', userId: 'u', role: 'owner', verification: 'verified', through: { appId: 'com.ex.notes', instanceId: 'com.ex.notes-1' } } as never, via: 'app-host' }, 'p=sidecars.spawn&p=apps.mount');
  assert.deepEqual((await res.json()).permissions, { 'sidecars.spawn': true, 'apps.mount': false });
  res = await call({ principal: { kind: 'user', userId: 'u', role: 'owner', verification: 'verified' } as never, via: 'login-session' }, 'p=apps.mount');
  assert.deepEqual((await res.json()).permissions, { 'apps.mount': true });
  res = await call({ principal: { kind: 'anonymous', verification: 'unverified' }, via: 'none' as never }, 'p=a');
  assert.equal(res.status, 401);
  assert.equal((await call(inst('com.ex.notes'), '')).status, 400);
  assert.equal((await call(inst('com.ex.notes'), 'p=a%20b')).status, 400);
  assert.equal((await call(inst('com.ex.notes'), Array.from({ length: 33 }, (_, i) => `p=x${i}`).join('&'))).status, 400);
  // Not strict (report mode): an undeclared non-enforced permission is auto-granted, as routes decide.
  assert.equal(await permissionHeld({ authorizer }, inst('com.ex.notes').principal as core.Principal, 'network.internet', false), true);
});

test('access report: contract signals are closed labels of installed apps', async () => {
  const report = new AccessReport({ redis: () => null });
  const { bridge } = createObserver({
    deps: {
      authorizer: { authorize: async () => ({ allow: true, reason: 'x' }) },
      mgr: () => ({ registry: { getById: (id: string) => (id === 'com.ex.notes' ? {} : undefined) } }) as never,
      services: () => null, redisReady: () => true, internalSecret: () => 's',
    },
    report,
  });
  bridge.countContract('context-undeclared', 'com.ex.notes');
  bridge.countContract('context-undeclared', 'com.ex.notes');
  bridge.countContract('made-up', 'com.ex.notes');
  bridge.countContract('context-get', 'io.unknown|x');
  const meta = bridge.pending().meta;
  assert.equal(meta['contract|context-undeclared|com.ex.notes'], 2);
  assert.equal(meta['dropped'], 2);
  bridge.dispose();
});

test('contract report: version, declarations, findings, source scan, signals', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'contract-'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'server.ts'), "const k = process.env.OPENAI_API_KEY;\nawait osClient.context.get('OTHER_KEY');\n");
  const on = core.AppManifestSchema.parse({ id: 'com.ex.on', name: 'On', version: '1.0.0', auraContract: 1, context: ['OPENAI_API_KEY'] });
  const off = core.AppManifestSchema.parse({ id: 'com.ex.off', name: 'Off', version: '1.0.0' });
  const r = await contractReport({
    apps: () => [
      { appId: 'com.ex.on', name: 'On', scope: 'user', dir: join(dir, 'none'), sandbox: 'container', manifest: on, instances: [] },
      { appId: 'com.ex.off', name: 'Off', scope: 'user', dir, sandbox: 'proot', manifest: off, instances: [] },
    ],
    contextKeys: async () => ['OPENAI_API_KEY'],
    signals: async () => ({ 'contract|context-undeclared|com.ex.off': 3, 'contract|context-get|com.ex.on': 5 }),
    dataDir: async (apps) => apps.map((a) => ({ appId: a.appId, scope: a.scope, sandbox: a.sandbox, installFolder: { writes: [], truncated: false }, containerLayer: [], home: 'rw' as const, outside: a.appId === 'com.ex.off' })),
  }, { dataDir: true });
  assert.equal(r.contract, 1);
  assert.deepEqual(r.apps.map((a) => [a.appId, a.contract.status, a.readsRawContext]), [['com.ex.off', 'none', true], ['com.ex.on', 'current', false]]);
  const offRow = r.apps[0]!;
  assert.deepEqual(offRow.findings.map((f) => f.code), ['contract-missing']);
  assert.deepEqual(offRow.source.map((f) => [f.line, f.code]), [[1, 'context-raw'], [2, 'context-undeclared']]);
  assert.deepEqual(offRow.signals, { 'context-undeclared': 3 });
  assert.deepEqual(r.apps[1]!.signals, { 'context-get': 5 });
  assert.deepEqual(r.apps[1]!.declares.context, ['OPENAI_API_KEY']);
  assert.deepEqual(r.summary, { apps: 2, onContract: 1, noContract: 1, unknownContract: 0, readsRawContext: 1, undeclaredUse: 1, writesOutsideDataDir: 1 });
  const lean = await contractReport({ apps: () => [], contextKeys: async () => { throw new Error('down'); }, signals: async () => ({}) });
  assert.deepEqual(lean.summary, { apps: 0, onContract: 0, noContract: 0, unknownContract: 0, readsRawContext: 0, undeclaredUse: 0 });
});
