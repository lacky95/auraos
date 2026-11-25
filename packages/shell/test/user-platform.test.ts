// Phase 3b stream D: the user platform. `/api/user/me` and its profile
// (D46), the system id on what names a principal (D47), per-user events,
// and the rule that no code compares a user id to the literal 'default'.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getUserMe, patchMyProfile, type UserMeDeps } from '../src/lib/userMe.ts';
import { actingUserId, localOwnerId, principalUserId } from '../src/lib/userContext.ts';
import { instanceEventView } from '../src/lib/access/gatewayEvents.ts';
import { ROUTE_ACCESS_MANIFEST } from '../src/lib/access/routeManifest.ts';
import { ownerUiCovers } from '../server/gateway-identity.mjs';
import type { ResolvedPrincipal } from '../src/lib/access/identify.ts';

const SYS = '11111111-2222-4333-8444-555555555555';
const OWNER = { id: 'u-owner', username: 'lu', role: 'owner' as const, createdAt: 1, disabled: false };

function deps(resolved: ResolvedPrincipal, over: Partial<UserMeDeps> = {}) {
  const events: string[] = [];
  const audits: unknown[] = [];
  let profile: Record<string, string> = { displayName: 'Lu', locale: 'de-AT', recovery: 'never-to-apps' };
  const d: UserMeDeps = {
    resolve: async () => resolved,
    users: {
      getUser: async (id) => (id === OWNER.id ? OWNER : null),
      getProfile: async (id) => (id === OWNER.id ? profile : null),
      updateProfile: async (id, patch) => {
        if (id !== OWNER.id) return null;
        profile = { ...profile, ...patch.set };
        for (const f of patch.clear) delete profile[f];
        return profile;
      },
    },
    granted: async () => true,
    mgr: { getInstance: (id: string) => (id === 'com.ex.notes-1' ? { appId: 'com.ex.notes', instanceId: id, owner: OWNER.id } : undefined) } as never,
    systemId: () => SYS,
    changed: (u) => events.push(u),
    audit: async (e) => audits.push(e),
    ...over,
  };
  return { d, events, audits };
}

const req = (method = 'GET', body?: unknown, type = 'application/json') => new Request('http://shell.test/api/user/me/profile', {
  method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': type } } : {}),
});

const ownerLogin: ResolvedPrincipal = {
  principal: { kind: 'user', userId: OWNER.id, role: 'owner', sessionId: 'sess-secret-id', verification: 'verified', systemId: SYS },
  via: 'login-session',
};
const throughSettings: ResolvedPrincipal = {
  principal: { ...ownerLogin.principal, through: { appId: 'com.aura.settings', instanceId: 'com.aura.settings-1' } } as never,
  via: 'gateway',
};
const appPage: ResolvedPrincipal = {
  principal: { kind: 'instance', appId: 'com.ex.notes', instanceId: 'com.ex.notes-1', userId: OWNER.id, verification: 'verified' },
  via: 'gateway',
};
const appServer: ResolvedPrincipal = {
  principal: { kind: 'instance', appId: 'com.ex.notes', instanceId: 'com.ex.notes-1', verification: 'verified' },
  via: 'instance-token',
};
const appHostUser: ResolvedPrincipal = {
  principal: { ...ownerLogin.principal, through: { appId: 'com.ex.notes', instanceId: 'com.ex.notes-1' } } as never,
  via: 'app-host',
};

test('GET /api/user/me: the user themselves sees identity, system, ref and every profile field', async () => {
  const res = await getUserMe(req(), deps(ownerLogin).d);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await res.json(), {
    userId: OWNER.id, username: 'lu', role: 'owner', isOwner: true, verified: true,
    systemId: SYS, ref: `${OWNER.id}@${SYS}`,
    profile: { displayName: 'Lu', locale: 'de-AT' },
  });
});

test('GET /api/user/me: an app page gets the basic fields, verified by its App Host session', async () => {
  const body = await (await getUserMe(req(), deps(appPage).d)).json();
  assert.equal(body.verified, true);
  assert.equal(body.ref, `${OWNER.id}@${SYS}`);
  assert.deepEqual(body.profile, { displayName: 'Lu', locale: 'de-AT' });
});

test('GET /api/user/me: an app server names its owner, unverified; the App Host cookie is that app\'s view', async () => {
  const server = await (await getUserMe(req(), deps(appServer).d)).json();
  assert.equal(server.userId, OWNER.id);
  assert.equal(server.verified, false);
  const asked: string[] = [];
  const host = await (await getUserMe(req(), deps(appHostUser, { granted: async (_a, f) => { asked.push(f); return false; } }).d)).json();
  assert.deepEqual(host.profile, { displayName: 'Lu', locale: 'de-AT' });
  assert.deepEqual(asked, [], 'basic fields need no grant');
});

test('GET /api/user/me never returns a session id, claim, hash, other users or unknown fields', async () => {
  for (const r of [ownerLogin, throughSettings, appPage, appServer, appHostUser]) {
    const text = await (await getUserMe(req(), deps(r).d)).text();
    for (const bad of ['sess-secret-id', 'sessionId', 'passwordHash', 'recovery', 'never-to-apps', 'users']) {
      assert.equal(text.includes(bad), false, `${r.via}: ${bad}`);
    }
  }
});

test('GET /api/user/me: anonymous and rejected callers get 401; without an account nothing is invented', async () => {
  assert.equal((await getUserMe(req(), deps({ principal: { kind: 'anonymous', verification: 'unverified' }, via: 'none' }).d)).status, 401);
  assert.equal((await getUserMe(req(), deps({ ...appPage, rejected: { reason: 'gateway-identity-invalid' } }).d)).status, 401);
  const dark = await (await getUserMe(req(), deps(appServer, { users: { ...deps(appServer).d.users, getUser: async () => null } }).d)).json();
  assert.equal(dark.verified, false);
  assert.equal(dark.isOwner, false);
  assert.equal('username' in dark, false);
  assert.deepEqual(dark.profile, {});
});

test('PATCH /api/user/me/profile: the owner (desktop or Settings) changes it; validated; event and audit', async () => {
  for (const r of [ownerLogin, throughSettings]) {
    const { d, events, audits } = deps(r);
    const res = await patchMyProfile(req('PATCH', { displayName: 'Lukas', locale: null }), d);
    assert.equal(res.status, 200, r.via);
    assert.deepEqual((await res.json()).profile, { displayName: 'Lukas', recovery: 'never-to-apps' });
    assert.deepEqual(events, [OWNER.id]);
    assert.deepEqual(audits, [{ userId: OWNER.id, sessionId: 'sess-secret-id', fields: ['displayName', 'locale'] }]);
  }
  const bad = await patchMyProfile(req('PATCH', { displayName: '' }), deps(ownerLogin).d);
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).field, 'displayName');
  assert.equal((await patchMyProfile(req('PATCH', { userId: 'x' }), deps(ownerLogin).d)).status, 400);
});

test('PATCH /api/user/me/profile: refused for every app, a form post and anonymous callers', async () => {
  for (const r of [appPage, appServer, appHostUser]) {
    const { d, events } = deps(r);
    assert.equal((await patchMyProfile(req('PATCH', { displayName: 'x' }), d)).status, 403, r.via);
    assert.deepEqual(events, []);
  }
  assert.equal((await patchMyProfile(req('PATCH', { displayName: 'x' }, 'text/plain'), deps(ownerLogin).d)).status, 415);
  assert.equal((await patchMyProfile(req('PATCH', { displayName: 'x' }),
    deps({ principal: { kind: 'anonymous', verification: 'unverified' }, via: 'none' }).d)).status, 401);
});

test('the routes are in the access manifest, and Settings may call them as the owner (D45)', () => {
  const me = ROUTE_ACCESS_MANIFEST.routes['/api/user/me'];
  assert.deepEqual(me?.methods?.GET?.allow, ['own-instance', 'app-permission', 'owner']);
  assert.deepEqual(ROUTE_ACCESS_MANIFEST.routes['/api/user/me/profile']?.methods?.PATCH?.allow, ['owner']);
  assert.ok(ownerUiCovers('com.aura.settings', '/api/user/me'));
  assert.ok(ownerUiCovers('com.aura.settings', '/api/user/me/profile'));
  assert.equal(ownerUiCovers('com.aura.nexus', '/api/user/me/profile'), false);
  // App storage needs the app's own storage declarations.
  const kv = ROUTE_ACCESS_MANIFEST.routes['/api/kv/[...path]']!.variants!;
  assert.deepEqual(kv.find((v) => v.id === 'app-read')?.rule.targetPermissions, ['storage.read']);
  assert.deepEqual(kv.find((v) => v.id === 'app-write')?.rule.targetPermissions, ['storage.write']);
});

test('the acting user comes from the verified principal only', () => {
  const mgr = { getInstance: (id: string) => (id === 'i-1' ? { owner: 'u-2' } : undefined) } as never;
  assert.equal(principalUserId(ownerLogin.principal), OWNER.id);
  assert.equal(actingUserId(appServer.principal, null), localOwnerId());
  assert.equal(actingUserId({ kind: 'instance', appId: 'a.b', instanceId: 'i-1', verification: 'verified' }, mgr), 'u-2');
  assert.equal(actingUserId({ kind: 'operator', verification: 'verified' }, mgr), localOwnerId());
});

test('per-user events reach only an instance of that user; user:changed carries no values', () => {
  const mgr = { getInstance: (id: string) => (id === 'com.ex.notes-1' ? { appId: 'com.ex.notes', owner: OWNER.id } : undefined) } as never;
  const view = instanceEventView({ appId: 'com.ex.notes', instanceId: 'com.ex.notes-1' }, mgr);
  assert.equal(view.allows('user:changed', { userId: OWNER.id }), true);
  assert.equal(view.allows('user:changed', { userId: 'someone-else' }), false);
  assert.equal(view.allows('kv:changed', { namespace: 'os', key: 'theme', userId: OWNER.id }), true);
  assert.equal(view.allows('kv:changed', { namespace: 'os', key: 'theme', userId: 'someone-else' }), false);
  assert.equal(view.allows('kv:changed', { namespace: 'app/com.ex.notes', key: 'k', userId: 'someone-else' }), false);
  assert.equal(view.allows('kv:changed', { namespace: 'app/com.ex.notes', key: 'k', shared: true }), true);
});

// D47 rule 5: user ids are opaque. Nothing compares one to the bootstrap literal.
test('no shell, core or SDK code compares a user id to the literal \'default\'', () => {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const dirs = ['shell/src', 'shell/server', 'core/src', 'app-sdk/src'].map((d) => join(root, d));
  const pattern = /[!=]==?\s*['"`]default['"`]|['"`]default['"`]\s*[!=]==?/;
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { if (name !== 'node_modules' && name !== 'dist') walk(p); continue; }
      if (!/\.(ts|tsx|mjs|js|astro)$/.test(name)) continue;
      readFileSync(p, 'utf-8').split('\n').forEach((line, i) => { if (pattern.test(line)) hits.push(`${p}:${i + 1}: ${line.trim()}`); });
    }
  };
  dirs.forEach(walk);
  assert.deepEqual(hits, []);
});
