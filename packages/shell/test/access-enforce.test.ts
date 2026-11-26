// Phase 3 stream A: the middleware's access gate (lib/access/enforce.ts), the
// surface gate (server/access-bridge.mjs `surfaceGate`), and the guards that
// moved from the routes into the manifest (D36), per access mode.
//
//   cd packages/shell && npx tsx --test test/access-enforce.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Authorizer } from '@aura/core';
import type { AccessPrincipal, InstancePrincipal } from '@aura/core';
import { GATEWAY_IDENTITY_HEADER } from '@aura/core/host-rules';
import { createDecide } from '../src/lib/access/decide.ts';
import { accessGate, type GateDeps } from '../src/lib/access/enforce.ts';
import { isTrustedOwnerAgent } from '../src/lib/access/identify.ts';
import { createObserver, type ObserverManager } from '../src/lib/access/observer.ts';
import { AccessReport } from '../src/lib/access/report.ts';
import { candidateRules, dispatchedMethods, effectiveRule, handlersOf, manifestRoute } from '../src/lib/access/resolve.ts';
import { ROUTE_ACCESS_MANIFEST as M } from '../src/lib/access/routeManifest.ts';
import { SURFACE_MANIFEST } from '../src/lib/access/surfaceManifest.ts';
import type { AccessLabel, AccessVia, DecideInput, RouteAccessManifest } from '../src/lib/access/types.ts';
import { surfaceGate } from '../server/access-bridge.mjs';
import { enumerateRoutes } from './helpers/enumerateRoutes.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = Symbol.for('aura.access');
const g = globalThis as unknown as Record<symbol, unknown>;

// ── fixtures ────────────────────────────────────────────────────────────────

const anon: AccessPrincipal = { kind: 'anonymous', verification: 'unverified' };
const inst = (appId: string, instanceId = `${appId}-1`, extra: Partial<InstancePrincipal> = {}): InstancePrincipal =>
  ({ kind: 'instance', appId, instanceId, verification: 'verified', ...extra });
const operator: AccessPrincipal = { kind: 'operator', verification: 'verified' };
const owner: AccessPrincipal = { kind: 'user', userId: 'default', role: 'owner', sessionId: 's', verification: 'verified' };
const ownerThrough = (appId: string): AccessPrincipal => ({ ...owner, through: { appId, instanceId: `${appId}-1` } } as AccessPrincipal);

const instances: Record<string, { appId: string; instanceId: string; sandbox?: string; owner?: string }> = {
  'com.acme.notes-1': { appId: 'com.acme.notes', instanceId: 'com.acme.notes-1', sandbox: 'container' },
  'com.other.app-1': { appId: 'com.other.app', instanceId: 'com.other.app-1', sandbox: 'container' },
  'com.aura.terminal-1': { appId: 'com.aura.terminal', instanceId: 'com.aura.terminal-1', sandbox: 'container', owner: 'default' },
  // D69 (stream T): a member's Terminal, and an unclaimed pool member.
  'com.aura.terminal-2': { appId: 'com.aura.terminal', instanceId: 'com.aura.terminal-2', sandbox: 'container', owner: 'u2' },
  'com.aura.terminal-3': { appId: 'com.aura.terminal', instanceId: 'com.aura.terminal-3', sandbox: 'container' },
  'com.aura.settings-1': { appId: 'com.aura.settings', instanceId: 'com.aura.settings-1', sandbox: 'container' },
  'com.aura.aurashelld-1': { appId: 'com.aura.aurashelld', instanceId: 'com.aura.aurashelld-1', sandbox: 'container', owner: 'default' },
};
const scopes: Record<string, string> = {
  'com.acme.notes': 'user', 'com.other.app': 'user', 'com.aura.terminal': 'system', 'com.aura.settings': 'system',
  'com.aura.aurashelld': 'system',
};
const mgr = {
  tokens: { hasNonce: () => false, verify: () => null },
  getInstance: (id: string) => instances[id],
  getInstancesByApp: (appId: string) => Object.values(instances).filter((i) => i.appId === appId),
  getAllInstances: () => Object.values(instances),
  getManifest: (id: string) => (scopes[id] ? { scopeId: scopes[id] } : undefined),
  isTrustedSystemCopy: (id: string) => scopes[id] === 'system',
  registry: { getById: (id: string) => (scopes[id] ? {} : undefined) },
} as unknown as ObserverManager;

// Declared permissions; anything else not enforced by core auto-grants (MVP).
const declared: Record<string, string[]> = {
  'com.acme.notes': ['apps.port', 'apps.mount', 'sidecars.spawn', 'system.kv.os.theme.write'],
  'com.other.app': [],
  'com.aura.terminal': ['apps.mount'],
  'com.aura.settings': [],
  'com.aura.aurashelld': [],
};
const authorizer = new Authorizer({
  grants: { get: async () => null } as never,
  declared: (id: string) => declared[id],
  appScope: (id: string) => scopes[id],
});

/** What a route's own hasPermission check answered (core's MVP auto-grant counts), and what `enforce` answers. */
async function held(appId: string, permission: string): Promise<{ before: string; enforce: string }> {
  const d = await authorizer.authorize(inst(appId), permission);
  const auto = d.reason.includes('MVP auto-grant');
  return { before: d.allow ? 'pass' : '403 access-denied', enforce: d.allow && !auto ? 'pass' : '403 access-denied' };
}

const SECRET = 'internal-secret';

function deps(mode: string, who: { principal: AccessPrincipal; via: AccessVia }): GateDeps {
  return {
    authorizer,
    ownerAgent: (p) => isTrustedOwnerAgent(p, mgr as never),
    mgr: () => mgr,
    services: () => null,
    redisReady: () => false,
    internalSecret: () => SECRET,
    instanceOwner: (id) => instances[id]?.owner ?? null,
    principal: async () => ({ principal: who.principal as never, via: who.via }),
    mode: () => mode,
  };
}

interface Call {
  method?: string;
  path: string;
  route: string;
  params?: Record<string, string>;
  body?: unknown;
  headers?: Record<string, string>;
  peer?: string;
}
function ctx(c: Call) {
  const url = new URL(c.path, 'http://shell');
  const request = new Request(url, {
    method: c.method ?? 'GET',
    headers: { ...(c.body !== undefined ? { 'content-type': 'application/json' } : {}), ...c.headers },
    ...(c.body !== undefined ? { body: JSON.stringify(c.body) } : {}),
  });
  return { request, url, routePattern: c.route, params: c.params ?? {}, clientAddress: c.peer };
}

/** The gate's answer: 'pass' or the refusal's status and error. */
async function gate(mode: string, principal: AccessPrincipal, call: Call, via?: AccessVia): Promise<string> {
  const v: AccessVia = via ?? (principal.kind === 'anonymous' ? 'none'
    : principal.kind === 'operator' ? 'operator-ticket'
      : principal.kind === 'user' ? (('through' in principal && principal.through) ? 'gateway' : 'login-session')
        : 'instance-token');
  const r = await accessGate(ctx(call), deps(mode, { principal, via: v }));
  if (!r.refused) return 'pass';
  const body = await r.refused.json() as { error: string };
  return `${r.refused.status} ${body.error}`;
}

const MODES = ['off', 'report', 'enforce'] as const;
const NON_ENFORCE = ['off', 'report'] as const;

// ── deny by default ─────────────────────────────────────────────────────────

const inventory = enumerateRoutes(path.join(root, 'src/pages'));

test('deny by default: every route and method has a rule, and none is left ambiguous at phase 3', () => {
  for (const r of inventory.routes) {
    for (const m of dispatchedMethods(r.methods)) {
      const rule = effectiveRule(M, { route: r.route, handlers: r.methods }, m);
      assert.ok(rule, `${m} ${r.route} has no rule`);
    }
  }
  const all = [
    ...Object.values(M.groups),
    ...Object.values(M.routes).flatMap((e) => [...Object.values(e.methods ?? {}), ...(e.variants ?? []).map((v) => v.rule)]),
    ...SURFACE_MANIFEST.map((s) => s.rule),
  ];
  for (const rule of all) assert.notEqual(rule!.decision?.phase, 3, rule!.decision?.note);
});

test('deny by default: an unclassified route is refused in enforce, and passes outside it', async () => {
  const call = { path: '/api/nowhere', route: '/api/nowhere' };
  assert.equal(await gate('enforce', owner, call), '403 access-denied');
  assert.equal(await gate('enforce', anon, call), '403 access-denied');
  for (const mode of NON_ENFORCE) assert.equal(await gate(mode, owner, call), 'pass');
});

test('a guard facet never reaches further than its rule: the guard is part of the rule itself', () => {
  for (const [route, e] of Object.entries(M.routes)) {
    for (const v of e.variants ?? []) if (v.match.on === 'body' && v.rule.guard) assert.ok(v.match.read, `${route}#${v.id} is guarded but unread`);
  }
});

// ── per mode, an unguarded owner route ──────────────────────────────────────

test('modes: off and report pass everything without a guard; enforce applies the rule', async () => {
  const call = { path: '/api/scopes', route: '/api/scopes' };
  for (const mode of NON_ENFORCE) {
    const callers: AccessPrincipal[] = [anon, inst('com.other.app'), owner];
    for (const p of callers) assert.equal(await gate(mode, p, call), 'pass', `${mode} ${p.kind}`);
  }
  assert.equal(await gate('enforce', anon, call), '401 unauthenticated');
  assert.equal(await gate('enforce', inst('com.other.app'), call), '403 access-denied');
  assert.equal(await gate('enforce', owner, call), 'pass');
  assert.equal(await gate('enforce', operator, call), 'pass');
  // Public routes stay public.
  assert.equal(await gate('enforce', anon, { method: 'POST', path: '/api/auth/login', route: '/api/auth/login' }), 'pass');
});

test('enforce: the gateway already decided, so the gate only resolves the caller', async () => {
  const call = { path: '/api/scopes', route: '/api/scopes', headers: { [GATEWAY_IDENTITY_HEADER]: 'agw1.x' } };
  const r = await accessGate(ctx(call), deps('enforce', { principal: inst('com.other.app'), via: 'gateway' }));
  assert.equal(r.refused, null);
  assert.equal(r.identity?.principal.kind, 'instance');
});

test('the internal label of this boot passes as the shell itself; a wrong one does not', async () => {
  const call = { path: '/api/apps', route: '/api/apps' };
  assert.equal(await gate('enforce', anon, { ...call, headers: { 'x-aura-internal-service': SECRET } }), 'pass');
  assert.equal(await gate('enforce', anon, { ...call, headers: { 'x-aura-internal-service': 'guess' } }), '401 unauthenticated');
});

test('refusals: a further step is named in error', async () => {
  const fresh: RouteAccessManifest = {
    groups: {}, nonRoutes: {},
    routes: { '/api/x': { methods: { POST: { allow: ['owner'], target: 'system', freshAuth: true } } } },
  };
  const r = await accessGate(ctx({ method: 'POST', path: '/api/x', route: '/api/x' }), deps('enforce', { principal: owner, via: 'login-session' }), fresh);
  assert.equal(r.refused?.status, 403);
  assert.equal((await r.refused!.json() as { error: string }).error, 'needs-fresh-auth', 'D63: HTTP takes the password by default');
  const strict = await accessGate(ctx({ method: 'POST', path: '/api/x', route: '/api/x' }),
    { ...deps('enforce', { principal: owner, via: 'login-session' }), freshAuthRequiresHttps: async () => true }, fresh);
  assert.equal((await strict.refused!.json() as { error: string }).error, 'needs-operator', 'HTTPS required: the host operator');
});

// ── D29: trusted owner agents ───────────────────────────────────────────────

test('D29: the system Terminal by its own token acts for the owner; not through the gateway, nor its sidecar, nor on the login session', async () => {
  const term = inst('com.aura.terminal', 'com.aura.terminal-1', { userId: 'default' });
  const enabled = { method: 'POST', path: '/api/admin/apps/enabled', route: '/api/admin/apps/enabled', body: { appId: 'com.acme.notes', enabled: false } };
  assert.equal(await gate('enforce', term, enabled), 'pass', '`aura disable app` from the Terminal');
  assert.equal(await gate('enforce', term, enabled, 'gateway'), '403 access-denied');
  assert.equal(await gate('enforce', inst('com.aura.terminal', 'com.aura.terminal-1', { sidecar: 'x' }), enabled), '403 access-denied');
  assert.equal(await gate('enforce', inst('com.other.app'), enabled), '403 access-denied');
  assert.equal(await gate('enforce', term, { method: 'POST', path: '/api/auth/password', route: '/api/auth/password' }), '403 access-denied');
  // D50: the owner's management routes let the Terminal through; the route asks the owner's approval.
  assert.equal(await gate('enforce', term, { path: '/api/admin/grants', route: '/api/admin/grants' }), 'pass');
});

test('a same-id user copy of the Terminal is an ordinary app, never the owner\'s agent (Q6)', async () => {
  const term = inst('com.aura.terminal', 'com.aura.terminal-1', { userId: 'default' });
  const enabled = { method: 'POST', path: '/api/admin/apps/enabled', route: '/api/admin/apps/enabled', body: { appId: 'com.acme.notes', enabled: false } };
  const install = { method: 'POST', path: '/api/nexus/install', route: '/api/nexus/install', body: {} };
  const activate = { method: 'POST', path: '/api/apps/com.acme.notes/activate', route: '/api/apps/[id]/activate', params: { id: 'com.acme.notes' }, body: {} };
  for (const call of [enabled, install, activate]) assert.equal(await gate('enforce', term, call), 'pass', `system copy ${call.path}`);
  scopes['com.aura.terminal'] = 'user';
  try {
    for (const call of [enabled, install, activate]) assert.equal(await gate('enforce', term, call), '403 access-denied', `same-id copy ${call.path}`);
  } finally {
    scopes['com.aura.terminal'] = 'system';
  }
});

test('D29: TerminalX lists the Terminal\'s instances with its terminal.sessions.list grant; other apps\' instances stay the owner\'s', async () => {
  const route = '/api/apps/[id]/instances';
  const of = (id: string) => ({ path: `/api/apps/${id}/instances`, route, params: { id } });
  const granted: Record<string, string[]> = { ...declared, 'com.acme.notes': [...declared['com.acme.notes']!, 'terminal.sessions.list'] };
  const tx = new Authorizer({
    grants: { get: async (s: { id: string }, p: string) => (s.id === 'com.acme.notes' && p === 'terminal.sessions.list' ? { appScope: 'user' } : null) } as never,
    declared: (id: string) => granted[id],
    appScope: (id: string) => scopes[id],
  });
  const asTx = async (call: ReturnType<typeof of>) => {
    const r = await accessGate(ctx(call), { ...deps('enforce', { principal: inst('com.acme.notes'), via: 'instance-token' }), authorizer: tx });
    return r.refused ? `${r.refused.status} ${(await r.refused.json() as { error: string }).error}` : 'pass';
  };
  assert.equal(await asTx(of('com.aura.terminal')), 'pass');
  assert.equal(await asTx(of('com.other.app')), '403 access-denied', 'the grant names the Terminal only');
  assert.equal(await gate('enforce', inst('com.other.app'), of('com.aura.terminal')), '403 access-denied', 'no grant');
  assert.equal(await gate('enforce', anon, of('com.aura.terminal')), '401 unauthenticated');
  assert.equal(await gate('enforce', owner, of('com.aura.terminal')), 'pass');
  assert.equal(await gate('enforce', owner, of('com.other.app')), 'pass');
  const info = { route, handlers: handlersOf(M, route) };
  const facts = { query: new URLSearchParams(), namespace: null };
  assert.deepEqual(candidateRules(M, info, 'GET', { ...facts, params: { id: 'com.aura.terminal' } }).map((c) => c.variant), ['terminal-instances']);
  assert.deepEqual(candidateRules(M, info, 'GET', { ...facts, params: { id: 'com.aura.terminalx' } }).map((c) => c.variant), [null]);
  assert.deepEqual(candidateRules(M, info, 'GET', facts).map((c) => c.variant), [null], 'no params: no param variant');
});

// ── D89 B6: no address is a caller ──────────────────────────────────────────

test('B6: a tokenless call is unauthenticated whatever its peer; any app by its own token reaches another app\'s upstream; a gateway call and an API key do not', async () => {
  const proxy = { path: '/api/proxy/io.x.excalidraw/mcp', route: '/api/proxy/[id]/[...path]', params: { id: 'io.x.excalidraw', path: 'mcp' } };
  for (const peer of ['::ffff:172.20.0.7', '172.20.0.8', '127.0.0.1', '10.9.9.9']) {
    assert.equal(await gate('enforce', anon, { ...proxy, peer }), '401 unauthenticated', `from ${peer}`);
  }
  assert.equal(await gate('enforce', inst('com.acme.notes'), proxy), 'pass', 'an app by its token');
  assert.equal(await gate('enforce', inst('com.acme.notes', 'com.acme.notes-1', { sidecar: 'db' }), proxy), 'pass', 'an inheritIdentity sidecar by its token');
  assert.equal(await gate('enforce', inst('com.other.app'), proxy, 'gateway'), '403 access-denied', 'a gateway call');
  assert.equal(await gate('enforce', { kind: 'apiKey', keyId: 'k', name: 'n', scopes: [], verification: 'verified' } as AccessPrincipal, proxy, 'api-key'), '403 access-denied', 'an API key');
  assert.equal(await gate('enforce', owner, proxy), 'pass');
  assert.equal(await gate('enforce', anon, { path: '/api/scopes', route: '/api/scopes', peer: '172.20.0.7' }), '401 unauthenticated');
  // The documented tour sends the token now: `curl -H "Authorization: Bearer $AURA_INSTANCE_TOKEN" $OS_API_BASE/api/interfaces`.
  assert.equal(await gate('enforce', anon, { path: '/api/interfaces', route: '/api/interfaces', peer: '172.20.0.7' }), '401 unauthenticated');
  assert.equal(await gate('enforce', inst('com.aura.terminal', 'com.aura.terminal-1', { userId: 'default' }), { path: '/api/interfaces', route: '/api/interfaces' }), 'pass');
  // No rule carries the D28 flag any more, and no surface.
  for (const [route, entry] of Object.entries(M.routes)) {
    for (const r of [...Object.values(entry.methods ?? {}), ...(entry.variants ?? []).map((v) => v.rule)]) {
      assert.ok(!('networkCaller' in (r as object)), `${route}: no networkCaller`);
    }
  }
  for (const sfc of SURFACE_MANIFEST) assert.ok(!('networkCaller' in sfc.rule), `${sfc.id}: no networkCaller`);
  const src = fs.readFileSync(path.join(root, 'src/lib/access/identify.ts'), 'utf8');
  assert.ok(!/createNetworkIdentity|liveNetworkIdentity/.test(src), 'the D28 table is gone');
});

// ── D69 (stream T): a Terminal instance is one user's session host ──────────

test('D69: a Terminal instance\'s upstream only for its own user: not the owner into a member\'s, not a member into the owner\'s, nobody into a pool member', async () => {
  const proxy = (id: string, p = 'mcp/terminal') =>
    ({ method: 'POST', path: `/api/proxy/${id}/${p}`, route: '/api/proxy/[id]/[...path]', params: { id, path: p } });
  const ownerTerm = inst('com.aura.terminal', 'com.aura.terminal-1', { userId: 'default' });
  const memberTerm = inst('com.aura.terminal', 'com.aura.terminal-2', { userId: 'u2' });
  const member: AccessPrincipal = { kind: 'user', userId: 'u2', role: 'member', sessionId: 's2', verification: 'verified' };
  // The owner and the owner's System Terminal: the owner's instance, never the member's.
  assert.equal(await gate('enforce', owner, proxy('com.aura.terminal-1')), 'pass');
  assert.equal(await gate('enforce', owner, proxy('com.aura.terminal-2')), '403 access-denied', 'the owner into a member\'s sessions');
  assert.equal(await gate('enforce', operator, proxy('com.aura.terminal-2')), '403 access-denied', 'nor the host operator');
  assert.equal(await gate('enforce', ownerTerm, proxy('com.aura.terminal-1', 'api/sessions/input')), 'pass');
  assert.equal(await gate('enforce', ownerTerm, proxy('com.aura.terminal-2', 'api/sessions/input')), '403 access-denied');
  // A member's Terminal reaches its own user's instances (the session router), never the owner's, nor aurashelld.
  assert.equal(await gate('enforce', memberTerm, proxy('com.aura.terminal-2')), 'pass', 'its own sessions (own-session)');
  assert.equal(await gate('enforce', memberTerm, proxy('com.aura.terminal')), 'pass', 'bare id: the route picks the member\'s own');
  assert.equal(await gate('enforce', memberTerm, proxy('com.aura.terminal-1')), '403 access-denied', 'the owner\'s sessions');
  assert.equal(await gate('enforce', memberTerm, proxy('com.aura.aurashelld', 'api/mcp/shell')), '403 access-denied', 'the owner\'s shell MCP');
  assert.equal(await gate('enforce', member, proxy('com.aura.terminal-2')), '403 access-denied', 'a member\'s login holds no proxy level');
  // An unclaimed pool member belongs to nobody.
  for (const p of [owner, operator, ownerTerm, memberTerm]) {
    assert.equal(await gate('enforce', p, proxy('com.aura.terminal-3')), '403 access-denied', `${p.kind} into a pool member`);
  }
  // Another app's token never reaches a Terminal, whoever it acts for.
  assert.equal(await gate('enforce', inst('com.acme.notes', 'com.acme.notes-1', { userId: 'u2' }), proxy('com.aura.terminal-2')), '403 access-denied');

  // The upgrade surfaces decide the same on the instance the shell resolved (WS proxy, App Host).
  const d = deps('enforce', { principal: anon, via: 'none' });
  const { bridge } = createObserver({ deps: d, report: new AccessReport({ redis: () => null }) });
  const ws = async (subject: string, p: AccessPrincipal, via: AccessVia, instanceId: string) => (await bridge.decideSurface({
    subject, method: 'UPGRADE', status: 0, appId: 'com.aura.terminal', instanceId,
    identity: { verified: { principal: p, via }, referer: null, instanceId: null, peer: null },
  })).outcome;
  assert.equal(await ws('terminal-pty', owner, 'login-session', 'com.aura.terminal-1'), 'allow');
  assert.equal(await ws('terminal-pty', owner, 'login-session', 'com.aura.terminal-2'), 'deny');
  assert.equal(await ws('terminal-pty', ownerTerm, 'instance-token', 'com.aura.terminal-2'), 'deny');
  assert.equal(await ws('app-hosts', { ...owner, through: { appId: 'com.aura.terminal', instanceId: 'com.aura.terminal-2' } } as AccessPrincipal, 'app-host', 'com.aura.terminal-2'), 'deny',
    'an App Host session of another user');
  assert.equal(await ws('app-hosts', { ...owner, through: { appId: 'com.aura.terminal', instanceId: 'com.aura.terminal-1' } } as AccessPrincipal, 'app-host', 'com.aura.terminal-1'), 'allow');
  bridge.dispose();
});

// ── guard classes: what the routes checked themselves, in every mode ────────

test('guard ownerManages (D50) → the owner, the operator and the System Terminal reach the owner routes in every mode; other apps never', async () => {
  const grants = { path: '/api/admin/grants', route: '/api/admin/grants' };
  const term = inst('com.aura.terminal', 'com.aura.terminal-1', { userId: 'default' });
  const callers: AccessPrincipal[] = [operator, owner, ownerThrough('com.aura.settings'), term];
  for (const mode of MODES) {
    for (const p of callers) {
      assert.equal(await gate(mode, p, grants), 'pass', `${mode} ${p.kind}`);
    }
    assert.equal(await gate(mode, anon, grants), '401 unauthenticated', mode);
    assert.equal(await gate(mode, inst('com.acme.notes'), grants), '403 access-denied', `${mode} another app`);
  }
  // A retired admin session is no credential at all: the resolver refuses it before any rule (principal-resolver tests).
});

test('guard ownerManages (conditional) → only the body variant that needed it', async () => {
  const origin = (mode: string) => ({ method: 'POST', path: '/api/admin/app-origin', route: '/api/admin/app-origin', body: { mode } });
  const clone = (force: boolean) => ({ method: 'POST', path: '/api/admin/clone-app', route: '/api/admin/clone-app', body: { sourceAppId: 'a', force } });
  const term = inst('com.aura.terminal', 'com.aura.terminal-1', { userId: 'default' });
  for (const mode of NON_ENFORCE) {
    assert.equal(await gate(mode, anon, origin('assign')), 'pass');
    assert.equal(await gate(mode, anon, origin('reassign')), '401 unauthenticated');
    assert.equal(await gate(mode, operator, origin('reassign')), 'pass');
    assert.equal(await gate(mode, term, clone(false)), 'pass');
    assert.equal(await gate(mode, term, clone(true)), 'pass', 'the route then asks the owner');
    assert.equal(await gate(mode, inst('com.acme.notes'), clone(true)), '403 access-denied');
  }
});

test('guard sidecarGate → the instance\'s own token and its app\'s permission, in every mode', async () => {
  const spawn = (id: string) => ({ method: 'POST', path: `/api/instances/${id}/sidecars`, route: '/api/instances/[instanceId]/sidecars', params: { instanceId: id }, body: { template: 't' } });
  for (const mode of MODES) {
    assert.equal(await gate(mode, inst('com.acme.notes'), spawn('com.acme.notes-1')), 'pass', mode);
    assert.equal(await gate(mode, inst('com.acme.notes', 'com.acme.notes-1', { sidecar: 'db' }), spawn('com.acme.notes-1')), 'pass', 'its own sidecar');
    assert.equal(await gate(mode, inst('com.other.app'), spawn('com.acme.notes-1')), '403 access-denied', 'another instance');
    assert.equal(await gate(mode, inst('com.other.app'), spawn('com.other.app-1')), '403 access-denied', 'no sidecars.spawn');
    assert.equal(await gate(mode, inst('com.acme.notes'), spawn('com.acme.notes-1'), 'gateway'), '403 access-denied', 'no token through the gateway');
    assert.equal(await gate(mode, operator, spawn('com.acme.notes-1')), '403 access-denied');
    assert.equal(await gate(mode, anon, spawn('com.acme.notes-1')), '401 unauthenticated');
  }
  // `with-tools` is read from the body: it also needs sidecars.tools, which notes lacks.
  const tools = { ...spawn('com.acme.notes-1'), body: { template: 't', tools: ['git'] } };
  assert.equal(await gate('report', inst('com.acme.notes'), tools), '403 access-denied');
});

test('Astro\'s lowercased routePattern still finds the manifest rule: the guard applies and the route gets its caller', async () => {
  // Astro hands `/api/instances/[instanceid]/sidecars`; the manifest writes `[instanceId]`.
  const lower = { method: 'POST', path: '/api/instances/com.acme.notes-1/sidecars', route: '/api/instances/[instanceid]/sidecars', params: { instanceId: 'com.acme.notes-1' }, body: { template: 't' } };
  assert.equal(manifestRoute(M, lower.route), '/api/instances/[instanceId]/sidecars');
  assert.equal(manifestRoute(M, '/api/not/listed'), '/api/not/listed');
  for (const mode of MODES) {
    const own = await accessGate(ctx(lower), deps(mode, { principal: inst('com.acme.notes'), via: 'instance-token' }));
    assert.equal(own.refused, null, mode);
    assert.equal((own.identity?.principal as { instanceId?: string } | undefined)?.instanceId, 'com.acme.notes-1', `${mode}: the route reads its caller`);
    assert.equal(await gate(mode, inst('com.other.app'), lower), '403 access-denied', `${mode}: another instance`);
  }
});

test('guard hasPermission (target) → ports and mounts need the target app\'s permission from anyone, in every mode', async () => {
  const port = (id: string) => ({ method: 'POST', path: `/api/instances/${id}/ports`, route: '/api/instances/[instanceId]/ports', params: { instanceId: id }, body: { kind: 'into', sourcePort: 80 } });
  const unmount = (id: string) => ({ method: 'DELETE', path: `/api/instances/${id}/mounts/x`, route: '/api/instances/[instanceId]/mounts/[mountId]', params: { instanceId: id, mountId: 'x' } });
  for (const mode of NON_ENFORCE) {
    assert.equal(await gate(mode, anon, port('com.acme.notes-1')), 'pass', 'anonymous, as before');
    assert.equal(await gate(mode, anon, port('com.other.app-1')), '403 access-denied');
    assert.equal(await gate(mode, owner, unmount('com.other.app-1')), '403 access-denied');
    assert.equal(await gate(mode, anon, port('com.gone-1')), 'pass', 'a missing instance: the route answers 404');
  }
  assert.equal(await gate('enforce', anon, port('com.acme.notes-1')), '401 unauthenticated');
  assert.equal(await gate('enforce', inst('com.acme.notes'), port('com.acme.notes-1')), 'pass');
  assert.equal(await gate('enforce', inst('com.other.app'), port('com.acme.notes-1')), '403 access-denied');
  // A host publish is the owner's call in enforce.
  const host = { ...port('com.acme.notes-1'), body: { kind: 'host', sourcePort: 80, bindAddr: '0.0.0.0' } };
  assert.equal(await gate('enforce', inst('com.acme.notes'), host), '403 access-denied');
  assert.equal(await gate('enforce', inst('com.aura.terminal', 'com.aura.terminal-1', { userId: 'default' }), host), 'pass');
});

test('guard Referer trust (kv) → the KV checks apply to verified app callers in every mode; anyone else is the old `system`', async () => {
  const kv = (p: string, method = 'GET') => ({ method, path: `/api/kv/${p}`, route: '/api/kv/[...path]', params: { path: p }, ...(method === 'PUT' ? { body: { value: 1 } } : {}) });
  for (const mode of NON_ENFORCE) {
    assert.equal(await gate(mode, inst('com.acme.notes'), kv('app/com.acme.notes/k')), 'pass');
    assert.equal(await gate(mode, inst('com.acme.notes'), kv('app/com.other.app/k')), '403 access-denied');
    assert.equal(await gate(mode, ownerThrough('com.aura.settings'), kv('app/com.other.app/k')), '403 access-denied', 'judged as Settings, as its Referer was');
    assert.equal(await gate(mode, anon, kv('app/com.other.app/k')), 'pass', 'no Referer was `system` before too');
    assert.equal(await gate(mode, owner, kv('app/com.other.app/k')), 'pass');
    // os writes: what core's Authorizer answered the route before (an auto-grant counts).
    assert.equal(await gate(mode, inst('com.other.app'), kv('os/workspaces', 'PUT')), (await held('com.other.app', 'system.kv.os.workspaces.write')).before);
  }
  assert.equal(await gate('enforce', inst('com.other.app'), kv('os/workspaces', 'PUT')), '403 access-denied', 'undeclared: no auto-grant in enforce');
  assert.equal(await gate('enforce', inst('com.acme.notes'), kv('os/theme', 'PUT')), (await held('com.acme.notes', 'system.kv.os.theme.write')).enforce);
  assert.equal(await gate('enforce', ownerThrough('com.aura.settings'), kv('os/workspaces', 'PUT')), 'pass');
  assert.equal(await gate('enforce', anon, kv('os/theme')), '401 unauthenticated');
});

test('guard Referer trust (data, custom interfaces) → app callers only, and the provider-less request is the route\'s 404', async () => {
  const custom = { method: 'POST', path: '/api/interfaces/custom', route: '/api/interfaces/custom', body: { name: 'x' } };
  for (const mode of NON_ENFORCE) {
    assert.equal(await gate(mode, inst('com.other.app'), custom), (await held('com.other.app', 'system.kv.os.interfaces.write')).before);
    assert.equal(await gate(mode, anon, custom), 'pass');
    const data = { path: '/api/data/nobody/x', route: '/api/data/[authority]/[...path]', params: { authority: 'nobody', path: 'x' } };
    assert.equal(await gate(mode, inst('com.other.app'), data), 'pass');
  }
  assert.equal(await gate('enforce', inst('com.other.app'), custom), '403 access-denied');
  assert.equal(await gate('enforce', owner, custom), 'pass');
});

test('guard identifyInstance hints → interface writes need a verified instance, in every mode', async () => {
  const reg = { method: 'POST', path: '/api/interfaces', route: '/api/interfaces', body: { name: 'x' } };
  const unreg = { method: 'DELETE', path: '/api/interfaces/x', route: '/api/interfaces/[name]', params: { name: 'x' } };
  for (const mode of MODES) {
    for (const c of [reg, unreg]) {
      assert.equal(await gate(mode, inst('com.acme.notes'), c), 'pass');
      assert.equal(await gate(mode, ownerThrough('com.acme.notes'), c), 'pass', 'the app a user acts through');
      assert.equal(await gate(mode, anon, { ...c, headers: { 'x-aura-instance-id': 'com.acme.notes-1' } }), '401 unauthenticated', 'a hint is nobody');
    }
  }
});

// ── decide(): the ENFORCED_PERMISSIONS fold ─────────────────────────────────

test('decide: an auto-granted permission counts outside enforce only (strict)', async () => {
  // Not `system.kv.os.*`: stream C made those privileged (a grant, never an auto-grant).
  const d = createDecide({ authorizer });
  const input = (strict: boolean): DecideInput => ({
    principal: inst('com.other.app'),
    action: { surface: 'api', subject: '/api/x' as AccessLabel, method: 'POST', variant: null, rule: { allow: ['app-permission'], target: 'system', permissions: ['apps.zzz'] } },
    resource: { target: 'system' }, transport: 'http', auth: { fresh: false, via: 'instance-token' }, strict,
    accessProfile: 'open', systemMode: 'normal', deployment: 'private',
  });
  assert.deepEqual(await d(input(false)), { outcome: 'allow', reason: 'auto-granted' });
  assert.deepEqual(await d(input(true)), { outcome: 'deny', reason: 'missing-permission' });
});

// ── surfaces ────────────────────────────────────────────────────────────────

test('Phase 5 X: exec and logs → the owner, the System Terminal and the instance itself, in every mode', async () => {
  const call = (route: 'exec' | 'logs', id: string) => ({
    method: route === 'exec' ? 'POST' : 'GET', path: `/api/instances/${id}/${route}`, route: `/api/instances/[instanceId]/${route}`,
    params: { instanceId: id }, ...(route === 'exec' ? { body: { cmd: ['id'] } } : {}),
  });
  for (const mode of MODES) {
    for (const route of ['exec', 'logs'] as const) {
      assert.equal(await gate(mode, owner, call(route, 'com.acme.notes-1')), 'pass', `${mode} ${route} owner`);
      assert.equal(await gate(mode, operator, call(route, 'com.acme.notes-1')), 'pass', `${mode} ${route} operator`);
      assert.equal(await gate(mode, inst('com.aura.terminal'), call(route, 'com.acme.notes-1')), 'pass', `${mode} ${route} System Terminal (D29)`);
      assert.equal(await gate(mode, inst('com.acme.notes'), call(route, 'com.acme.notes-1')), 'pass', `${mode} ${route} itself`);
      assert.equal(await gate(mode, inst('com.other.app'), call(route, 'com.acme.notes-1')), '403 access-denied', `${mode} ${route} another app`);
      assert.equal(await gate(mode, anon, call(route, 'com.acme.notes-1')), '401 unauthenticated', `${mode} ${route} anonymous`);
    }
  }
});

test('Phase 5 X: the exec-bridge surface decides on the target instance', async () => {
  const d = deps('report', { principal: anon, via: 'none' });
  const { bridge } = createObserver({ deps: d, report: new AccessReport({ redis: () => null }) });
  const as = (principal: AccessPrincipal, via: AccessVia) => ({ verified: { principal, via }, referer: null, instanceId: null, peer: '172.20.0.8' });
  const decide = async (principal: AccessPrincipal, via: AccessVia, instanceId: string | null) =>
    bridge.decideSurface({ subject: 'exec-bridge', method: 'UPGRADE', status: 0, instanceId, identity: as(principal, via) });
  assert.deepEqual(await decide(owner, 'login-session', 'com.acme.notes-1'), { outcome: 'allow', reason: 'owner' });
  assert.deepEqual(await decide(inst('com.aura.terminal'), 'instance-token', 'com.acme.notes-1'), { outcome: 'allow', reason: 'owner' });
  assert.deepEqual(await decide(inst('com.acme.notes'), 'instance-token', 'com.acme.notes-1'), { outcome: 'allow', reason: 'own-instance' });
  assert.equal((await decide(inst('com.other.app'), 'instance-token', 'com.acme.notes-1')).outcome, 'deny', 'another instance');
  assert.equal((await decide(anon, 'none', 'com.acme.notes-1')).outcome, 'deny', 'anonymous, even from an app container address');
  assert.equal((await decide(owner, 'login-session', 'no-such-1')).outcome, 'deny', 'an unknown instance');
  assert.equal((await decide(inst('com.acme.notes'), 'instance-token', null)).outcome, 'deny', 'no target: not its own');
  bridge.dispose();
});

test('surfaceGate: yes outside enforce; in enforce the observer decides, and no observer is a no', async () => {
  const prev = process.env['AURA_ACCESS_ENFORCE'];
  const prevBridge = g[BRIDGE];
  const obs = { subject: 'ws-proxy', method: 'UPGRADE', identity: null };
  try {
    delete g[BRIDGE];
    for (const mode of ['off', 'report']) {
      process.env['AURA_ACCESS_ENFORCE'] = mode;
      assert.equal(await surfaceGate(obs), true, mode);
    }
    process.env['AURA_ACCESS_ENFORCE'] = 'enforce';
    assert.equal(await surfaceGate(obs), false, 'fails closed');
    g[BRIDGE] = { decideSurface: async () => ({ outcome: 'allow', reason: 'owner' }) };
    assert.equal(await surfaceGate(obs), true);
    g[BRIDGE] = { decideSurface: async () => ({ outcome: 'deny', reason: 'unauthenticated' }) };
    assert.equal(await surfaceGate(obs), false);
    g[BRIDGE] = { decideSurface: async () => { throw new Error('x'); } };
    assert.equal(await surfaceGate(obs), false);
  } finally {
    if (prev === undefined) delete process.env['AURA_ACCESS_ENFORCE']; else process.env['AURA_ACCESS_ENFORCE'] = prev;
    if (prevBridge === undefined) delete g[BRIDGE]; else g[BRIDGE] = prevBridge;
  }
});

test('surfaces decide on their manifest rule: owner yes, anonymous no, an app on the WS proxy by its token only (D89 B6)', async () => {
  const d = deps('enforce', { principal: anon, via: 'none' });
  const { bridge } = createObserver({ deps: d, report: new AccessReport({ redis: () => null }) });
  const as = (principal: AccessPrincipal, via: AccessVia, peer: string | null = null) =>
    ({ verified: { principal, via }, referer: null, instanceId: null, peer });
  const decision = async (subject: string, identity: ReturnType<typeof as>) =>
    (await bridge.decideSurface({ subject, method: 'UPGRADE', status: 0, identity })).outcome;
  for (const subject of ['ws-proxy', 'socketio-os-events', 'socketio-kv', 'sse-mux', 'app-hosts', 'vite-dev-server', 'terminal-pty']) {
    assert.equal(await decision(subject, as(owner, 'login-session')), 'allow', subject);
    assert.equal(await decision(subject, as(anon, 'none')), 'deny', subject);
    assert.equal(await decision(subject, as(inst('com.other.app'), 'instance-token')), subject === 'ws-proxy' ? 'allow' : 'deny', subject);
  }
  assert.equal(await decision('sse-mux', as(ownerThrough('com.acme.notes'), 'app-host')), 'allow');
  assert.equal(await decision('ws-proxy', as(anon, 'none', '172.20.0.7')), 'deny', 'an address is no caller');
  assert.equal(await decision('socketio-os-events', as(anon, 'none', '172.20.0.7')), 'deny');
  assert.equal((await bridge.decideSurface({ subject: 'no-such-surface', method: 'UPGRADE', status: 0, identity: null })).outcome, 'deny');
  bridge.dispose();
});

test('every .mjs surface asks the one surface gate', () => {
  const src = (f: string) => fs.readFileSync(path.join(root, 'server', f), 'utf8');
  const attach = src('attach.mjs');
  assert.match(attach, /surfaceGate\(\{ subject: subject\(\)/, 'ws-proxy and terminal-pty');
  assert.match(attach, /subject: 'socketio-os-events'[^\n]*identity \}\),\n\s*surfaceGate\(\{ subject: 'socketio-kv'/);
  const hosts = src('app-hosts.mjs');
  // I.2: both through hostGate, which decides a member's session on the slot's instance.
  assert.match(hosts, /async function hostGate\(route, req, subject, method, t = null\) \{[\s\S]*?return surfaceGate\(\{\n\s*subject, method,/);
  assert.match(hosts, /hostGate\(route, req, 'app-hosts', req\.method\)/);
  assert.match(hosts, /hostGate\(route, req, mux \? 'sse-mux' : 'app-hosts', 'UPGRADE'\)/);
  assert.match(hosts, /surfaceGate\(\{ subject: 'vite-dev-server'/);
  assert.match(src('exec-bridge.mjs'), /deps\.decide\(\{ subject: SUBJECT, method: 'UPGRADE', instanceId, identity \}\)/, 'the exec bridge decides in every mode');
});

test('no route keeps its own guard (D36)', () => {
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const files = [...walk(path.join(root, 'src')), ...walk(path.join(root, 'server'))].filter((f) => /\.(ts|mjs|astro)$/.test(f));
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    for (const gone of ['requireAdmin(', 'sidecarGate(', 'requireInstanceToken(', 'authenticateLegacy', 'identifyInstance(', 'checkCustomWrite(', 'refererAppId(', 'PHASE3-ENFORCE', 'permissions.hasPermission(']) {
      if (gone === 'permissions.hasPermission(' && f.endsWith('manifest-edit.ts')) continue;  // a hint in its answer, not a guard
      assert.ok(!text.includes(gone), `${path.relative(root, f)}: ${gone}`);
    }
  }
});

test('candidate rules read the body only for variants marked read', () => {
  const info = { route: '/api/admin/app-origin', handlers: handlersOf(M, '/api/admin/app-origin') };
  const unread = candidateRules(M, info, 'POST', { query: new URLSearchParams(), namespace: null });
  assert.equal(unread.length, 2, 'unread: both candidates');
  const read = candidateRules(M, info, 'POST', { query: new URLSearchParams(), namespace: null, body: { mode: 'assign' } });
  assert.deepEqual(read.map((c) => c.variant), [null]);
});

// ── Phase 3a review fixes ───────────────────────────────────────────────────

test('H1: a proxy path the upstream would read as another is refused; the Terminal PTY is classified on the upstream path', async () => {
  const { plainProxyPath } = await import('../server/host-policy.mjs');
  const { wsProxySubject } = await import('../server/attach.mjs');
  for (const p of ['com.aura.terminal/ws', 'com.aura.docs/mcp', 'x/api/a.b/c..d', 'x/.well-known/y']) assert.equal(plainProxyPath(p), true, p);
  for (const p of ['com.aura.terminal/./ws', 'com.aura.terminal/a/../ws', 'com.aura.terminal/%2e/ws', 'com.aura.terminal/a/%2E%2E/ws',
    'com.aura.terminal/.%2e/ws', 'com.aura.terminal/a%2f..%2fws', 'com.aura.terminal/a%5C..%5Cws', 'com.aura.terminal/a\\..\\ws', '../ws', 'x/..']) {
    assert.equal(plainProxyPath(p), false, p);
  }
  assert.equal(wsProxySubject('com.aura.terminal', 'ws'), 'terminal-pty');
  assert.equal(wsProxySubject('com.aura.terminal', 'ws/'), 'ws-proxy', 'the Terminal answers /ws only');
  assert.equal(wsProxySubject('com.acme.notes', 'ws'), 'ws-proxy');
  const src = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');
  assert.match(src('server/attach.mjs'), /if \(!plainProxyPath\(`\$\{instanceId\}\/\$\{proxyPath\}`\)\) \{[^}]*400 Bad Request/);
  assert.match(src('src/pages/api/proxy/[id]/[...path].ts'), /if \(!plainProxyPath\(new URL\(request\.url\)\.pathname\)\) return jsonError\(400/);
});

test('H2, D89 B3/B6: no address reaches an owner agent upstream, not even the System Terminal\'s; its token and the owner do', async () => {
  const term = inst('com.aura.terminal', 'com.aura.terminal-1', { userId: 'default' });
  const proxy = (id: string, peer?: string, p = 'mcp') =>
    ({ method: 'POST', path: `/api/proxy/${id}/${p}`, route: '/api/proxy/[id]/[...path]', params: { id, path: p }, ...(peer ? { peer } : {}) });
  for (const target of ['com.aura.terminal', 'com.aura.terminal-1', 'com.aura.aurashelld']) {
    assert.equal(await gate('enforce', anon, proxy(target, '172.20.0.8')), '401 unauthenticated', `notes → ${target}`);
    assert.equal(await gate('enforce', anon, proxy(target, '172.20.0.8', 'api/sessions/input')), '401 unauthenticated');
    assert.equal(await gate('enforce', anon, proxy(target, '172.20.0.7')), '401 unauthenticated', `System Terminal's address alone → ${target}`);
    assert.equal(await gate('enforce', anon, proxy(target, '172.20.0.7', 'api/sessions/events')), '401 unauthenticated', 'a tokenless hook post');
    assert.equal(await gate('enforce', term, proxy(target)), 'pass', `System Terminal by its token → ${target}`);
    assert.equal(await gate('enforce', inst('com.acme.notes'), proxy(target)), '403 access-denied', `an app's token → ${target}`);
    assert.equal(await gate('enforce', owner, proxy(target)), 'pass', `owner → ${target}`);
    assert.equal(await gate('enforce', anon, proxy(target)), '401 unauthenticated');
  }
  assert.equal(await gate('enforce', anon, proxy('com.other.app', '172.20.0.8')), '401 unauthenticated', 'B6: app-to-app MCP needs the caller\'s token');
  assert.equal(await gate('enforce', inst('com.acme.notes'), proxy('com.other.app')), 'pass', 'app-to-app MCP by token');
  assert.equal(await gate('enforce', term, proxy('com.acme.notes')), 'pass', 'the Terminal\'s agents reach app MCPs by its token');

  // The upgrade surface decides the same, by the app it resolved.
  const d = deps('enforce', { principal: anon, via: 'none' });
  const { bridge } = createObserver({ deps: d, report: new AccessReport({ redis: () => null }) });
  const ws = async (subject: string, appId: string, peer: string, p: AccessPrincipal = anon, via: AccessVia = 'none') => (await bridge.decideSurface({
    subject, method: 'UPGRADE', status: 0, appId,
    identity: { verified: { principal: p, via }, referer: null, instanceId: null, peer },
  })).outcome;
  assert.equal(await ws('ws-proxy', 'com.aura.terminal', '172.20.0.8'), 'deny');
  assert.equal(await ws('ws-proxy', 'com.aura.terminal', '172.20.0.7'), 'deny', 'the System Terminal\'s address alone');
  assert.equal(await ws('ws-proxy', 'com.aura.aurashelld', '172.20.0.7'), 'deny');
  assert.equal(await ws('ws-proxy', 'com.acme.notes', '172.20.0.7'), 'deny', 'B6: no address caller');
  assert.equal(await ws('ws-proxy', 'com.acme.notes', '172.20.0.7', term, 'instance-token'), 'allow');
  assert.equal(await ws('ws-proxy', 'com.other.app', '172.20.0.8', inst('com.acme.notes'), 'instance-token'), 'allow');
  assert.equal(await ws('ws-proxy', 'com.aura.aurashelld', '172.20.0.8', inst('com.acme.notes'), 'instance-token'), 'deny');
  bridge.dispose();
});

test('M2, L1: the must-close routes hold their rule in every mode: a tokenless caller is refused even in report', async () => {
  const calls = [
    { path: '/api/apps/events', route: '/api/apps/events' },
    { method: 'POST', path: '/api/intents/start', route: '/api/intents/start', body: { action: 'VIEW', appId: 'com.aura.settings' } },
    { path: '/api/terminal/sessions', route: '/api/terminal/sessions' },
    { method: 'DELETE', path: '/api/terminal/sessions?id=s1', route: '/api/terminal/sessions' },
    { path: '/api/terminal/sessions/screen?id=s1', route: '/api/terminal/sessions/screen' },
    { method: 'POST', path: '/api/admin/self-update', route: '/api/admin/self-update', body: {} },
    { method: 'POST', path: '/api/admin/restart', route: '/api/admin/restart' },
    { method: 'POST', path: '/api/admin/soft-restart', route: '/api/admin/soft-restart' },
    { method: 'POST', path: '/api/admin/scaffold', route: '/api/admin/scaffold', body: { appId: 'com.acme.notes', force: true } },
    { method: 'POST', path: '/api/admin/clone-app', route: '/api/admin/clone-app', body: { source: 'com.acme.notes', force: true } },
  ];
  const term = inst('com.aura.terminal', 'com.aura.terminal-1');
  for (const mode of MODES) {
    for (const c of calls) {
      assert.equal(await gate(mode, anon, c), '401 unauthenticated', `${mode} ${c.method ?? 'GET'} ${c.path}`);
      assert.equal(await gate(mode, owner, c), 'pass', `owner ${c.path}`);
      assert.equal(await gate(mode, term, c), 'pass', `System Terminal ${c.path}`);
    }
    for (const c of calls.slice(0, 2)) assert.equal(await gate(mode, inst('com.acme.notes'), c), 'pass', `a verified app ${c.path}`);
    assert.equal(await gate(mode, operator, calls[5]!), 'pass', 'the host operator updates the OS');
  }
});
