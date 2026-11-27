// Error-messages review Pass A: structured access refusals (refusalText.ts).
// The decision never changes; the answer names the reason, what is missing
// and the fix, as far as its reader may know it (review §4.4), and leaks
// nothing: no host paths, no credentials, no other app's facts, no grant hint
// for what nobody can grant, one class for token failures.
//
//   cd packages/shell && npx tsx --test test/error-hints.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Authorizer } from '@aura/core';
import type { AccessPrincipal, AuraErrorBody, InstancePrincipal } from '@aura/core';
import { GATEWAY_IDENTITY_HEADER } from '@aura/core/host-rules';
import type { GatewayIdentityClaim } from '@aura/core';
import { signGatewayClaim } from '../server/gateway-identity.mjs';
import { createDecide } from '../src/lib/access/decide.ts';
import { accessGate, type GateDeps } from '../src/lib/access/enforce.ts';
import { enforceGateway } from '../src/lib/access/gatewayCaller.ts';
import { isTrustedOwnerAgent } from '../src/lib/access/identify.ts';
import type { ObserverManager } from '../src/lib/access/observer.ts';
import { refusalBody, type RefusalView } from '../src/lib/access/refusalText.ts';
import { ROUTE_ACCESS_MANIFEST } from '../src/lib/access/routeManifest.ts';
import {
  ACCESS_REASONS, POLICY_OUTCOMES,
  type AccessLabel, type AccessRule, type AccessVia, type DecideInput, type DecideResult, type RefusalFacts, type RouteAccessManifest,
} from '../src/lib/access/types.ts';
import { errorResponse } from '../src/lib/appResponse.ts';

// ── fixtures ────────────────────────────────────────────────────────────────

const anon: AccessPrincipal = { kind: 'anonymous', verification: 'unverified' };
const inst = (appId: string, instanceId = `${appId}-1`, extra: Partial<InstancePrincipal> = {}): InstancePrincipal =>
  ({ kind: 'instance', appId, instanceId, verification: 'verified', ...extra });
const owner: AccessPrincipal = { kind: 'user', userId: 'default', role: 'owner', sessionId: 's', verification: 'verified' };

const instances: Record<string, { appId: string; instanceId: string; sandbox?: string }> = {
  'com.acme.notes-1': { appId: 'com.acme.notes', instanceId: 'com.acme.notes-1', sandbox: 'container' },
  'com.other.app-1': { appId: 'com.other.app', instanceId: 'com.other.app-1', sandbox: 'container' },
  'com.aura.settings-1': { appId: 'com.aura.settings', instanceId: 'com.aura.settings-1', sandbox: 'container' },
  'com.aura.terminal-1': { appId: 'com.aura.terminal', instanceId: 'com.aura.terminal-1', sandbox: 'container' },
};
const scopes: Record<string, string> = {
  'com.acme.notes': 'user', 'com.other.app': 'user', 'com.aura.settings': 'system', 'com.aura.terminal': 'system',
};
const mgr = {
  tokens: { hasNonce: () => false, verify: () => null },
  getInstance: (id: string) => instances[id],
  getInstancesByApp: (appId: string) => Object.values(instances).filter((i) => i.appId === appId),
  getAllInstances: () => Object.values(instances),
  getManifest: (id: string) => (scopes[id] ? { scopeId: scopes[id] } : undefined),
  isTrustedSystemCopy: (id: string) => scopes[id] === 'system',
  registry: { getById: (id: string) => (scopes[id] ? {} : undefined), getScopeId: (id: string) => scopes[id] },
} as unknown as ObserverManager;

const declared: Record<string, string[]> = {
  'com.acme.notes': ['apps.port', 'notifications.popup'],
  'com.other.app': [],
  'com.aura.settings': [],
  'com.aura.terminal': ['apps.mount'],
};
const authorizer = new Authorizer({
  grants: { get: async () => null } as never,
  declared: (id: string) => declared[id],
  appBinding: async (id: string) => ({ scope: scopes[id], installationId: null }),
});

function deps(mode: string, who: { principal: AccessPrincipal; via: AccessVia }): GateDeps {
  return {
    authorizer,
    ownerAgent: (p) => isTrustedOwnerAgent(p, mgr as never),
    mgr: () => mgr,
    services: () => null,
    redisReady: () => false,
    internalSecret: () => 'secret',
    principal: async () => ({ principal: who.principal as never, via: who.via }),
    mode: () => mode,
  };
}

/** A small manifest: one route per kind of refusal. */
const rule = (r: Partial<AccessRule> & Pick<AccessRule, 'allow'>): AccessRule => ({ target: 'system', ...r });
const T: RouteAccessManifest = {
  groups: { t: rule({ allow: [] }) },
  routes: {
    '/api/t/perm': { methods: { POST: rule({ allow: ['app-permission'], permissions: ['apps.mount'] }) } },
    '/api/t/popup': { methods: { POST: rule({ allow: ['app-permission'], permissions: ['notifications.popup'] }) } },
    '/api/t/locked': { methods: { POST: rule({ allow: ['app-permission'], permissions: ['notifications.locked'] }) } },
    '/api/t/admin': { methods: { POST: rule({ allow: ['app-permission'], permissions: ['admin.users'] }) } },
    '/api/t/owner': { methods: { POST: rule({ allow: ['owner'] }) } },
    '/api/t/fresh': { methods: { POST: rule({ allow: ['owner'], freshAuth: true }) } },
    '/api/t/token': { methods: { POST: rule({ allow: ['own-instance'], target: 'app', credentials: ['instance-token'] }) } },
    '/api/t/[instanceId]/mount': {
      methods: { POST: rule({ allow: ['owner', 'own-instance'], target: 'instance', targetPermissions: ['apps.mount'] }) },
    },
  },
  nonRoutes: {},
};

function ctx(path: string, route: string, params: Record<string, string> = {}, method = 'POST') {
  const url = new URL(path, 'http://shell');
  return { request: new Request(url, { method }), url, routePattern: route, params, clientAddress: undefined };
}

const viaOf = (p: AccessPrincipal): AccessVia =>
  p.kind === 'anonymous' ? 'none' : p.kind === 'user' ? 'login-session' : p.kind === 'operator' ? 'operator-ticket' : 'instance-token';

/** The gate's refusal in `enforce`: status and body (null when it passes). */
async function refusalOf(
  principal: AccessPrincipal, path: string, route: string, params: Record<string, string> = {}, via?: AccessVia,
): Promise<{ status: number; body: AuraErrorBody; headers: Headers } | null> {
  const r = await accessGate(ctx(path, route, params), deps('enforce', { principal, via: via ?? viaOf(principal) }), T);
  if (!r.refused) return null;
  return { status: r.refused.status, body: await r.refused.json() as AuraErrorBody, headers: r.refused.headers };
}

// ── what nothing may say (review §4.4) ─────────────────────────────────────

/** No host paths, container names, credentials or host env names; the app contract's own names are fine. */
function assertNoLeak(body: unknown, what: string): void {
  const text = JSON.stringify(body);
  for (const bad of [/\/data\//, /\/workspace/, /\/mnt\/aura/, /aura-shell/, /docker/i, /Bearer ey/, /password=/i, /cookie/i]) {
    assert.doesNotMatch(text, bad, `${what}: ${bad}`);
  }
  for (const env of text.match(/\bAURA_[A-Z_]+/g) ?? []) {
    assert.ok(env === 'AURA_INSTANCE_TOKEN' || env === 'AURA_INSTANCE_ID', `${what}: env name ${env}`);
  }
}

/** Nothing about the System Terminal or owner agents to an app (review §4.4 rule 2). */
function assertNoOwnerAgentHint(body: unknown, what: string): void {
  const text = JSON.stringify(body);
  assert.doesNotMatch(text, /terminal|owner agent|aurashelld/i, what);
}

// ── decide: facts, and the same decisions ─────────────────────────────────

const d = createDecide({ authorizer });
const input = (principal: AccessPrincipal, r: AccessRule, over: Partial<DecideInput> = {}): DecideInput => ({
  principal,
  action: { surface: 'api', subject: '/api/t' as AccessLabel, method: 'POST', variant: null, rule: r },
  resource: { target: 'system' }, transport: 'http', auth: { fresh: false, via: viaOf(principal) }, strict: true,
  accessProfile: 'open', systemMode: 'normal', deployment: 'private', ...over,
});

test('decide: a refusal names the first permission not held and who has to hold it; outcomes are unchanged', async () => {
  const undeclared = await d(input(inst('com.other.app'), rule({ allow: ['app-permission'], permissions: ['apps.mount'] })));
  assert.deepEqual(undeclared, { outcome: 'deny', reason: 'missing-permission', facts: { permission: 'apps.mount', missing: 'declaration', holder: 'caller' } });

  const notGranted = await d(input(inst('com.acme.notes'), rule({ allow: ['app-permission'], permissions: ['notifications.popup'] })));
  assert.deepEqual(notGranted, { outcome: 'deny', reason: 'missing-permission', facts: { permission: 'notifications.popup', missing: 'grant', holder: 'owner-grant' } });

  const target = await d(input(inst('com.other.app'), rule({ allow: ['own-instance'], target: 'instance', targetPermissions: ['apps.mount'] }), {
    resource: { target: 'instance', appId: 'com.other.app', instanceId: 'com.other.app-1' },
  }));
  assert.deepEqual(target, {
    outcome: 'deny', reason: 'missing-target-permission',
    facts: { permission: 'apps.mount', missing: 'declaration', holder: 'target', targetAppId: 'com.other.app' },
  });

  assert.deepEqual(await d(input(inst('com.acme.notes'), rule({ allow: ['owner'] }))), { outcome: 'deny', reason: 'wrong-principal', facts: { ownerOnly: true } });
  assert.deepEqual(await d(input(inst('com.acme.notes'), rule({ allow: ['own-instance'], target: 'app', credentials: ['instance-token'] }), { auth: { fresh: false, via: 'gateway' } })),
    { outcome: 'deny', reason: 'wrong-principal', facts: { credentials: ['instance-token'] } });
  // Allowed and further-step answers carry no facts.
  assert.deepEqual(await d(input(inst('com.acme.notes'), rule({ allow: ['app-permission'], permissions: ['apps.port'] }))), { outcome: 'allow', reason: 'app-permission' });
  assert.deepEqual(await d(input(owner, rule({ allow: ['owner'], freshAuth: true }))), { outcome: 'needs-fresh-auth', reason: 'fresh-auth-required' });
  assert.deepEqual(await d(input(anon, rule({ allow: ['owner'] }))), { outcome: 'deny', reason: 'unauthenticated' });
});

// ── the central gate's answers ─────────────────────────────────────────────

test('missing manifest declaration: code, reason, permission, holder, the manifest field and the fix', async () => {
  const r = await refusalOf(inst('com.other.app'), '/api/t/perm', '/api/t/perm');
  assert.equal(r?.status, 403);
  assert.equal(r?.body.error, 'access-denied');
  assert.equal(r?.body.reason, 'missing-permission');
  assert.equal(r?.body.category, 'missing-declaration');
  assert.equal(r?.body.permission, 'apps.mount');
  assert.equal(r?.body.holder, 'caller');
  assert.equal(r?.body.manifestField, 'permissions[]');
  assert.match(r!.body.message, /com\.other\.app does not declare 'apps\.mount' in app\.manifest\.json permissions\[\]/);
  assert.match(r!.body.hint ?? '', /Add "apps\.mount" to permissions\[\].*aura grant perms com\.other\.app apps\.mount/);
  assert.equal(r?.headers.get('cache-control'), 'no-store');
  assert.equal(r?.headers.get('x-content-type-options'), 'nosniff');
  assertNoLeak(r?.body, 'declaration');
  assertNoOwnerAgentHint(r?.body, 'declaration');
});

test('missing permission (the owner\'s grant): declared but not granted, with the grant command', async () => {
  const r = await refusalOf(inst('com.acme.notes'), '/api/t/popup', '/api/t/popup');
  assert.equal(r?.body.reason, 'missing-permission');
  assert.equal(r?.body.category, 'missing-permission');
  assert.equal(r?.body.holder, 'owner-grant');
  assert.match(r!.body.message, /declares 'notifications\.popup', but the owner has not granted it/);
  assert.match(r!.body.hint ?? '', /aura grant notif-perms com\.acme\.notes popup/);
  // A privileged permission not declared: declare it, then the owner grants it (no `grant perms` shortcut).
  const locked = await refusalOf(inst('com.acme.notes'), '/api/t/locked', '/api/t/locked');
  assert.equal(locked?.body.category, 'missing-declaration');
  assert.match(locked!.body.hint ?? '', /Add "notifications\.locked" to permissions\[\].*then the owner grants it: aura grant notif-perms com\.acme\.notes locked/);
  assert.doesNotMatch(locked!.body.hint ?? '', /grant perms/);
});

test('non-grantable: owner-only rules and admin.* give no grant hint, and say nothing of owner agents', async () => {
  for (const [path, what] of [['/api/t/owner', 'owner rule'], ['/api/t/admin', 'admin.*']] as const) {
    const r = await refusalOf(inst('com.acme.notes'), path, path);
    assert.equal(r?.status, 403, what);
    assert.equal(r?.body.category, 'not-grantable', what);
    assert.equal(r?.body.hint, undefined, what);
    assert.doesNotMatch(JSON.stringify(r?.body), /aura grant|permissions\[\]/, what);
    assertNoOwnerAgentHint(r?.body, what);
  }
  assert.match((await refusalOf(inst('com.acme.notes'), '/api/t/owner', '/api/t/owner'))!.body.message, /owner's action: apps cannot be granted it/);
});

test('a system app\'s missing permission: named, never `aura grant perms` (that refuses system apps)', async () => {
  const r = await refusalOf(inst('com.aura.settings'), '/api/t/perm', '/api/t/perm');
  assert.equal(r?.body.reason, 'missing-permission');
  assert.equal(r?.body.category, 'not-grantable');
  assert.equal(r?.body.hint, undefined);
  assert.match(r!.body.message, /system app, whose permissions ship with AuraOS/);
});

test('missing target permission: the target is named to the owner and to itself, never to another app', async () => {
  const mount = (id: string) => [`/api/t/${id}/mount`, '/api/t/[instanceId]/mount', { instanceId: id }] as const;
  // Its own instance: its own manifest.
  const own = await refusalOf(inst('com.other.app'), ...mount('com.other.app-1'));
  assert.equal(own?.body.reason, 'missing-target-permission');
  assert.equal(own?.body.holder, 'target');
  assert.equal(own?.body.target, 'com.other.app');
  assert.match(own!.body.hint ?? '', /aura grant perms com\.other\.app apps\.mount/);
  // The owner: names the target and the exact command.
  const byOwner = await refusalOf(owner, ...mount('com.other.app-1'));
  assert.equal(byOwner?.body.target, 'com.other.app');
  assert.match(byOwner!.body.hint ?? '', /aura grant perms com\.other\.app apps\.mount/);
  // Another app's instance (refused for the target before its own rule in report/off; here the facts
  // come straight from the decision): another app's id never shows.
  const view: RefusalView = { audience: 'app', callerAppId: 'com.acme.notes', scopeOf: (id) => scopes[id] };
  const other = refusalBody({ outcome: 'deny', reason: 'missing-target-permission', facts: { permission: 'apps.mount', holder: 'target', missing: 'declaration', targetAppId: 'com.other.app' } }, view);
  assert.equal(other.body.target, undefined);
  assert.doesNotMatch(JSON.stringify(other.body), /com\.other\.app/);
  assert.match(other.body.hint ?? '', /aura grant perms <that app> apps\.mount/);
});

test('needs-fresh-auth / needs-operator / needs-https / needs-approval: the step, never which factor is missing', async () => {
  const fresh = await refusalOf(owner, '/api/t/fresh', '/api/t/fresh');
  assert.equal(fresh?.status, 403);
  assert.equal(fresh?.body.error, 'needs-fresh-auth');
  assert.equal(fresh?.body.category, 'needs-approval');
  assert.match(fresh!.body.hint ?? '', /POST \/api\/approvals.*X-Aura-Approval/);
  const view: RefusalView = { audience: 'owner' };
  const op = refusalBody({ outcome: 'needs-operator', reason: 'operator-required' }, view);
  assert.equal(op.body.error, 'needs-operator');
  assert.equal(op.body.policy, 'fresh-auth-require-https');
  assert.match(op.body.hint ?? '', /HTTPS.*aura approve/);
  assert.doesNotMatch(JSON.stringify(op.body), /password/i, 'never the password path when HTTP is the operator\'s');
  const https = refusalBody({ outcome: 'needs-https', reason: 'https-required' }, view);
  assert.equal(https.body.error, 'needs-https');
  assert.match(https.body.hint ?? '', /HTTPS/);
  const approval = refusalBody({ outcome: 'needs-approval', reason: 'approval-required' }, view);
  assert.equal(approval.body.error, 'needs-approval');
  assert.match(approval.body.hint ?? '', /X-Aura-Approval/);
});

test('unauthenticated is one class: the same body whatever failed (no token, an invalid one)', async () => {
  const none = await refusalOf(anon, '/api/t/owner', '/api/t/owner', {}, 'none');
  const invalid = await refusalOf(anon, '/api/t/owner', '/api/t/owner', {}, 'foreign-or-invalid');
  const unverified = await refusalOf(anon, '/api/t/owner', '/api/t/owner', {}, 'unverified');
  assert.equal(none?.status, 401);
  assert.equal(none?.body.error, 'unauthenticated');
  assert.equal(none?.body.category, 'not-authenticated');
  assert.equal(invalid?.status, 401);
  assert.deepEqual(invalid?.body, none?.body);
  assert.deepEqual(unverified?.body, none?.body);
  assert.doesNotMatch(JSON.stringify(none?.body), /signature|nonce|expired|instance id/i);
});

test('a wrong credential names the accepted ones, and the token hint goes to apps only', async () => {
  const r = await refusalOf(inst('com.acme.notes'), '/api/t/token', '/api/t/token', {}, 'gateway');
  assert.equal(r?.body.reason, 'wrong-principal');
  assert.match(r!.body.message, /instance-token/);
  assert.match(r!.body.hint ?? '', /\$AURA_INSTANCE_TOKEN/);
});

// ── every reason × outcome × reader: complete, and nothing leaks ────────────

const FACTS: RefusalFacts[] = [
  {},
  { permission: 'apps.mount', holder: 'caller', missing: 'declaration' },
  { permission: 'notifications.popup', holder: 'owner-grant', missing: 'grant' },
  { permission: 'credential.read:GITHUB_TOKEN', holder: 'owner-grant', missing: 'grant' },
  { permission: 'apps.mount', holder: 'caller', missing: 'scope' },
  { permission: 'admin.users', holder: 'caller', missing: 'not-grantable' },
  { permission: 'apps.mount', holder: 'target', missing: 'declaration', targetAppId: 'com.other.app' },
  { permission: 'apps.mount', holder: 'target', missing: 'declaration', targetAppId: 'com.aura.settings' },
  { ownerOnly: true },
  { credentials: ['instance-token'] },
];
const VIEWS: RefusalView[] = [
  { audience: 'app', callerAppId: 'com.acme.notes', scopeOf: (id) => scopes[id], route: '/api/x', method: 'POST' },
  { audience: 'app', callerAppId: 'com.aura.settings', scopeOf: (id) => scopes[id], gateway: true, route: '/api/x', method: 'POST' },
  { audience: 'app', callerAppId: null },
  { audience: 'owner', callerAppId: null, scopeOf: (id) => scopes[id] },
];

test('every reason and outcome has a code, a sentence and a category; nothing leaks; no grant hint where nothing is grantable', () => {
  for (const outcome of POLICY_OUTCOMES.filter((o) => o !== 'allow')) {
    for (const reason of ACCESS_REASONS) {
      for (const facts of FACTS) {
        for (const view of VIEWS) {
          const result: DecideResult = { outcome, reason, facts };
          const what = `${outcome}/${reason}/${JSON.stringify(facts)}/${view.audience}:${view.callerAppId}`;
          const { status, body } = refusalBody(result, view);
          assert.ok(status === 401 || status === 403, what);
          assert.ok(typeof body.error === 'string' && /^[a-z-]+$/.test(body.error), what);
          assert.ok(typeof body.message === 'string' && body.message.length > 5, what);
          assert.equal(body.reason, reason, what);
          assert.ok(body.category, what);
          assertNoLeak(body, what);
          if (view.audience === 'app') assertNoOwnerAgentHint(body, what);
          if (body.category === 'not-grantable') assert.doesNotMatch(body.hint ?? '', /aura grant/, what);
          // A system app is never sent to `aura grant perms`.
          const sys = reason === 'missing-target-permission' ? facts.targetAppId === 'com.aura.settings'
            : reason === 'missing-permission' && view.callerAppId === 'com.aura.settings';
          if (sys && facts.missing === 'declaration') {
            assert.doesNotMatch(body.hint ?? '', /grant perms/, what);
          }
          // Another app is named to the owner only.
          if (view.audience === 'app' && facts.targetAppId && facts.targetAppId !== view.callerAppId) {
            assert.ok(!JSON.stringify(body).includes(facts.targetAppId), what);
          }
        }
      }
    }
  }
});

// ── the App Host gateway ───────────────────────────────────────────────────

const ORIGIN = 'http://notesabcd1234--desk.example:3000';
function claim(appId: string, instanceId: string, method: string, path: string, over: Partial<GatewayIdentityClaim> = {}): GatewayIdentityClaim {
  const iat = Math.floor(Date.now() / 1000);
  return {
    v: 1, appId, installationId: 'inst-1', instanceId, label: 'notesabcd1234', slot: 1,
    origin: ORIGIN, userId: 'default', method, path, iat, exp: iat + 30, ...over,
  };
}
function gatewayCtx(appId: string, method: string, path: string, routePattern: string, params: Record<string, string> = {}, token?: string) {
  const url = new URL(path, 'http://127.0.0.1:3000');
  const request = new Request(url, {
    method, headers: { [GATEWAY_IDENTITY_HEADER]: token ?? signGatewayClaim(claim(appId, `${appId}-1`, method, path)) },
  });
  return { request, url, routePattern, params };
}
const gatewayDecide = createDecide({ authorizer });
const viaGateway = async (c: ReturnType<typeof gatewayCtx>, manifest: RouteAccessManifest = ROUTE_ACCESS_MANIFEST) => {
  const res = await enforceGateway(c, { mgr, decide: gatewayDecide, manifest, mode: () => 'enforce' });
  return res ? { status: res.status, body: await res.json() as AuraErrorBody } : null;
};

test('gateway: the code stays gateway-denied (403); the body says why, for the app', async () => {
  // An app missing a declared permission.
  const perm = await viaGateway(gatewayCtx('com.other.app', 'POST', '/api/t/perm', '/api/t/perm'), T);
  assert.equal(perm?.status, 403);
  assert.equal(perm?.body.error, 'gateway-denied');
  assert.equal(perm?.body.reason, 'missing-permission');
  assert.equal(perm?.body.permission, 'apps.mount');
  assert.equal(perm?.body.holder, 'caller');
  assert.match(perm!.body.hint ?? '', /permissions\[\]/);
  assertNoLeak(perm?.body, 'gateway perm');

  // Not an OS API route, and a route without a rule: one cause, unclassified.
  for (const [path, route] of [['/somewhere', '/somewhere'], ['/api/not-in-the-manifest', '/api/not-in-the-manifest']] as const) {
    const r = await viaGateway(gatewayCtx('com.acme.notes', 'GET', path, route));
    assert.equal(r?.status, 403, path);
    assert.equal(r?.body.error, 'gateway-denied', path);
    assert.equal(r?.body.reason, 'unclassified', path);
    assert.match(r!.body.message, /not an OS API apps can call/, path);
  }

  // An owner route: no grant hint, nothing about the owner's tools.
  const admin = await viaGateway(gatewayCtx('com.acme.notes', 'GET', '/api/admin/access-report', '/api/admin/access-report'));
  assert.equal(admin?.status, 403);
  assert.equal(admin?.body.error, 'gateway-denied');
  assert.equal(admin?.body.category, 'not-grantable');
  assert.equal(admin?.body.hint, undefined);
  assertNoOwnerAgentHint(admin?.body, 'admin');

  // Another app's data: nothing about that app.
  const other = await viaGateway(gatewayCtx('com.acme.notes', 'GET', '/api/kv/app/com.other.app/k', '/api/kv/[...path]', { path: 'app/com.other.app/k' }));
  assert.equal(other?.status, 403);
  assert.doesNotMatch(JSON.stringify(other?.body), /com\.other\.app/);
});

test('gateway: an identity it cannot prove is one class (a forged claim, another instance, an expired one)', async () => {
  const path = '/api/os/themes';
  const bodies = [];
  for (const token of [
    'garbage',
    signGatewayClaim(claim('com.acme.notes', 'gone-1', 'GET', path)),
    signGatewayClaim(claim('com.acme.notes', 'com.acme.notes-1', 'GET', path, { iat: 1, exp: 2 })),
  ]) {
    const r = await viaGateway(gatewayCtx('com.acme.notes', 'GET', path, path, {}, token));
    assert.equal(r?.status, 401);
    bodies.push(r?.body);
  }
  assert.equal(bodies[0]?.error, 'gateway-identity-invalid');
  assert.deepEqual(bodies[1], bodies[0]);
  assert.deepEqual(bodies[2], bodies[0]);
  assert.doesNotMatch(JSON.stringify(bodies[0]), /signature|expired|instance id|nonce/i);
});

test('errorResponse(status, body): the one builder, JSON, no-store, nosniff; the old form also says message (Pass B)', async () => {
  const res = errorResponse(409, { error: 'x-code', message: 'A sentence.', hint: 'Do this.' });
  assert.equal(res.status, 409);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(await res.json(), { error: 'x-code', message: 'A sentence.', hint: 'Do this.' });
  const old = errorResponse('something failed', 500);
  assert.equal(old.status, 500);
  // D105 Pass B: `error` keeps the sentence for the clients that show it; `message` says it where the SDK and CLI read it.
  assert.deepEqual(await old.json(), { error: 'something failed', message: 'something failed' });
});
