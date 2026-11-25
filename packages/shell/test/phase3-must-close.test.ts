// Phase 3a must-close sweep (stream C): one test per item that the other
// suites don't already cover (audit after outcome: gateway-owner-ui; OPEN_TERMINAL
// extras: terminal-embed; the Browser engine: browser-engine-sandbox).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OsEventBus } from '@aura/core';
import { GATEWAY_IDENTITY_HEADER } from '@aura/core/host-rules';
import { ownerUiCovers, signGatewayClaim } from '../server/gateway-identity.mjs';
import { instanceEventView, principalEventView } from '../src/lib/access/gatewayEvents.ts';
import { kvEventAllowed } from '../src/lib/access/kvAccess.ts';
import { explicitTargetRefusal } from '../src/lib/intentTarget.ts';
import { followSession, streamSessionOf } from '../src/lib/streamSession.ts';
import { POST as enabledRoute } from '../src/pages/api/admin/apps/enabled.ts';
import { GET as selfUpdateGet, POST as selfUpdatePost } from '../src/pages/api/admin/self-update.ts';
import { POST as manifestEditRoute } from '../src/pages/api/admin/manifest-edit.ts';
import { POST as openActivityRoute } from '../src/pages/api/instances/[instanceId]/activities.ts';

const G = globalThis as unknown as Record<string, unknown>;
const MANAGER = '__aura_app_manager__';
const AUTH_SERVICES = '__auraAuthServices';

async function withGlobals(values: Record<string, unknown>, run: () => Promise<void>): Promise<void> {
  const saved = Object.fromEntries(Object.keys(values).map((k) => [k, G[k]]));
  Object.assign(G, values);
  try { await run(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete G[k]; else G[k] = v; }
  }
}

const tick = () => new Promise((r) => setImmediate(r));
const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

// ── 2. event streams end with their sign-in ─────────────────────────────────

test('a stream follows its sign-in: the login, the App Host session; none for an app token or the operator', () => {
  const deps = { sessionLive: async () => true };
  const user = { kind: 'user', userId: 'u', role: 'owner', sessionId: 's1', verification: 'verified' } as const;
  const operator = { kind: 'operator', verification: 'verified' } as const;
  const inst = { kind: 'instance', appId: 'com.acme.notes', instanceId: 'com.acme.notes-1', verification: 'verified' } as const;
  const plain = new Request('http://x/api/apps/events');
  assert.ok(streamSessionOf(plain, user, deps));
  assert.equal(streamSessionOf(plain, operator, deps), null, 'a one-time ticket has no session to follow');
  assert.equal(streamSessionOf(plain, inst, deps), null);
  assert.equal(streamSessionOf(plain, null, deps), null);
  // An App Host frame: the session its gateway claim names.
  const iat = Math.floor(Date.now() / 1000);
  const claim = {
    v: 1 as const, appId: 'com.acme.notes', installationId: 'i', instanceId: 'com.acme.notes-1', label: 'l', slot: 1,
    origin: 'http://l--d.example', userId: 'u', sid: 's2', method: 'GET', path: '/api/apps/events', iat, exp: iat + 30,
  };
  const framed = new Request('http://x/api/apps/events', { headers: { [GATEWAY_IDENTITY_HEADER]: signGatewayClaim(claim) } });
  assert.ok(streamSessionOf(framed, null, deps));
  const { sid: _sid, ...noSession } = claim;
  const runtime = new Request('http://x/api/apps/events', { headers: { [GATEWAY_IDENTITY_HEADER]: signGatewayClaim(noSession) } });
  assert.equal(streamSessionOf(runtime, null, deps), null);
});

test('a session revocation ends the stream at once; expiry at the next heartbeat; a store failure ends it too', async () => {
  let live = true;
  let checked = '';
  const user = { kind: 'user', userId: 'u', role: 'owner', sessionId: 's1', verification: 'verified' } as const;
  const deps = {
    sessionLive: async (sid: string, userId: string) => { checked = `${sid}/${userId}`; return live; },
  };
  const session = streamSessionOf(new Request('http://x/'), user, deps)!;
  let ended = 0;
  const f = followSession(session, () => { ended += 1; });
  OsEventBus.emit('auth:sessionsRevoked', { count: 1 });
  await tick();
  assert.equal(ended, 0, 'another session was revoked');
  assert.equal(checked, 's1/u');
  live = false;
  OsEventBus.emit('auth:sessionsRevoked', { count: 1 });
  await tick();
  assert.equal(ended, 1, 'its own session was revoked');
  OsEventBus.emit('auth:sessionsRevoked', { count: 1 });
  f.recheck();
  await tick();
  assert.equal(ended, 1, 'once');

  const expiring = followSession(session, () => { ended += 1; });
  expiring.recheck();
  await tick();
  assert.equal(ended, 2, 'the heartbeat check catches expiry');

  const broken = streamSessionOf(new Request('http://x/'), user, { ...deps, sessionLive: async () => { throw new Error('valkey down'); } })!;
  assert.equal(await broken.live(), false, 'fails closed');
});

// ── 3 + 4. instances get their own view; os kv:changed is an allowlist ─────

test('an instance outside the gateway gets its own view; the System Terminal and the shell keep the whole stream', async () => {
  const instances: Record<string, { appId: string }> = {
    'com.acme.notes-1': { appId: 'com.acme.notes' },
    'com.aura.terminal-1': { appId: 'com.aura.terminal' },
  };
  const mgr = { getInstance: (id: string) => instances[id] } as never;
  const systemTerminal = async (appId: string) => appId === 'com.aura.terminal';
  const notes = { kind: 'instance', appId: 'com.acme.notes', instanceId: 'com.acme.notes-1', verification: 'verified' } as const;
  const view = await principalEventView(notes, mgr, systemTerminal);
  assert.ok(view);
  assert.equal(view.allows('app:stateChanged', { appId: 'com.acme.notes' }), true);
  assert.equal(view.allows('app:stateChanged', { appId: 'com.other.app' }), false);
  assert.equal(view.allows('ui:command', { id: '1', action: 'x' }), false);
  assert.equal(view.allows('kv:changed', { namespace: 'app/com.other.app', key: 'k' }), false);
  const terminal = { kind: 'instance', appId: 'com.aura.terminal', instanceId: 'com.aura.terminal-1', verification: 'verified' } as const;
  assert.equal(await principalEventView(terminal, mgr, systemTerminal), null, 'the owner\'s terminal: aura events');
  assert.ok(await principalEventView({ ...terminal, sidecar: 'agent' }, mgr, systemTerminal), 'its sidecars are scoped');
  assert.ok(await principalEventView(terminal, mgr, async () => false), 'a same-id copy in another scope is scoped');
  for (const p of [
    { kind: 'user', userId: 'u', role: 'owner', sessionId: 's', verification: 'verified' },
    { kind: 'anonymous', verification: 'unverified' },
  ] as const) {
    assert.equal(await principalEventView(p, mgr, systemTerminal), null, p.kind);
  }
});

test('kv:changed for `os` reaches an app only for the allowlisted keys', () => {
  for (const key of ['theme', 'keymap', 'clockFormat', 'locale', 'timeZone']) {
    assert.equal(kvEventAllowed('os', key, 'com.acme.notes'), true, key);
  }
  for (const key of ['lockscreen', 'workspaces', 'notifications', 'nexus/registries', 'app-enabled', 'desktop-session', undefined]) {
    assert.equal(kvEventAllowed('os', key, 'com.acme.notes'), false, String(key));
  }
  assert.equal(kvEventAllowed('app/com.acme.notes', 'k', 'com.acme.notes'), true);
  const view = instanceEventView({ appId: 'com.acme.notes', instanceId: 'n-1' }, { getInstance: () => ({ appId: 'com.acme.notes' }) } as never);
  assert.equal(view.allows('kv:changed', { namespace: 'os', key: 'theme', value: {} }), true);
  assert.equal(view.allows('kv:changed', { namespace: 'os', key: 'lockscreen', value: {} }), false);
});

// ── 6. an app cannot name a system app or a trusted UI as its intent target ─

test('an app\'s explicit intent target: never a system app or a trusted system UI', () => {
  const scopes: Record<string, string> = {
    'com.aura.settings': 'system', 'com.aura.terminal': 'system', 'com.aura.browser': 'system', 'com.acme.notes': 'user',
  };
  const instances: Record<string, { appId: string }> = { 'com.aura.settings-1': { appId: 'com.aura.settings' } };
  const mgr = {
    getInstance: (id: string) => instances[id],
    getManifest: (id: string) => (scopes[id] ? { scopeId: scopes[id] } : undefined),
  };
  const app = { appId: 'com.acme.notes' };
  const VIEW = 'aura.intent.action.VIEW';
  assert.match(String(explicitTargetRefusal({ action: VIEW, appId: 'com.aura.settings' }, app, mgr)), /system app/);
  assert.match(String(explicitTargetRefusal({ action: VIEW, appId: 'com.aura.browser' }, app, mgr)), /system app/);
  assert.match(String(explicitTargetRefusal({ action: VIEW, instanceId: 'com.aura.settings-1' }, app, mgr)), /system app/);
  // A user-scope copy of a trusted UI id is still refused.
  scopes['com.aura.nexus'] = 'user';
  assert.notEqual(explicitTargetRefusal({ action: VIEW, appId: 'com.aura.nexus' }, app, mgr), null);
  // Open: implicit resolution, an ordinary app, itself, and OPEN_TERMINAL to the Terminal (its own rules).
  assert.equal(explicitTargetRefusal({ action: VIEW }, app, mgr), null);
  assert.equal(explicitTargetRefusal({ action: VIEW, appId: 'com.acme.notes' }, app, mgr), null);
  assert.equal(explicitTargetRefusal({ action: VIEW, appId: 'com.aura.settings' }, { appId: 'com.aura.settings' }, mgr), null);
  assert.equal(explicitTargetRefusal({ action: 'aura.intent.action.OPEN_TERMINAL', appId: 'com.aura.terminal' }, app, mgr), null);
  assert.notEqual(explicitTargetRefusal({ action: VIEW, appId: 'com.aura.terminal' }, app, mgr), null);
});

// ── 9. notifications through Settings act for the owner ────────────────────

test('Settings covers the notifications group for the owner (D45); Nexus and the Terminal do not', () => {
  for (const path of ['/api/notifications', '/api/notifications/stream', '/api/notifications/ntf_1']) {
    assert.equal(ownerUiCovers('com.aura.settings', path), true, path);
    assert.equal(ownerUiCovers('com.aura.nexus', path), false, path);
    assert.equal(ownerUiCovers('com.aura.terminal', path), false, path);
  }
});

// ── 10. admin/apps/enabled and admin/self-update bodies ─────────────────────

test('apps/enabled checks what it is asked: a known app id, and never a critical app off', async () => {
  const calls: string[] = [];
  const mgr = {
    getManifest: (id: string) => ({ 'com.acme.notes': { id }, 'com.aura.registry': { id, critical: true } } as Record<string, unknown>)[id],
    setEnabled: async (id: string, on: boolean) => { calls.push(`${id}=${on}`); },
    getEnabledState: () => ({}),
  };
  await withGlobals({ [MANAGER]: mgr }, async () => {
    const call = async (body: unknown) => (await enabledRoute({ request: post('http://x/api/admin/apps/enabled', body) } as never) as Response).status;
    assert.equal(await call({ appId: '../x', enabled: false }), 400);
    assert.equal(await call({ appId: 'com.acme.notes', enabled: 'no' }), 400);
    assert.equal(await call(null), 400);
    assert.equal(await call({ appId: 'com.acme.gone', enabled: false }), 404);
    assert.equal(await call({ appId: 'com.aura.registry', enabled: false }), 409);
    assert.deepEqual(calls, [], 'nothing was changed');
  });
});

test('self-update: GET reads only and takes no path or git option; POST checks mode and branch', async () => {
  const get = async (q: string) => {
    const url = new URL(`http://x/api/admin/self-update${q}`);
    return (await selfUpdateGet({ url, request: new Request(url) } as never) as Response).status;
  };
  assert.equal(await get('?logs=../../aura/secrets/admin'), 400);
  assert.equal(await get('?job=../x'), 400);
  assert.equal(await get('?check=1&branch=--upload-pack%3Dtouch%20%2Ftmp%2Fx'), 400);
  const postStatus = async (body: unknown) =>
    (await selfUpdatePost({ request: post('http://x/api/admin/self-update', body) } as never) as Response).status;
  assert.equal(await postStatus({ mode: 'wipe' }), 400);
  assert.equal(await postStatus({ branch: '-u', dryRun: true }), 400);
});

// ── 11. aura grant/revoke perms refuses a system app ────────────────────────

test('manifest-edit refuses a permission change on a system app (Phase 6 overlay), not its tools', async () => {
  const auth = {
    version: Number.MAX_SAFE_INTEGER,
    apiKeys: { verify: async () => null },
    audit: { record: async () => undefined },
  };
  const mgr = {
    registry: {
      getScopeId: (id: string) => (id === 'com.aura.settings' ? 'system' : 'user'),
      getAppDir: () => '/nonexistent/aura-test-app',
    },
    getInstance: () => undefined,
    getInstancesByApp: () => [],
  };
  await withGlobals({ [MANAGER]: mgr, [AUTH_SERVICES]: auth }, async () => {
    const call = async (body: unknown) => {
      const res = await manifestEditRoute({ request: post('http://x/api/admin/manifest-edit', body) } as never) as Response;
      return { status: res.status, body: await res.json() as { error?: string; message?: string } };
    };
    for (const action of ['add-permission', 'remove-permission']) {
      const r = await call({ appId: 'com.aura.settings', action, permission: 'apps.mount' });
      assert.equal(r.status, 409, action);
      assert.equal(r.body.error, 'system-scope');
      assert.match(String(r.body.message), /Phase 6/);
    }
    // A user app, and a system app's tools, go on to the manifest (absent here: 404).
    assert.equal((await call({ appId: 'com.acme.notes', action: 'add-permission', permission: 'apps.mount' })).status, 404);
    assert.equal((await call({ appId: 'com.aura.settings', action: 'add-tool', tool: 'git' })).status, 404);
  });
});

// ── 12. aura open inst on an app without windows ────────────────────────────

test('opening an activity on an app with activityMode none answers 409, not 500', async () => {
  let opened = false;
  const mgr = {
    getInstance: (id: string) => (id === 'com.acme.bg-1' ? { instanceId: id, appId: 'com.acme.bg' } : undefined),
    getManifest: () => ({ componentType: 'activity', activityMode: 'none' }),
    openActivity: async () => { opened = true; throw new Error('should not be reached'); },
  };
  await withGlobals({ [MANAGER]: mgr }, async () => {
    const res = await openActivityRoute({
      params: { instanceId: 'com.acme.bg-1' }, request: post('http://x/api/instances/com.acme.bg-1/activities', {}),
    } as never) as Response;
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { error: string }).error, 'no-activities');
    assert.equal(opened, false);
  });
});
