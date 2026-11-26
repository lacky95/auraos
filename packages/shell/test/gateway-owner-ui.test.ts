/**
 * D45: a trusted system UI (system-scope Settings or Nexus) on a host cookie
 * bound to a live owner session acts for the owner. Nothing else does.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { GATEWAY_IDENTITY_HEADER } from '@aura/core/host-rules';
import type { AuditInput, GatewayIdentityClaim } from '@aura/core';
import { handleAppGateway } from '../server/app-gateway.mjs';
import { ownerUiCovers, signGatewayClaim, verifyGatewayClaim } from '../server/gateway-identity.mjs';
import { createDecide } from '../src/lib/access/decide.ts';
import { enforceGateway } from '../src/lib/access/gatewayCaller.ts';
import { runAfterResponse } from '../src/lib/afterResponse.ts';
import type { GatewayOwnerDeps } from '../src/lib/access/identify.ts';
import type { ObserverManager } from '../src/lib/access/observer.ts';
import type { RouteAccessManifest } from '../src/lib/access/types.ts';
import { ROUTE_ACCESS_MANIFEST } from '../src/lib/access/routeManifest.ts';
import { authenticate, type AuthDeps } from '../src/lib/auth.ts';

const SETTINGS = 'com.aura.settings';
const NEXUS = 'com.aura.nexus';
const NOTES = 'com.acme.notes';

// ── shared fakes ────────────────────────────────────────────────────────────

/** installationId → installation. `inst-settings-user` is a same-id copy in user scope. */
const installations: Record<string, { appId: string; scope: string; state: string; overlay?: { of: string } }> = {
  'inst-settings': { appId: SETTINGS, scope: 'system', state: 'active' },
  // A record written while the (removed, Q6) overlay link existed: the field is never read.
  'inst-settings-legacy': { appId: SETTINGS, scope: 'user', state: 'active', overlay: { of: 'inst-settings' } },
  'inst-settings-user': { appId: SETTINGS, scope: 'user', state: 'active' },
  'inst-nexus': { appId: NEXUS, scope: 'system', state: 'active' },
  'inst-nexus-user': { appId: NEXUS, scope: 'user', state: 'active' },
  'inst-notes': { appId: NOTES, scope: 'user', state: 'active' },
};
const liveSessions = new Set(['s-live']);
/** Mirrors app-host-auth.mjs `sessionLive`. */
const sessionLive = async (sid: string) => liveSessions.has(sid);
const services = {
  registry: {
    getInstallation: async (id: string) => installations[id] ?? null,
  },
  sessionLive,
};
const ownerServices = (async () => services) as unknown as GatewayOwnerDeps['services'];

const instances: Record<string, { appId: string; instanceId: string }> = {
  'com.aura.settings-1': { appId: SETTINGS, instanceId: 'com.aura.settings-1' },
  'com.aura.nexus-1': { appId: NEXUS, instanceId: 'com.aura.nexus-1' },
  'com.acme.notes-1': { appId: NOTES, instanceId: 'com.acme.notes-1' },
};
/** appId → install scope of the copy the registry resolves (a user copy shadows system). */
const installedScope: Record<string, string> = { [SETTINGS]: 'system', [NEXUS]: 'system', [NOTES]: 'user' };
const mgr = {
  tokens: { hasNonce: () => false, verify: () => null },
  getInstance: (id: string) => instances[id],
  getInstancesByApp: () => [],
  getManifest: (id: string) => (installedScope[id] ? { scopeId: installedScope[id] } : undefined),
  isTrustedSystemCopy: (id: string) => installedScope[id] === 'system',
  getActivity: () => undefined,
} as unknown as ObserverManager;
/** No app holds any permission, so only `owner` can pass an owner rule. */
const decide = createDecide({ authorizer: { authorize: async () => ({ allow: false, reason: 'not granted' }) } });

const audits: AuditInput[] = [];
const enforce = (c: ReturnType<typeof apiCtx>, manifest?: RouteAccessManifest) =>
  enforceGateway(c, { mgr, decide, ownerServices, audit: async (e) => { audits.push(e); }, ...(manifest ? { manifest } : {}) });

interface Caller { appId: string; instanceId: string; installationId: string }
const settings: Caller = { appId: SETTINGS, instanceId: 'com.aura.settings-1', installationId: 'inst-settings' };
const nexus: Caller = { appId: NEXUS, instanceId: 'com.aura.nexus-1', installationId: 'inst-nexus' };
const notes: Caller = { appId: NOTES, instanceId: 'com.acme.notes-1', installationId: 'inst-notes' };
const OWNER = { userId: 'u-owner', sid: 's-live' };

function claim(c: Caller, method: string, path: string, over: Partial<GatewayIdentityClaim> = {}): GatewayIdentityClaim {
  const iat = Math.floor(Date.now() / 1000);
  return {
    v: 1, appId: c.appId, installationId: c.installationId, instanceId: c.instanceId, label: 'x', slot: 1,
    origin: 'http://x--desk.example', userId: OWNER.userId, method, path, iat, exp: iat + 30, ...over,
  };
}
function apiCtx(
  c: Caller, method: string, path: string, routePattern: string,
  opts: { params?: Record<string, string>; owner?: GatewayIdentityClaim['owner'] | null; token?: string; headers?: Record<string, string> } = {},
) {
  const url = new URL(path, 'http://127.0.0.1:3000');
  const owner = opts.owner === undefined ? OWNER : opts.owner;
  const token = opts.token ?? signGatewayClaim(claim(c, method, path, owner ? { owner } : {}));
  const request = new Request(url, { method, headers: { [GATEWAY_IDENTITY_HEADER]: token, ...(opts.headers ?? {}) } });
  return { request, url, routePattern, params: opts.params ?? {} };
}

const OWNER_ROUTES: Array<[string, string, string]> = [
  ['GET', '/api/os/context', '/api/os/context'],
  ['POST', '/api/admin/apps/enabled', '/api/admin/apps/enabled'],
  ['GET', '/api/scopes', '/api/scopes'],
];

// ── the shell's decision ───────────────────────────────────────────────────

test('owner through system Settings: owner routes are allowed, and the audit names owner and app', async () => {
  audits.length = 0;
  for (const [method, path, route] of OWNER_ROUTES) {
    const c = apiCtx(settings, method, path, route);
    assert.equal(await enforce(c), null, `${method} ${path}`);
    runAfterResponse(c.request, 200);
  }
  await new Promise((r) => setImmediate(r));
  assert.equal(audits.length, 1, 'mutations only');
  assert.deepEqual(audits[0], {
    by: { kind: 'user', userId: OWNER.userId, session: 's-live' },
    action: 'gateway.owner-ui',
    target: '/api/admin/apps/enabled',
    outcome: 'ok',
    detail: { method: 'POST', status: 200, through: SETTINGS, instance: 'com.aura.settings-1' },
  });
});

test('the owner-action audit is written after the route, with its final status', async () => {
  audits.length = 0;
  const [method, path, route] = OWNER_ROUTES[1]!;
  const refused = apiCtx(settings, method, path, route);
  assert.equal(await enforce(refused), null);
  await new Promise((r) => setImmediate(r));
  assert.equal(audits.length, 0, 'nothing is recorded before the route answers');
  runAfterResponse(refused.request, 403);
  runAfterResponse(refused.request, 200);   // once per request
  const failed = apiCtx(settings, method, path, route);
  assert.equal(await enforce(failed), null);
  runAfterResponse(failed.request, 500);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(audits.map((a) => [a.outcome, a.detail?.['status']]), [['denied', 403], ['failed', 500]]);
});

test('the same call from an ordinary app is refused, even with an owner claim', async () => {
  for (const [method, path, route] of OWNER_ROUTES) {
    assert.equal((await enforce(apiCtx(notes, method, path, route)))?.status, 403, path);
    assert.equal((await enforce(apiCtx(notes, method, path, route, { owner: null })))?.status, 403, path);
  }
});

test('Settings without the owner claim stays on instance rules', async () => {
  for (const [method, path, route] of OWNER_ROUTES) {
    assert.equal((await enforce(apiCtx(settings, method, path, route, { owner: null })))?.status, 403, path);
  }
});

test('a forged owner claim or an inbound header grants nothing', async () => {
  const [method, path, route] = OWNER_ROUTES[0]!;
  const good = signGatewayClaim(claim(settings, method, path));
  const [head, , mac] = good.split('.');
  // An owner field spliced into an ordinary app's signed claim.
  const spliced = Buffer.from(JSON.stringify(claim(notes, method, path, { owner: OWNER }))).toString('base64url');
  assert.equal((await enforce(apiCtx(notes, method, path, route, { token: `${head}.${spliced}.${mac}` })))?.status, 401);
  // A request header claiming ownership, next to a claim without it.
  const plain = apiCtx(settings, method, path, route, {
    owner: null, headers: { 'x-aura-owner': 'u-owner', 'x-aura-user-id': 'u-owner', 'x-aura-session': 's-live' },
  });
  assert.equal((await enforce(plain))?.status, 403);
  // A malformed owner field does not verify at all.
  const bad = signGatewayClaim({ ...claim(settings, method, path), owner: { userId: '', sid: 's-live' } });
  assert.equal(verifyGatewayClaim(bad, { method, path }), null);
});

test('a same-id copy in user scope never qualifies', async () => {
  const [method, path, route] = OWNER_ROUTES[0]!;
  // Its own installation is the user one.
  const userCopy = { ...settings, installationId: 'inst-settings-user' };
  assert.equal((await enforce(apiCtx(userCopy, method, path, route)))?.status, 403);
  // Or it shadows the system copy, so the installed Settings is the user one.
  installedScope[SETTINGS] = 'user';
  try {
    assert.equal((await enforce(apiCtx(settings, method, path, route)))?.status, 403);
  } finally {
    installedScope[SETTINGS] = 'system';
  }
});

test('a same-id user copy of Settings never acts for the owner, even with a legacy overlay field (Q6)', async () => {
  installedScope[SETTINGS] = 'user';
  try {
    for (const installationId of ['inst-settings-legacy', 'inst-settings-user', 'inst-settings']) {
      assert.equal((await enforce(apiCtx({ ...settings, installationId }, ...OWNER_ROUTES[0]!)))?.status, 403, installationId);
    }
  } finally {
    installedScope[SETTINGS] = 'system';
  }
  assert.equal((await enforce(apiCtx({ ...settings, installationId: 'inst-settings-legacy' }, ...OWNER_ROUTES[0]!)))?.status, 403,
    'the claim names a user installation, not the system one');
});

test('a cookie without a live session, or a revoked session, is refused', async () => {
  const [method, path, route] = OWNER_ROUTES[0]!;
  assert.equal((await enforce(apiCtx(settings, method, path, route, { owner: { userId: OWNER.userId, sid: 's-never' } })))?.status, 403);
  assert.equal(await enforce(apiCtx(settings, method, path, route)), null);
  liveSessions.delete('s-live');
  try {
    assert.equal((await enforce(apiCtx(settings, method, path, route)))?.status, 403);
  } finally {
    liveSessions.add('s-live');
  }
  // The owner must be the user the claim is for.
  assert.equal((await enforce(apiCtx(settings, method, path, route, { owner: { userId: 'u-other', sid: 's-live' } })))?.status, 403);
});

test('only a live login session acts for the owner; the old login-dark marker never does', async () => {
  const [method, path, route] = OWNER_ROUTES[0]!;
  assert.equal((await enforce(apiCtx(settings, method, path, route, { owner: { userId: OWNER.userId, sid: 'login-dark' } })))?.status, 403);
});

test('never a login session, a shell screen or another app, even for Settings', async () => {
  for (const [method, path, route, params] of [
    ['POST', '/api/os/clients', '/api/os/clients', {}],
    ['POST', '/api/os/clients/abc/unlock', '/api/os/clients/[sid]/[action]', { sid: 'abc', action: 'unlock' }],
    ['GET', '/api/proxy/com.aura.terminal-1/x', '/api/proxy/[id]/[...path]', { id: 'com.aura.terminal-1', path: 'x' }],
    ['POST', '/api/app-hosts/handoff', '/api/app-hosts/handoff', {}],
    ['POST', '/api/auth/logout', '/api/auth/logout', {}],
  ] as Array<[string, string, string, Record<string, string>]>) {
    assert.equal((await enforce(apiCtx(settings, method, path, route, { params })))?.status, 403, path);
  }
});

test('Users & Identities: Settings reads the account and signs out other sessions, never a password route', async () => {
  const ACCOUNT: Array<[string, string]> = [['GET', '/api/auth/account'], ['POST', '/api/auth/sessions/revoke-others']];
  for (const [method, route] of ACCOUNT) {
    assert.equal(ownerUiCovers(SETTINGS, route), true, route);
    assert.equal(await enforce(apiCtx(settings, method, route, route)), null, `${method} ${route}`);
    assert.equal((await enforce(apiCtx(notes, method, route, route)))?.status, 403, `notes ${route}`);
    assert.equal((await enforce(apiCtx(nexus, method, route, route)))?.status, 403, `nexus ${route}`);
    assert.equal((await enforce(apiCtx(settings, method, route, route, { owner: null })))?.status, 403, `no owner ${route}`);
  }
  // The password and policy writes: not covered, and on a target no app reaches for the owner.
  const PASSWORD: Array<[string, string]> = [['POST', '/api/auth/password'], ['PUT', '/api/auth/password-policy']];
  for (const [method, route] of PASSWORD) {
    assert.equal(ownerUiCovers(SETTINGS, route), false, route);
    assert.equal(ROUTE_ACCESS_MANIFEST.routes[route]?.methods?.[method as 'POST']?.target, 'session', route);
    assert.equal((await enforce(apiCtx(settings, method, route, route)))?.status, 403, `${method} ${route}`);
  }
  // Each layer alone refuses: a covered route on the `session` target is still refused.
  const sessionTarget: RouteAccessManifest = {
    ...ROUTE_ACCESS_MANIFEST,
    routes: { ...ROUTE_ACCESS_MANIFEST.routes, '/api/auth/account': { methods: { GET: { allow: ['owner'], target: 'session' } } } },
  };
  assert.equal((await enforce(apiCtx(settings, 'GET', '/api/auth/account', '/api/auth/account'), sessionTarget))?.status, 403);
  // The rules themselves are public, for any app.
  assert.equal(await enforce(apiCtx(notes, 'GET', '/api/auth/password-policy', '/api/auth/password-policy', { owner: null })), null);
});

test('Nexus acts for the owner on its own routes only', async () => {
  assert.equal(await enforce(apiCtx(nexus, 'POST', '/api/os/ui/command', '/api/os/ui/command')), null);
  assert.equal(await enforce(apiCtx(nexus, 'POST', '/api/apps/com.acme.notes/start', '/api/apps/[id]/start', { params: { id: NOTES } })), null);
  assert.equal((await enforce(apiCtx(nexus, 'GET', '/api/os/context', '/api/os/context')))?.status, 403);
  assert.equal((await enforce(apiCtx(nexus, 'GET', '/api/admin/grants', '/api/admin/grants')))?.status, 403);
});

test('Nexus install: only the owner through system Nexus, and fresh auth still applies', async () => {
  const install = (c: Caller, owner?: GatewayIdentityClaim['owner'] | null, manifest?: RouteAccessManifest) =>
    enforce(apiCtx(c, 'POST', '/api/nexus/install', '/api/nexus/install', { owner }), manifest);
  // What reaches the route is unchanged: it still answers needsApproval without autoApprove.
  assert.equal(await install(nexus), null);
  assert.equal((await install(notes))?.status, 403);
  assert.equal((await install(nexus, null))?.status, 403);
  assert.equal((await install({ ...nexus, installationId: 'inst-nexus-user' }))?.status, 403);
  assert.equal((await install(settings))?.status, 403, 'not a Settings route');
  // A rule that needs fresh authentication is not satisfied by acting through an app.
  const fresh: RouteAccessManifest = {
    groups: { nexus: { allow: ['owner'], target: 'system', freshAuth: true } },
    routes: {},
    nonRoutes: {},
  };
  assert.equal((await install(nexus, undefined, fresh))?.status, 403);
});

// ── authenticate(): through the gateway a bearer is nothing (D50) ──────────

test('authenticate(): a retired admin bearer through the gateway changes nothing: the owner path or the instance', async () => {
  const deps = { mgr, ownerServices, apiKeys: { verify: async () => null } } as unknown as AuthDeps;
  const req = (c: Caller, bearer: string, owner: GatewayIdentityClaim['owner'] | null = OWNER) => {
    const path = '/api/admin/grants';
    return new Request(`http://127.0.0.1:3000${path}`, {
      headers: {
        [GATEWAY_IDENTITY_HEADER]: signGatewayClaim(claim(c, 'GET', path, owner ? { owner } : {})),
        authorization: `Bearer ${bearer}`,
      },
    });
  };
  const owner = await authenticate(req(settings, 'aura-admin1.good'), deps);
  assert.ok(!(owner instanceof Response) && owner.kind === 'user' && owner.through?.appId === SETTINGS, JSON.stringify(owner));
  for (const r of [
    req(notes, 'aura-admin1.good'),
    req(settings, 'aura-admin1.good', null),
    req({ ...settings, installationId: 'inst-settings-user' }, 'aura-admin1.good'),
    req(settings, 'aura-admin1.good', { userId: OWNER.userId, sid: 's-gone' }),
  ]) {
    const p = await authenticate(r, deps);
    assert.ok(!(p instanceof Response) && p.kind === 'instance', JSON.stringify(p));
  }
});

test('authenticate(): the owner through a trusted UI only on a path it covers (the one D45 scope)', async () => {
  const deps = { mgr, ownerServices, apiKeys: { verify: async () => null } } as unknown as AuthDeps;
  const req = (c: Caller, path: string, method = 'GET') => new Request(`http://127.0.0.1:3000${path}`, {
    method,
    headers: { [GATEWAY_IDENTITY_HEADER]: signGatewayClaim(claim(c, method, path, { owner: OWNER })) },
  });
  // Nexus covers `apps` and `nexus` only: not the admin API.
  for (const [c, path] of [
    [nexus, '/api/admin/grants'], [nexus, '/api/os/context'], [settings, '/api/terminal/sessions'], [settings, '/api/nexus/install'],
  ] as Array<[Caller, string]>) {
    const p = await authenticate(req(c, path), deps);
    assert.ok(!(p instanceof Response) && p.kind === 'instance', `${c.appId} ${path}: ${JSON.stringify(p)}`);
  }
  for (const [c, path] of [[settings, '/api/admin/grants'], [nexus, '/api/apps/com.acme.notes/start'], [nexus, '/api/os/ui/command']] as Array<[Caller, string]>) {
    const p = await authenticate(req(c, path, 'POST'), deps);
    assert.ok(!(p instanceof Response) && p.kind === 'user', `${c.appId} ${path}`);
  }
});

test('the D45 scope matches route patterns against the concrete path', () => {
  assert.equal(ownerUiCovers('com.aura.terminal', '/api/apps/com.aura.terminal/instances'), true);
  assert.equal(ownerUiCovers('com.aura.terminal', '/api/apps/com.aura.terminal/start?x=1'), true);
  assert.equal(ownerUiCovers('com.aura.terminal', '/api/instances/com.aura.terminal-1/activities'), true);
  assert.equal(ownerUiCovers('com.aura.terminal', '/api/apps/a/b/start'), false);
  assert.equal(ownerUiCovers('com.aura.terminal', '/api/apps/com.aura.terminal/stop'), false);
  assert.equal(ownerUiCovers('com.aura.terminal', '/api/admin/grants'), false);
  assert.equal(ownerUiCovers(NEXUS, '/api/os/ui/command'), true);
  assert.equal(ownerUiCovers(NEXUS, '/api/os/ui/commandx'), false);
  assert.equal(ownerUiCovers(SETTINGS, '/api/admin/x'), true);
  assert.equal(ownerUiCovers(SETTINGS, '/_aura/os/api/admin/x'), false);
  assert.equal(ownerUiCovers(NOTES, '/api/apps/x/start'), false);
});

// ── the gateway signs the owner claim, and only for a trusted UI ───────────

const seen: http.IncomingMessage[] = [];
let shell: http.Server;
let gateway: http.Server;
let gatewayUrl = '';
let ctx: Record<string, unknown> = {};
const ORIGIN = 'http://settingsabcd1234--desk.example:3000';

before(async () => {
  shell = http.createServer((req, res) => { seen.push(req); req.resume(); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
  await new Promise<void>((r) => shell.listen(0, '127.0.0.1', r));
  process.env.SHELL_PORT = String((shell.address() as AddressInfo).port);
  gateway = http.createServer((req, res) => { void handleAppGateway(req, res, ctx as never); });
  await new Promise<void>((r) => gateway.listen(0, '127.0.0.1', r));
  gatewayUrl = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
});
after(() => { shell.close(); gateway.close(); shell.closeAllConnections(); gateway.closeAllConnections(); });

function call(path: string, headers: Record<string, string> = {}) {
  return new Promise<number>((resolve, reject) => {
    const req = http.request(new URL(path, gatewayUrl), { headers, agent: false }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
    req.on('error', reject);
    req.end();
  });
}
function gatewayCtx(appId: string, installationId: string, sid = 's-live') {
  return {
    record: { appId, installationId, instanceScope: { kind: 'user', userId: OWNER.userId } },
    slot: { slot: 1, label: 'settingsabcd1234', instanceId: `${appId}-1` },
    session: { v: 1, aud: ORIGIN, label: 'settingsabcd1234', installationId, userId: OWNER.userId, sid, iat: 1, exp: 9e9 },
    services,
  };
}
async function forwarded(c: ReturnType<typeof gatewayCtx>, headers: Record<string, string> = {}) {
  ctx = c;
  seen.length = 0;
  assert.equal(await call('/_aura/os/api/admin/grants', headers), 200);
  const h = seen[0]!.headers;
  return { claim: verifyGatewayClaim(String(h[GATEWAY_IDENTITY_HEADER]), { method: 'GET', path: '/api/admin/grants' }), authorization: h.authorization };
}

test('gateway: system Settings on a live session gets the owner claim, and no Authorization passes (D50)', async () => {
  const out = await forwarded(gatewayCtx(SETTINGS, 'inst-settings'), { authorization: 'Bearer aura-admin1.abc.def' });
  assert.deepEqual(out.claim?.owner, OWNER);
  assert.equal(out.authorization, undefined);
  // Nor any other Authorization.
  assert.equal((await forwarded(gatewayCtx(SETTINGS, 'inst-settings'), { authorization: 'Bearer aura_k1_key' })).authorization, undefined);
});

test('gateway: no owner claim and no Authorization for anyone else', async () => {
  for (const c of [
    gatewayCtx(NOTES, 'inst-notes'),
    gatewayCtx(SETTINGS, 'inst-settings-user'),
    gatewayCtx(SETTINGS, 'inst-settings', 's-revoked'),
  ]) {
    const forged = signGatewayClaim(claim(settings, 'GET', '/api/admin/grants', { owner: OWNER })).replace(/\.([^.])([^.]*)$/, (_m, c: string, rest: string) => `.${c === 'A' ? 'B' : 'A'}${rest}`); // first signature char: the last one is partly padding bits
    const out = await forwarded(c, {
      authorization: 'Bearer aura-admin1.abc.def', [GATEWAY_IDENTITY_HEADER]: forged, 'x-aura-owner': 'u-owner',
    });
    assert.ok(out.claim, 'a fresh claim replaces the inbound one');
    assert.equal(out.claim?.owner, undefined, c.record.installationId);
    assert.equal(out.authorization, undefined);
  }
});

test('gateway: no owner claim outside the paths the trusted UI covers', async () => {
  ctx = gatewayCtx(NEXUS, 'inst-nexus');
  seen.length = 0;
  assert.equal(await call('/_aura/os/api/admin/grants', { authorization: 'Bearer aura-admin1.abc.def' }), 200);
  const h = seen[0]!.headers;
  assert.equal(verifyGatewayClaim(String(h[GATEWAY_IDENTITY_HEADER]), { method: 'GET', path: '/api/admin/grants' })?.owner, undefined);
  assert.equal(h.authorization, undefined);
  seen.length = 0;
  assert.equal(await call('/_aura/os/api/nexus/sources', { authorization: 'Bearer aura-admin1.abc.def' }), 200);
  assert.deepEqual(verifyGatewayClaim(String(seen[0]!.headers[GATEWAY_IDENTITY_HEADER]), { method: 'GET', path: '/api/nexus/sources' })?.owner, OWNER);
});

test('gateway: an unreadable registry fails closed', async () => {
  const c = { ...gatewayCtx(SETTINGS, 'inst-settings'), services: { ...services, registry: { ...services.registry, getInstallation: async () => { throw new Error('down'); } } } };
  const out = await forwarded(c, { authorization: 'Bearer aura-admin1.abc.def' });
  assert.equal(out.claim?.owner, undefined);
  assert.equal(out.authorization, undefined);
});

test('gateway: a restricted embed cookie never acts for the owner', async () => {
  const c = gatewayCtx(SETTINGS, 'inst-settings');
  const embedded = { ...c, session: { ...c.session, embed: { sessionId: 'com.aura.terminal-1#a3', embedder: 'tx1' } } };
  const out = await forwarded(embedded, { authorization: 'Bearer aura-admin1.abc.def' });
  assert.equal(out.claim?.owner, undefined);
  assert.equal(out.authorization, undefined);
});
