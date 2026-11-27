// D108 P5: the setup API routes (lib/setup/api.ts) against a fake
// SetupServiceContract: who acts (owner, System Terminal for its user,
// operator; refusals), the body (SetupProposal only: no yes/force, secrets as
// vault handles only), SetupOutcome → HTTP, thrown D105 bodies, 503 without an
// engine, `setupState` in the app list, and the access manifest's refusal of
// other apps' tokens.
//
//   node tools/run-tests.mjs --only=shell
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Authorizer } from '@aura/core';
import type {
  AccessPrincipal, InstancePrincipal, SetupActor, SetupOutcome, SetupProposal, SetupServiceContract, SetupStateView,
} from '@aura/core';
import { accessGate, type GateDeps } from '../src/lib/access/enforce.ts';
import { isTrustedOwnerAgent, type ResolvedPrincipal } from '../src/lib/access/identify.ts';
import type { ObserverManager } from '../src/lib/access/observer.ts';
import type { AccessVia } from '../src/lib/access/types.ts';
import { errorStatus, handleSetup, outcomeStatus, parseProposal, type SetupOp, type SetupRouteDeps } from '../src/lib/setup/api.ts';
import { SETUP_UNAVAILABLE, setupStates } from '../src/lib/setup/service.ts';

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
  opts: { method?: string; body?: unknown; raw?: string; headers?: Record<string, string>; app?: string; over?: Partial<SetupRouteDeps> } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const method = opts.method ?? (['state', 'profiles', 'values'].includes(op) ? 'GET' : op === 'setValues' ? 'PUT' : 'POST');
  const text = method === 'GET' ? undefined : opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined);
  const request = new Request(`http://shell/api/apps/${opts.app ?? APP}/setup`, {
    method,
    headers: { ...(text !== undefined ? { 'content-type': 'application/json' } : {}), ...BEARER, ...opts.headers },
    ...(text !== undefined ? { body: text } : {}),
  });
  const res = await handleSetup({ request, params: { id: opts.app ?? APP }, cookies: {} as never }, op, deps(who, svc, opts.over));
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

const asOwner: Who = { principal: owner, via: 'login-session' };
const asTerminal: Who = { principal: terminal, via: 'instance-token' };

// ── who acts ────────────────────────────────────────────────────────────────

test('actor: the owner → user, the System Terminal by its token → terminal for its user, the operator → operator', async () => {
  const { svc, calls } = fakeService();
  assert.equal((await call('apply', asOwner, svc, { body: {} })).status, 200);
  assert.equal((await call('apply', asTerminal, svc, { body: {} })).status, 200);
  assert.equal((await call('apply', { principal: operator, via: 'operator-ticket' }, svc, { body: {} })).status, 200);
  assert.deepEqual(calls.map((c) => c.actor), [
    { kind: 'user', userId: 'default' },
    { kind: 'terminal', userId: 'default', instanceId: 'com.aura.terminal-1' },
    { kind: 'operator' },
  ]);
  // A Terminal token without a user claim acts for the owner whose instance it is.
  const { svc: s2, calls: c2 } = fakeService();
  await call('resume', { principal: inst('com.aura.terminal'), via: 'instance-token' }, s2);
  assert.deepEqual(c2[0]?.actor, { kind: 'terminal', userId: 'default', instanceId: 'com.aura.terminal-1' });
});

test('actor refusals: anonymous, a bad credential, a member, another Aura, the owner inside an app page, other apps, a Terminal sidecar or gateway call', async () => {
  const { svc, calls } = fakeService();
  const refused: Array<[Who, number, string]> = [
    [{ principal: anon, via: 'instance-id-hint' }, 401, 'unauthenticated'],
    [{ principal: anon, via: 'foreign-or-invalid', rejected: true }, 401, 'invalid-credential'],
    [{ principal: member, via: 'login-session' }, 403, 'owner-required'],
    [{ principal: { ...owner, systemId: 'another-aura' } as AccessPrincipal, via: 'login-session' }, 403, 'foreign-system'],
    [{ principal: { ...owner, through: { appId: 'com.acme.notes', instanceId: 'com.acme.notes-1' } } as AccessPrincipal, via: 'app-host' }, 403, 'owner-required'],
    [{ principal: inst('com.acme.notes'), via: 'instance-token' }, 403, 'access-denied'],
    [{ principal: inst('com.aura.terminal', 'com.aura.terminal-2', { userId: 'u2' }), via: 'instance-token' }, 403, 'access-denied'],
    [{ principal: inst('com.aura.terminal', 'com.aura.terminal-1', { sidecar: 'x' }), via: 'instance-token' }, 403, 'access-denied'],
    [{ principal: terminal, via: 'gateway' }, 403, 'access-denied'],
  ];
  for (const [who, status, error] of refused) {
    for (const op of ['state', 'apply'] as const) {
      const r = await call(op, who, svc, { body: {} });
      assert.equal(r.status, status, `${op} ${JSON.stringify(who.principal)}`);
      assert.equal(r.body['error'], error);
    }
  }
  assert.equal(calls.length, 0, 'the engine is never reached');
});

test('the owner through Settings (D45 gateway) acts as the owner; a cookie change needs the desktop Origin', async () => {
  const { svc, calls } = fakeService();
  const through: Who = { principal: { ...owner, through: { appId: 'com.aura.settings', instanceId: 'com.aura.settings-1' } } as AccessPrincipal, via: 'gateway' };
  assert.equal((await call('apply', through, svc, { body: {} })).status, 200);
  assert.deepEqual(calls[0]?.actor, { kind: 'user', userId: 'default' });
  // A login cookie without a bearer: a change asks shellOwner (the Origin); a read does not.
  const cookie = async (op: SetupOp, ok: boolean) => {
    const request = new Request('http://shell/x', { method: op === 'state' ? 'GET' : 'POST' });
    const res = await handleSetup({ request, params: { id: APP }, cookies: {} as never }, op,
      deps(asOwner, svc, { shellOwner: async () => (ok ? { identity: {} } : { error: 'forbidden-origin', status: 403 }) }));
    return res.status;
  };
  assert.equal(await cookie('apply', false), 403);
  assert.equal(await cookie('apply', true), 200);
  assert.equal(await cookie('state', false), 200);
});

// ── the body ────────────────────────────────────────────────────────────────

test('body: a SetupProposal is passed on as parsed', async () => {
  const { svc, calls } = fakeService();
  const body = { profile: 'team', values: { smtpHost: 'mail.example', port: 587, tls: true, tags: ['a'] }, secrets: { password: HANDLE }, overrides: { homeEnvironment: 'private' } };
  assert.equal((await call('apply', asOwner, svc, { body })).status, 200);
  assert.deepEqual(calls[0]?.proposal, body);
  await call('plan', asOwner, svc, { method: 'POST', body: { profile: 'team' } });
  await call('plan', asOwner, svc, { method: 'GET' });
  assert.deepEqual(calls.slice(1).map((c) => [c.op, c.proposal]), [['plan', { profile: 'team' }], ['plan', undefined]]);
});

test('body: no yes/force, unknown keys, bad shapes → 422 config-invalid; the engine is not called', async () => {
  const { svc, calls } = fakeService();
  for (const body of [{ yes: true }, { force: true }, { profile: 'team', approve: 1 }]) {
    const r = await call('apply', asTerminal, svc, { body });
    assert.equal(r.status, 422);
    assert.equal(r.body['error'], 'config-invalid');
    assert.equal(r.body['category'], 'invalid-request');
    assert.match(String(r.body['hint']), /no approval is ever skipped/);
  }
  for (const body of [[], 'x', { profile: 'Not A Profile' }, { values: [] }, { values: { 'bad name': 1 } }, { values: { a: { nested: 1 } } },
    { overrides: { network: 'shared' } }, { overrides: { homeEnvironment: 'root' } }, { secrets: 'x' }]) {
    const r = await call('apply', asOwner, svc, { body });
    assert.equal(r.status, 422, JSON.stringify(body));
  }
  assert.equal((await call('apply', asOwner, svc, { raw: '{not json' })).status, 422);
  assert.equal((await call('apply', asOwner, svc, { raw: 'profile=team', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).status, 415);
  assert.equal(calls.length, 0);
});

test('body: secrets only as vault handles; a value for a secret field (base or profile) is refused and never echoed', async () => {
  const { svc, calls } = fakeService();
  for (const body of [
    { secrets: { password: SECRET_VALUE } },
    { values: { password: SECRET_VALUE } },
    { values: { teamKey: SECRET_VALUE } },
    { secrets: { smtpHost: HANDLE } },
  ]) {
    const r = await call('setValues', asOwner, svc, { body });
    assert.equal(r.status, 422, JSON.stringify(body));
    assert.ok(!JSON.stringify(r.body).includes(SECRET_VALUE), 'the value is not in the answer');
    assert.ok(r.body['fieldErrors'], JSON.stringify(r.body));
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(parseProposal({ secrets: { teamKey: HANDLE } }, new Set(['teamKey'])), { secrets: { teamKey: HANDLE } });
});

test('resume takes no proposal; an unknown app is 404', async () => {
  const { svc, calls } = fakeService();
  await call('resume', asOwner, svc, { body: { profile: 'team' } });
  assert.deepEqual(calls[0], { op: 'resume', actor: { kind: 'user', userId: 'default' } });
  assert.equal((await call('apply', asOwner, svc, { body: {}, app: 'com.example.none' })).status, 404);
});

// ── the answer ──────────────────────────────────────────────────────────────

test('outcome → status: 200 ready/unchanged, 202 on-hold (approvalId) and initializing, 409 needs-setup, 422 invalid', async () => {
  const cases: Array<[SetupOutcome, number]> = [
    [{ status: 'ready', state: view() }, 200],
    [{ status: 'unchanged', state: view() }, 200],
    [{ status: 'on-hold', state: view({ state: 'awaiting-approval', approvalId: 'apr_1' }), approvalId: 'apr_1' }, 202],
    [{ status: 'initializing', state: view({ state: 'initializing' }) }, 202],
    [{ status: 'refused', state: view({ state: 'blocked' }), error: { error: 'setup-blocked', category: 'needs-setup', message: 'blocked' } }, 409],
    [{ status: 'refused', state: view(), error: { error: 'requirement-unsupported', category: 'unsupported-feature', message: 'no' } }, 409],
    [{ status: 'refused', state: view(), error: { error: 'config-invalid', category: 'invalid-request', message: 'bad', fieldErrors: { a: 'x' } } }, 422],
    [{ status: 'refused', state: view() }, 409],
  ];
  for (const [o, status] of cases) {
    assert.equal(outcomeStatus(o), status, o.status);
    const r = await call('apply', asTerminal, fakeService(o).svc, { body: { profile: 'team' } });
    assert.equal(r.status, status);
    assert.deepEqual(r.body, JSON.parse(JSON.stringify(o)), 'plain data: the outcome as it is');
  }
  assert.equal(errorStatus({ category: 'invalid-request' }), 422);
  assert.equal(errorStatus({ category: 'needs-setup' }), 409);
});

test('a thrown engine error with a D105 body is that body; anything else is a plain 500', async () => {
  const body = { error: 'profile-required', category: 'needs-setup', message: 'choose a profile', suggest: ['personal', 'team'] };
  const thrown = fakeService(() => { throw Object.assign(new Error('profile-required'), { code: 'profile-required', body }); });
  const r = await call('apply', asTerminal, thrown.svc, { body: {} });
  assert.equal(r.status, 409);
  assert.deepEqual(r.body, body);
  const unknown = fakeService(() => { throw Object.assign(new Error('unknown-profile'), { body: { error: 'unknown-profile', category: 'invalid-request', message: 'no such profile x' } }); });
  assert.equal((await call('apply', asTerminal, unknown.svc, { body: { profile: 'x' } })).status, 422);
  const boom = fakeService(() => { throw new Error('kv down'); });
  const warn = console.warn; console.warn = () => undefined;
  try {
    const r2 = await call('apply', asTerminal, boom.svc, { body: {} });
    assert.equal(r2.status, 500);
    assert.ok(!JSON.stringify(r2.body).includes('kv down'));
  } finally { console.warn = warn; }
});

test('without a setup engine every route answers 503 unavailable, never success', async () => {
  for (const op of ['state', 'profiles', 'plan', 'values', 'setValues', 'apply', 'resume', 'repair', 'reconfigure'] as const) {
    const r = await call(op, asOwner, null, { body: {} });
    assert.equal(r.status, 503, op);
    assert.deepEqual(r.body, SETUP_UNAVAILABLE);
  }
  // Body validation still answers first.
  assert.equal((await call('apply', asOwner, null, { body: { yes: true } })).status, 422);
});

test('reads return the engine views as they are', async () => {
  const { svc } = fakeService();
  assert.deepEqual((await call('state', asTerminal, svc)).body, view());
  assert.deepEqual((await call('profiles', asTerminal, svc)).body, []);
});

// ── the app list ────────────────────────────────────────────────────────────

test('setupStates: only apps that declare setup or profiles; unknown when the engine is missing or fails', async () => {
  const manifests = [{ id: 'com.simple' }, { id: APP, setup: {} }, { id: 'com.p', profiles: [{ id: 'a' }] }, { id: 'com.empty', profiles: [] }];
  const { svc } = fakeService();
  assert.deepEqual([...(await setupStates(manifests, svc)).entries()].sort(), [['com.p', 'ready'], [APP, 'ready']].sort());
  assert.deepEqual([...(await setupStates(manifests, null)).entries()].sort(), [['com.p', 'unknown'], [APP, 'unknown']].sort());
  const failing = { ...svc, state: async () => { throw new Error('x'); } };
  assert.equal((await setupStates(manifests, failing)).get(APP), 'unknown');
});

// ── the access manifest (who reaches the handler at all) ────────────────────

test('access manifest: another app\'s token is refused on every setup route, its own app included; the Terminal and the owner pass', async () => {
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
    const request = new Request(url, { method, ...(method !== 'GET' ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}) });
    const d: GateDeps = {
      authorizer, ownerAgent: (p) => isTrustedOwnerAgent(p, mgr as never), mgr: () => mgr, services: () => null, redisReady: () => false,
      internalSecret: () => 'internal', instanceOwner: (id) => instances[id]?.owner ?? null,
      principal: async () => ({ principal: principal as never, via }), mode: () => 'enforce',
    };
    const r = await accessGate({ request, url, routePattern: route, params: { id: APP } } as never, d);
    return r.refused ? `${r.refused.status}` : 'pass';
  };
  const routes: Array<[string, string]> = [
    ['/api/apps/[id]/setup', 'GET'], ['/api/apps/[id]/setup/profiles', 'GET'], ['/api/apps/[id]/setup/plan', 'POST'],
    ['/api/apps/[id]/setup/values', 'GET'], ['/api/apps/[id]/setup/values', 'PUT'], ['/api/apps/[id]/setup/apply', 'POST'],
    ['/api/apps/[id]/setup/resume', 'POST'], ['/api/apps/[id]/setup/repair', 'POST'], ['/api/apps/[id]/setup/reconfigure', 'POST'],
  ];
  for (const [route, method] of routes) {
    assert.equal(await gate(inst(APP, 'com.example.mailer-1'), 'instance-token', route, method), '403', `the app itself: ${method} ${route}`);
    assert.equal(await gate(terminal, 'instance-token', route, method), 'pass', `the Terminal: ${method} ${route}`);
    assert.equal(await gate(owner, 'login-session', route, method), 'pass', `the owner: ${method} ${route}`);
  }
});
