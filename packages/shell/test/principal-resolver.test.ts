/**
 * Phase 3 Stage 0: one principal resolver (access/identify.ts `resolvePrincipal`)
 * behind `authenticate()` and the access report. Report-only: the routes that
 * act on a principal keep their pre-Stage-0 outcome (`authenticateLegacy`).
 *
 *   cd packages/shell && npx tsx --test test/principal-resolver.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InstanceTokens } from '@aura/core';
import type { GatewayIdentityClaim } from '@aura/core';
import { GATEWAY_IDENTITY_HEADER } from '@aura/core/host-rules';
import { createSessionLive } from '../server/app-host-auth.mjs';
import { signGatewayClaim } from '../server/gateway-identity.mjs';
import { resolvePrincipal, type GatewayOwnerDeps, type PrincipalDeps } from '../src/lib/access/identify.ts';
import { authenticate, authenticateLegacy, type AuthDeps } from '../src/lib/auth.ts';
import { sessionCookieToken } from '../src/lib/authSurface.ts';

const tokens = new InstanceTokens(join(mkdtempSync(join(tmpdir(), 'aura-resolver-')), 'secrets', 'k.key'));
const instances: Record<string, { appId: string; instanceId: string; owner?: string; inPool?: boolean; port?: number }> = {
  'com.acme.notes-1': { appId: 'com.acme.notes', instanceId: 'com.acme.notes-1', owner: 'default', inPool: false, port: 4001 },
  'com.aura.settings-1': { appId: 'com.aura.settings', instanceId: 'com.aura.settings-1', owner: 'default' },
};
const mgr = {
  tokens,
  getInstance: (id: string) => instances[id],
  getInstancesByApp: (appId: string) => Object.values(instances).filter((i) => i.appId === appId),
  getManifest: (id: string) => (id === 'com.aura.settings' ? { scopeId: 'system' } : { scopeId: 'user' }),
};

// One live owner login session; the rest are expired, revoked or forged.
const LIVE = 'aura-sess1.live.mac';
const SID = 'a'.repeat(32);
let revoked = false;
const login: NonNullable<PrincipalDeps['login']> = {
  cookieToken: sessionCookieToken,
  ownerSession: async (t) => (t === LIVE && !revoked ? { sessionId: SID, userId: 'default' } : null),
};
const ownerServices = (async () => ({
  registry: { getInstallation: async (id: string) => (id === 'inst-settings' ? { appId: 'com.aura.settings', scope: 'system', state: 'active' } : null) },
  sessionLive: async (sid: string, userId: string) => sid === SID && userId === 'default' && !revoked,
})) as unknown as GatewayOwnerDeps['services'];

const deps: AuthDeps = {
  mgr: mgr as never, ownerServices, login,
  apiKeys: { verify: async () => null },
  admin: { verifySession: async () => null },
};
const req = (headers: Record<string, string> = {}, path = '/api/notifications', method = 'GET') =>
  new Request(`http://127.0.0.1:3000${path}`, { method, headers });

function gateway(appId: string, instanceId: string, installationId: string, over: Partial<GatewayIdentityClaim> = {}, path = '/api/scopes') {
  const iat = Math.floor(Date.now() / 1000);
  const claim: GatewayIdentityClaim = {
    v: 1, appId, installationId, instanceId, label: 'x', slot: 1, origin: 'http://x--desk.example',
    userId: 'default', method: 'GET', path, iat, exp: iat + 30, ...over,
  };
  return req({ [GATEWAY_IDENTITY_HEADER]: signGatewayClaim(claim) }, path);
}

const USER = { kind: 'user', userId: 'default', role: 'owner', sessionId: SID, verification: 'verified' };

test('login cookie → the owner; legacy callers still see an anonymous screen with its hints', async () => {
  revoked = false;
  for (const cookie of [`aura_session=${LIVE}`, `theme=1; __Host-aura_session=${LIVE}`]) {
    assert.deepEqual(await authenticate(req({ cookie }), deps), USER);
  }
  const hinted = req({ cookie: `aura_session=${LIVE}`, 'x-aura-instance-id': 'com.acme.notes-1' });
  assert.deepEqual(await authenticate(hinted, deps), USER);
  assert.deepEqual(await authenticateLegacy(hinted, deps), {
    kind: 'anonymous', verification: 'unverified', hints: { appId: 'com.acme.notes', instanceId: 'com.acme.notes-1' },
  });
});

test('an expired, revoked or forged login cookie → anonymous, never a 401', async () => {
  revoked = false;
  for (const cookie of ['aura_session=aura-sess1.expired.mac', 'aura_session=forged', `aura_session=${LIVE}; aura_session=${LIVE}`]) {
    assert.deepEqual(await authenticate(req({ cookie }), deps), { kind: 'anonymous', verification: 'unverified' }, cookie);
  }
  revoked = true;
  assert.deepEqual(await authenticate(req({ cookie: `aura_session=${LIVE}` }), deps), { kind: 'anonymous', verification: 'unverified' });
  revoked = false;
  // A store that can't be read is not a request error for a cookie.
  const down: AuthDeps = { ...deps, login: { cookieToken: sessionCookieToken, ownerSession: async () => { throw new Error('valkey down'); } } };
  assert.deepEqual(await authenticate(req({ cookie: `aura_session=${LIVE}` }), down), { kind: 'anonymous', verification: 'unverified' });
});

test('an aura-sess1 bearer → the owner; invalid → 401; legacy callers keep their 401', async () => {
  revoked = false;
  assert.deepEqual(await authenticate(req({ authorization: `Bearer ${LIVE}` }), deps), USER);
  for (const p of [await authenticate(req({ authorization: 'Bearer aura-sess1.forged.mac' }), deps),
    await authenticateLegacy(req({ authorization: `Bearer ${LIVE}` }), deps)]) {
    assert.ok(p instanceof Response && p.status === 401);
    assert.match(await p.text(), /invalid or expired credential/);
  }
  // Without login services a session bearer can't be checked, and is still refused.
  const noLogin: AuthDeps = { ...deps, login: undefined };
  assert.equal(((await authenticate(req({ authorization: `Bearer ${LIVE}` }), noLogin)) as Response).status, 401);
  // A bearer wins over the cookie.
  const both = await authenticate(req({ authorization: 'Bearer nonsense', cookie: `aura_session=${LIVE}` }), deps);
  assert.ok(both instanceof Response && both.status === 401);
});

test('instance token → the instance acting for its `u` claim, else its owner; legacy strips the user', async () => {
  const owned = tokens.mint('com.acme.notes-1', undefined, 'default').token;
  const instance = { kind: 'instance', appId: 'com.acme.notes', instanceId: 'com.acme.notes-1', verification: 'verified' };
  assert.deepEqual(await authenticate(req({ authorization: `Bearer ${owned}` }), deps), { ...instance, userId: 'default' });
  const old = tokens.mint('com.acme.notes-1').token;  // minted before the claim: the server-side owner
  assert.deepEqual(await authenticate(req({ authorization: `Bearer ${old}` }), deps), { ...instance, userId: 'default' });
  assert.deepEqual(await authenticateLegacy(req({ authorization: `Bearer ${old}` }), deps), instance);
});

test('gateway claim → the instance, acting for the App Host session user only when the claim has one', async () => {
  const notes = (over: Partial<GatewayIdentityClaim>) => gateway('com.acme.notes', 'com.acme.notes-1', 'inst-notes', over);
  const instance = { kind: 'instance', appId: 'com.acme.notes', instanceId: 'com.acme.notes-1', verification: 'verified' };
  assert.deepEqual(await authenticate(notes({ sid: SID }), deps), { ...instance, userId: 'default' });
  // The runtime script's claim names a scope user and no session: nobody.
  assert.deepEqual(await authenticate(notes({ userId: 'shared' }), deps), instance);
  assert.deepEqual(await authenticateLegacy(notes({ sid: SID }), deps), instance);
  const forged = req({ [GATEWAY_IDENTITY_HEADER]: 'agw1.forged.sig' }, '/api/scopes');
  assert.equal(((await authenticate(forged, deps)) as Response).status, 401);
});

test('D45: the owner through system Settings → user through it; legacy callers still see its instance', async () => {
  revoked = false;
  const settings = gateway('com.aura.settings', 'com.aura.settings-1', 'inst-settings', { sid: SID, owner: { userId: 'default', sid: SID } });
  assert.deepEqual(await authenticate(settings, deps), {
    ...USER, through: { appId: 'com.aura.settings', instanceId: 'com.aura.settings-1' },
  });
  assert.deepEqual(await authenticateLegacy(settings, deps), {
    kind: 'instance', appId: 'com.aura.settings', instanceId: 'com.aura.settings-1', verification: 'verified',
  });
});

test('App Host cookie session (verified by app-hosts.mjs) → the owner acting through that app', async () => {
  const r = await resolvePrincipal(req({ authorization: 'Bearer the-apps-own-token' }), {
    mgr: mgr as never, apiKeys: null, admin: null, login,
  }, { appHost: { appId: 'com.acme.notes', instanceId: 'com.acme.notes-1', userId: 'default', sid: SID } });
  assert.deepEqual(r, {
    principal: { ...USER, through: { appId: 'com.acme.notes', instanceId: 'com.acme.notes-1' } },
    via: 'app-host',
  });
});

test('sessionLive: revoked, expired, another user or a disabled owner is not live', async () => {
  const live = new Map([[SID, 'default']]);
  let owner: { id: string; disabled?: boolean } | null = { id: 'default' };
  const check = createSessionLive({
    // LoginSessionStore.isLive: the nonce exists, is unexpired, and is this user's password session.
    sessions: { isLive: async (sid: string, userId: string) => live.get(sid) === userId },
    users: { getOwner: async () => owner },
  });
  assert.equal(await check(SID, 'default'), true);
  assert.equal(await check(SID, 'someone-else'), false, 'the user must match');
  assert.equal(await check(SID, ''), false);
  owner = { id: 'default', disabled: true };
  assert.equal(await check(SID, 'default'), false, 'a disabled owner');
  owner = { id: 'default' };
  live.delete(SID);
  assert.equal(await check(SID, 'default'), false, 'revoked or expired');
});
