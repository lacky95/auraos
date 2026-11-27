// D108 P8: the change routes (lib/setup/api.ts `handleChange`) against a fake
// SetupChangeContract: the change plan (POST, read-only), the last applied
// configuration and its restore (decision 13: the notice that data is not
// rolled back), the acting user's own Private Home grants and their
// revocation (DELETE, ?sidecar=), 503 without an engine, and the access
// manifest rows (another app's token refused; Terminal and owner pass).
//
//   node tools/run-tests.mjs --only=shell
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Authorizer } from '@aura/core';
import type {
  AccessPrincipal, InstancePrincipal, SetupActor, SetupChangeContract, SetupOutcome, SetupProposal, SetupServiceContract, SetupStateView,
} from '@aura/core';
import { RESTORE_NOTICE } from '@aura/core';
import { accessGate, type GateDeps } from '../src/lib/access/enforce.ts';
import { isTrustedOwnerAgent, type ResolvedPrincipal } from '../src/lib/access/identify.ts';
import type { ObserverManager } from '../src/lib/access/observer.ts';
import type { AccessVia } from '../src/lib/access/types.ts';
import { handleSetup, type SetupOp, type SetupRouteDeps } from '../src/lib/setup/api.ts';
import { SETUP_UNAVAILABLE } from '../src/lib/setup/service.ts';

const APP = 'com.example.mailer';
const HANDLE = 'cred_0123456789abcdefghijkl';
const SECRET_VALUE = 'hunter2-plain-secret';

const owner: AccessPrincipal = { kind: 'user', userId: 'default', role: 'owner', sessionId: 's', verification: 'verified' };
const member: AccessPrincipal = { kind: 'user', userId: 'u2', role: 'member', sessionId: 's2', verification: 'verified' };
const operator: AccessPrincipal = { kind: 'operator', verification: 'verified' };
const anon: AccessPrincipal = { kind: 'anonymous', verification: 'unverified' };
const inst = (appId: string, instanceId = `${appId}-1`, extra: Partial<InstancePrincipal> = {}): InstancePrincipal =>
  ({ kind: 'instance', appId, instanceId, verification: 'verified', ...extra });
const terminal = inst('com.aura.terminal', 'com.aura.terminal-1', { userId: 'default' });

const manifest = {
  id: APP,
  setup: {
    version: 1, requirements: [], renames: [],
    fields: { smtpHost: { type: 'string', title: 'SMTP host' }, password: { type: 'secret', title: 'SMTP password', secret: { source: 'ask' } } },
  },
  profiles: [{ id: 'team', title: 'Team', overlay: {}, setup: { fields: { teamKey: { type: 'secret', title: 'Team key' } } } }],
};

const view = (over: Partial<SetupStateView> = {}): SetupStateView => ({
  appId: APP, installationId: 'inst-1', declares: true, state: 'ready', profile: null, step: 'done', configDigest: 'd', degraded: [], ...over,
});

interface Call { op: string; proposal?: SetupProposal; actor?: SetupActor }

/** A fake engine that records its calls and answers `answer` for changes. */
function fakeService(answer: SetupOutcome | (() => never) = { status: 'ready', state: view() }): { svc: SetupServiceContract; calls: Call[] } {
  const calls: Call[] = [];
  const change = (op: string) => async (_app: string, a: SetupProposal | SetupActor, b?: SetupActor): Promise<SetupOutcome> => {
    calls.push(b === undefined ? { op, actor: a as SetupActor } : { op, proposal: a as SetupProposal, actor: b });
    return typeof answer === 'function' ? answer() : answer;
  };
  const svc: SetupServiceContract = {
    state: async () => { calls.push({ op: 'state' }); return view(); },
    profiles: async () => { calls.push({ op: 'profiles' }); return []; },
    plan: async (_a, proposal) => { calls.push({ op: 'plan', ...(proposal ? { proposal } : {}) }); return { appId: APP } as never; },
    values: async () => { calls.push({ op: 'values' }); return { appId: APP } as never; },
    setValues: change('setValues') as SetupServiceContract['setValues'],
    apply: change('apply') as SetupServiceContract['apply'],
    resume: change('resume') as SetupServiceContract['resume'],
    repair: change('repair') as SetupServiceContract['repair'],
    reconfigure: change('reconfigure') as SetupServiceContract['reconfigure'],
    selfConfig: async () => { throw new Error('not here'); },
    secretHandles: async (_a, actor) => { calls.push({ op: 'secrets', actor }); return [{ handle: HANDLE, label: 'smtp' }]; },
    askSecret: async (_a, field, actor) => { calls.push({ op: `askSecret:${field}`, actor }); return { approvalId: 'apr_1' }; },
  };
  return { svc, calls };
}

interface Who { principal: AccessPrincipal; via: AccessVia; rejected?: boolean }

function deps(who: Who, svc: SetupServiceContract | null, over: Partial<SetupRouteDeps> = {}): SetupRouteDeps {
  return {
    service: () => svc,
    resolve: async () => ({ principal: who.principal, via: who.via, ...(who.rejected ? { rejected: { reason: 'credential-invalid' } } : {}) }) as ResolvedPrincipal,
    manifest: (id) => (id === APP ? manifest as never : null),
    trustedTerminal: (p) => p.appId === 'com.aura.terminal' && p.instanceId === 'com.aura.terminal-1',
    shellOwner: async () => ({ error: 'forbidden-origin', status: 403 }),
    ...over,
  };
}

const BEARER = { authorization: 'Bearer aura1.token' };

async function call(
  op: SetupOp, who: Who, svc: SetupServiceContract | null,
  opts: { method?: string; body?: unknown; raw?: string; headers?: Record<string, string>; app?: string; field?: string; query?: string; over?: Partial<SetupRouteDeps> } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const method = opts.method ?? (['state', 'profiles', 'values', 'secrets'].includes(op) ? 'GET' : op === 'setValues' ? 'PUT' : 'POST');
  const text = method === 'GET' ? undefined : opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined);
  const request = new Request(`http://shell/api/apps/${opts.app ?? APP}/setup${opts.query ?? ''}`, {
    method,
    headers: { ...(text !== undefined ? { 'content-type': 'application/json' } : {}), ...BEARER, ...opts.headers },
    ...(text !== undefined ? { body: text } : {}),
  });
  const res = await handleSetup({ request, params: { id: opts.app ?? APP, ...(opts.field !== undefined ? { field: opts.field } : {}) }, cookies: {} as never }, op, deps(who, svc, opts.over));
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

const asOwner: Who = { principal: owner, via: 'login-session' };
const asTerminal: Who = { principal: terminal, via: 'instance-token' };

// ── who acts ────────────────────────────────────────────────────────────────

/** A fake change engine that records its calls. */
function fakeChange(): { ch: SetupChangeContract; calls: Array<{ op: string; proposal?: SetupProposal; actor?: SetupActor; sidecar?: string }> } {
  const calls: Array<{ op: string; proposal?: SetupProposal; actor?: SetupActor; sidecar?: string }> = [];
  const ch: SetupChangeContract = {
    changePlan: async (_a, proposal) => { calls.push({ op: 'changePlan', proposal }); return { appId: APP, grantDiff: { added: ['permission:priv.x'], removed: [], changed: true } } as never; },
    lastApplied: async () => { calls.push({ op: 'lastApplied' }); return { appId: APP, profile: null, configDigest: 'd', appliedAt: 'now', current: false, values: {}, secretFields: ['password'], notice: RESTORE_NOTICE }; },
    restoreLast: async (_a, actor) => { calls.push({ op: 'restore', actor }); return { status: 'on-hold', state: view({ state: 'awaiting-approval' }), approvalId: 'apr_9', notice: RESTORE_NOTICE }; },
    homePrivateGrants: async (_a, actor) => { calls.push({ op: 'homePrivate', actor }); return [{ permission: 'home.private' }]; },
    revokeHomePrivate: async (_a, actor, o) => { calls.push({ op: 'revoke', actor, ...(o?.sidecar !== undefined ? { sidecar: o.sidecar } : {}) }); return { revoked: ['home.private'], state: view({ state: 'blocked' }) }; },
    onManifestChanged: async () => { throw new Error('not a route'); },
  };
  return { ch, calls };
}

test('change plan: POST with a proposal, read-only, passed on as parsed; values for secret fields refused', async () => {
  const { svc } = fakeService();
  const { ch, calls } = fakeChange();
  const r = await call('changePlan', asTerminal, svc, { body: { profile: 'team' }, over: { change: () => ch } });
  assert.equal(r.status, 200);
  assert.deepEqual((r.body['grantDiff'] as { added: string[] }).added, ['permission:priv.x']);
  assert.deepEqual(calls[0], { op: 'changePlan', proposal: { profile: 'team' } });
  const bad = await call('changePlan', asOwner, svc, { body: { values: { password: SECRET_VALUE } }, over: { change: () => ch } });
  assert.equal(bad.status, 422);
  assert.ok(!JSON.stringify(bad.body).includes(SECRET_VALUE));
  assert.equal(calls.length, 1);
});

test('restore: GET shows the last applied configuration with the notice; POST restores (202 on hold) with the notice', async () => {
  const { svc } = fakeService();
  const { ch, calls } = fakeChange();
  const g = await call('lastApplied', asOwner, svc, { method: 'GET', over: { change: () => ch } });
  assert.equal(g.status, 200);
  assert.equal(g.body['notice'], RESTORE_NOTICE);
  assert.deepEqual((g.body['lastApplied'] as { secretFields: string[] }).secretFields, ['password']);
  const p = await call('restore', asTerminal, svc, { over: { change: () => ch } });
  assert.deepEqual([p.status, p.body['approvalId'], p.body['notice']], [202, 'apr_9', RESTORE_NOTICE]);
  assert.deepEqual(calls.at(-1), { op: 'restore', actor: { kind: 'terminal', userId: 'default', instanceId: 'com.aura.terminal-1' } });
  // A cookie restore needs the desktop's Origin (a change).
  const request = new Request('http://shell/x', { method: 'POST' });
  const res = await handleSetup({ request, params: { id: APP }, cookies: {} as never }, 'restore', deps(asOwner, svc, { change: () => ch }));
  assert.equal(res.status, 403);
});

test('home-private: GET lists the acting user\'s own grants; DELETE revokes (all, or ?sidecar=<n>) for the acting user only', async () => {
  const { svc } = fakeService();
  const { ch, calls } = fakeChange();
  const g = await call('homePrivate', asOwner, svc, { method: 'GET', over: { change: () => ch } });
  assert.deepEqual(g.body, [{ permission: 'home.private' }] as never);
  const d = await call('revokeHomePrivate', asTerminal, svc, { method: 'DELETE', over: { change: () => ch } });
  assert.deepEqual([d.status, d.body['revoked'], (d.body['state'] as { state: string }).state], [200, ['home.private'], 'blocked']);
  const s = await call('revokeHomePrivate', asOwner, svc, { method: 'DELETE', query: '?sidecar=terminal', over: { change: () => ch } });
  assert.equal(s.status, 200);
  assert.deepEqual(calls.slice(1).map((c) => [c.op, c.actor, c.sidecar]), [
    ['revoke', { kind: 'terminal', userId: 'default', instanceId: 'com.aura.terminal-1' }, undefined],
    ['revoke', { kind: 'user', userId: 'default' }, 'terminal'],
  ]);
  // Another app's token never revokes (or reads) anything.
  const o = await call('revokeHomePrivate', { principal: inst('com.acme.notes'), via: 'instance-token' }, svc, { method: 'DELETE', over: { change: () => ch } });
  assert.equal(o.status, 403);
  assert.equal(calls.length, 3);
});

test('without the change engine every P8 route answers 503 unavailable; a thrown D105 body is that body', async () => {
  const { svc } = fakeService();
  for (const [op, method] of [['changePlan', 'POST'], ['lastApplied', 'GET'], ['restore', 'POST'], ['homePrivate', 'GET'], ['revokeHomePrivate', 'DELETE']] as const) {
    const r = await call(op, asOwner, svc, { method, over: { change: () => null } });
    assert.deepEqual([r.status, r.body['error']], [503, SETUP_UNAVAILABLE.error], op);
  }
  const { ch } = fakeChange();
  ch.revokeHomePrivate = async () => { throw Object.assign(new Error('x'), { body: { error: 'setup-blocked', category: 'needs-setup', message: 'not available' } }); };
  const r = await call('revokeHomePrivate', asOwner, svc, { method: 'DELETE', over: { change: () => ch } });
  assert.deepEqual([r.status, r.body['error']], [409, 'setup-blocked']);
});

test('access manifest: the P8 routes refuse another app\'s token (its own app included); the Terminal and the owner pass', async () => {
  const instances: Record<string, { appId: string; instanceId: string; sandbox?: string; owner?: string }> = {
    'com.example.mailer-1': { appId: APP, instanceId: 'com.example.mailer-1', sandbox: 'container' },
    'com.aura.terminal-1': { appId: 'com.aura.terminal', instanceId: 'com.aura.terminal-1', sandbox: 'container', owner: 'default' },
  };
  const scopes: Record<string, string> = { [APP]: 'user', 'com.aura.terminal': 'system' };
  const mgr = {
    tokens: { hasNonce: () => false, verify: () => null },
    getInstance: (id: string) => instances[id],
    getInstancesByApp: (appId: string) => Object.values(instances).filter((i) => i.appId === appId),
    getAllInstances: () => Object.values(instances),
    getManifest: (id: string) => (scopes[id] ? { scopeId: scopes[id] } : undefined),
    isTrustedSystemCopy: (id: string) => scopes[id] === 'system',
    registry: { getById: (id: string) => (scopes[id] ? {} : undefined) },
  } as unknown as ObserverManager;
  const authorizer = new Authorizer({
    grants: { get: async () => null } as never,
    declared: () => [],
    appBinding: async (id: string) => ({ scope: scopes[id], installationId: scopes[id] ? 'inst-1' : null }),
  });
  const gate = async (principal: AccessPrincipal, via: AccessVia, route: string, method: string): Promise<string> => {
    const sub = route.slice('/api/apps/[id]/setup'.length);
    const url = new URL(`http://shell/api/apps/${APP}/setup${sub}`);
    const request = new Request(url, { method, ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}) });
    const d: GateDeps = {
      authorizer, ownerAgent: (p) => isTrustedOwnerAgent(p, mgr as never), mgr: () => mgr, services: () => null, redisReady: () => false,
      internalSecret: () => 'internal', instanceOwner: (id) => instances[id]?.owner ?? null,
      principal: async () => ({ principal: principal as never, via }), mode: () => 'enforce',
    };
    const r = await accessGate({ request, url, routePattern: route, params: { id: APP } } as never, d);
    return r.refused ? `${r.refused.status}` : 'pass';
  };
  const routes: Array<[string, string]> = [
    ['/api/apps/[id]/setup/change', 'POST'], ['/api/apps/[id]/setup/restore', 'GET'], ['/api/apps/[id]/setup/restore', 'POST'],
    ['/api/apps/[id]/setup/home-private', 'GET'], ['/api/apps/[id]/setup/home-private', 'DELETE'],
  ];
  for (const [route, method] of routes) {
    assert.equal(await gate(inst(APP, 'com.example.mailer-1'), 'instance-token', route, method), '403', `the app itself: ${method} ${route}`);
    assert.equal(await gate(terminal, 'instance-token', route, method), 'pass', `the Terminal: ${method} ${route}`);
    assert.equal(await gate(owner, 'login-session', route, method), 'pass', `the owner: ${method} ${route}`);
  }
});
