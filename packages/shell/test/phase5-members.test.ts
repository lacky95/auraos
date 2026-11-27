// Phase 5 I.2 part 2 (D82) in the shell: a member reaches only its own
// instances of apps it holds `app.use` for (`memberPermissions`), the accounts
// routes are the host operator's alone, members exist only in `enforce`, and
// the handler audit's one owner test (`isOwnerPrincipal`, D85 A1 included).
//
//   cd packages/shell && npx tsx --test test/phase5-members.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Authorizer, GrantStore } from '@aura/core';
import type { AccessPrincipal, InstancePrincipal, UserPrincipal } from '@aura/core';
import { localSystemId } from '@aura/core/system-identity';
import { createDecide, type DecideDeps } from '../src/lib/access/decide.ts';
import { isOwnerPrincipal } from '../src/lib/access/identify.ts';
import { ROUTE_ACCESS_MANIFEST } from '../src/lib/access/routeManifest.ts';
import { SURFACE_MANIFEST } from '../src/lib/access/surfaceManifest.ts';
import type { AccessLabel, AccessRule, AccessVia, DecideInput, PolicyResource } from '../src/lib/access/types.ts';
import { checkPermissions } from '../src/lib/appContract.ts';
import { userSessionOf } from '../src/lib/authSurface.ts';
import { createSessionLive } from '../server/app-host-auth.mjs';

const SYS = localSystemId();
const MEMBER = 'uaaaaaaaaaaaaaaa';
const OTHER = 'ubbbbbbbbbbbbbbb';
const owner: UserPrincipal = { kind: 'user', userId: 'default', role: 'owner', sessionId: 's1', verification: 'verified', systemId: SYS };
const member: UserPrincipal = { kind: 'user', userId: MEMBER, role: 'member', sessionId: 's2', verification: 'verified', systemId: SYS };
const operator = { kind: 'operator', verification: 'verified' } as unknown as AccessPrincipal;
const inst = (appId: string, extra: Partial<InstancePrincipal> = {}): InstancePrincipal =>
  ({ kind: 'instance', appId, instanceId: `${appId}-1`, verification: 'verified', systemId: SYS, ...extra });

const INSTANCES: Record<string, string | null> = { 'com.aura.terminal-1': 'default', 'com.aura.terminal-2': MEMBER, 'com.aura.terminal-3': null, 'com.aura.terminal-4': OTHER };

function setup() {
  const held = new Set<string>();
  const grants = {
    get: async (s: { kind: string; id: string }, p: string) => (held.has(`${s.kind}:${s.id}|${p}`) ? { permission: p } : null),
  } as unknown as GrantStore;
  const deps: DecideDeps = {
    authorizer: new Authorizer({ grants, declared: () => [], appBinding: async () => ({ scope: 'system', installationId: 'inst-1' }) }),
    instanceOwner: (id) => INSTANCES[id] ?? null,
    installationOf: async (appId) => (appId === 'com.aura.terminal' ? 'inst-term' : null),
  };
  return { d: createDecide(deps), grant: (userId: string, p: string) => held.add(`user:${userId}|${p}`) };
}

const input = (principal: AccessPrincipal, rule: AccessRule, resource: Partial<PolicyResource> = {}, via: AccessVia = 'login-session'): DecideInput => ({
  principal,
  action: { surface: 'api', subject: '/api/x' as AccessLabel, method: 'GET', variant: null, rule },
  resource: { target: rule.target, ...resource },
  transport: 'http', auth: { fresh: false, via }, accessProfile: 'open', systemMode: 'normal', deployment: 'private',
});

const route = (path: string, method = 'POST') => {
  const r = ROUTE_ACCESS_MANIFEST.routes[path]?.methods?.[method as 'POST'];
  assert.ok(r, `${method} ${path} has a rule`);
  return r!;
};
const surface = (id: string) => SURFACE_MANIFEST.find((s) => s.id === id)!.rule as AccessRule;

test('D82: a member opens its own instance of an app it holds app.use for, and nothing else', async () => {
  const { d, grant } = setup();
  const proxy = route('/api/proxy/[id]/[...path]', 'GET');
  const own = { appId: 'com.aura.terminal', instanceId: 'com.aura.terminal-2' };
  assert.deepEqual(await d(input(member, proxy, own)), { outcome: 'deny', reason: 'missing-permission' }, 'no grant yet');
  grant(MEMBER, 'app.use:inst-term');
  assert.deepEqual(await d(input(member, proxy, own)), { outcome: 'allow', reason: 'app-permission' });
  assert.deepEqual(await d(input(member, proxy, { appId: 'com.aura.terminal' })), { outcome: 'allow', reason: 'app-permission' }, 'a bare app id: the route picks its own');
  for (const instanceId of ['com.aura.terminal-1', 'com.aura.terminal-3', 'com.aura.terminal-4', 'gone']) {
    assert.deepEqual(await d(input(member, proxy, { appId: 'com.aura.terminal', instanceId })), { outcome: 'deny', reason: 'wrong-target' }, instanceId);
  }
  // app.jump is not app.use; another app's installation is not this one's.
  const { d: d2, grant: g2 } = setup();
  g2(MEMBER, 'app.jump:inst-term');
  assert.equal((await d2(input(member, proxy, own))).outcome, 'deny');
  assert.deepEqual(await d(input(member, proxy, { appId: 'io.ex.other' })), { outcome: 'deny', reason: 'missing-permission' }, 'no installation: not held');
  // Starting: the same grant; the owner and the operator as before.
  const start = route('/api/apps/[id]/start');
  assert.equal((await d(input(member, start, { appId: 'com.aura.terminal' }))).outcome, 'allow');
  assert.equal((await d(input(owner, start, { appId: 'io.ex.other' }))).outcome, 'allow');
  assert.equal((await d(input({ ...member, userId: OTHER }, start, { appId: 'com.aura.terminal' }))).outcome, 'deny', 'another member: its own grants only');
  // An app instance gets nothing from memberPermissions (its own rules decide).
  assert.equal((await d(input(inst('io.ex.app', { userId: MEMBER }), start, { appId: 'com.aura.terminal' }, 'instance-token'))).outcome, 'deny');
  // D85 A1: a foreign member with the same id and grant is refused first.
  assert.deepEqual(await d(input({ ...member, systemId: 'another-aura' }, proxy, own)), { outcome: 'deny', reason: 'foreign-system' });
});

test('D82: the App Host, its event streams and WebSocket upgrades take the same member rule', async () => {
  const { d, grant } = setup();
  grant(MEMBER, 'app.use:inst-term');
  for (const id of ['app-hosts', 'sse-mux', 'ws-proxy', 'terminal-pty', 'app-mcp']) {
    const rule = surface(id);
    assert.deepEqual(rule.memberPermissions, ['app.use:<installationId>'], id);
    assert.equal((await d(input(member, rule, { appId: 'com.aura.terminal', instanceId: 'com.aura.terminal-2' }))).outcome, 'allow', id);
    assert.equal((await d(input(member, rule, { appId: 'com.aura.terminal', instanceId: 'com.aura.terminal-1' }))).outcome, 'deny', id);
  }
  // The desktop's own sockets stay the owner's.
  for (const id of ['socketio-os-events', 'socketio-kv']) assert.equal(surface(id).memberPermissions, undefined, id);
  // The router decides a member's session on the slot's instance; the WS proxy on the chosen one.
  const src = (f: string) => readFileSync(new URL(`../server/${f}`, import.meta.url), 'utf8');
  assert.match(src('app-hosts.mjs'), /role !== 'owner' && !instanceId\) return false/);
  assert.match(src('attach.mjs'), /appId: chosenAppId, instanceId: chosenInstanceId, identity/);
  assert.match(src('attach.mjs'), /SESSION_HOST_APPS\.has\(appId\) \? memberId \?\? callerUser : memberId/);
});

test('D82: a member signs itself out and reads its own session; it reaches no owner route', async () => {
  const { d } = setup();
  for (const [path, method] of [['/api/auth/logout', 'POST'], ['/api/auth/session', 'GET'], ['/api/auth/whoami', 'GET'], ['/api/app-hosts/handoff', 'POST']] as const) {
    assert.equal((await d(input(member, route(path, method)))).outcome, 'allow', path);
  }
  for (const [path, method] of [['/api/auth/password', 'POST'], ['/api/auth/account', 'GET'], ['/api/admin/grants', 'POST'], ['/api/apps', 'GET'], ['/api/admin/users', 'GET']] as const) {
    assert.equal((await d(input(member, route(path, method)))).outcome, 'deny', path);
  }
});

test('D82: accounts are the host operator\'s alone, in every mode; not the owner\'s login, not an owner agent', async () => {
  const deps: DecideDeps = {
    authorizer: new Authorizer({ grants: { get: async () => null } as unknown as GrantStore, declared: () => [], appBinding: async () => ({ scope: 'system', installationId: 'inst-1' }) }),
    ownerAgent: () => true,
  };
  const d = createDecide(deps);
  for (const [path, method] of [['/api/admin/users', 'GET'], ['/api/admin/users', 'POST'], ['/api/admin/users/[id]', 'POST'], ['/api/admin/users/[id]/grants', 'POST']] as const) {
    const rule = route(path, method);
    assert.equal(rule.guard, 'rule', `${path}: decided in every access mode`);
    assert.deepEqual(rule.credentials, ['operator-ticket'], path);
    assert.equal((await d(input(operator, rule, {}, 'operator-ticket'))).outcome, 'allow', path);
    assert.equal((await d(input(owner, rule))).outcome, 'deny', `${path}: the owner's login`);
    assert.equal((await d(input(inst('com.aura.terminal'), rule, {}, 'instance-token'))).outcome, 'deny', `${path}: the System Terminal`);
    assert.equal((await d(input(member, rule))).outcome, 'deny', path);
  }
});

test('D82: members sign in and act only while the policy is enforced; the owner always', async () => {
  const accounts: Record<string, { id: string; username: string; role: 'owner' | 'member'; createdAt: number; disabled: boolean }> = {
    default: { id: 'default', username: 'lukas', role: 'owner', createdAt: 1, disabled: false },
    [MEMBER]: { id: MEMBER, username: 'bob', role: 'member', createdAt: 2, disabled: false },
  };
  const svc = {
    loginSessions: { verify: async (t: string | null | undefined) => (t === 'tOwner' ? { sessionId: 'a'.repeat(32), userId: 'default', method: 'password' as const, expiresAt: 1 }
      : t === 'tBob' ? { sessionId: 'b'.repeat(32), userId: MEMBER, method: 'password' as const, expiresAt: 1 } : null) },
    users: { getUser: async (id: string) => accounts[id] ?? null },
  };
  assert.equal(await userSessionOf('tBob', svc, () => false), null, 'report/off: no member session');
  assert.equal((await userSessionOf('tBob', svc, () => true))?.user.id, MEMBER);
  assert.equal((await userSessionOf('tOwner', svc, () => false))?.user.id, 'default');
  const live = (members: boolean) => createSessionLive({
    sessions: { isLive: async () => true }, users: { getUser: async (id: string) => accounts[id] ?? null }, members: () => members,
  });
  assert.equal(await live(false)('b'.repeat(32), MEMBER), false);
  assert.deepEqual(await live(true)('b'.repeat(32), MEMBER), { role: 'member' });
  assert.deepEqual(await live(false)('a'.repeat(32), 'default'), { role: 'owner' });
  const src = readFileSync(new URL('../src/lib/authSurface.ts', import.meta.url), 'utf8');
  assert.match(src, /check\.user\.role !== 'owner' && !membersAllowed\(\)\) return json\(\{ error: 'members-need-enforce' \}, 403\)/);
  assert.match(readFileSync(new URL('../src/lib/usersAdmin.ts', import.meta.url), 'utf8'), /if \(!membersAllowed\(\)\) \{/);
});

test('handler audit: one owner test; a member, a foreign owner and an app are not the owner', async () => {
  assert.equal(isOwnerPrincipal(operator), true);
  assert.equal(isOwnerPrincipal(owner), true);
  const { systemId: _s, ...localOwner } = owner;
  assert.equal(isOwnerPrincipal(localOwner), true, 'absent systemId is local');
  assert.equal(isOwnerPrincipal({ ...owner, systemId: 'another-aura' }), false, 'D85 A1');
  assert.equal(isOwnerPrincipal(member), false);
  assert.equal(isOwnerPrincipal(inst('com.aura.terminal')), false);
  assert.equal(isOwnerPrincipal(null), false);
  // /api/user/me/permissions: a member is asked as itself (its user grants), never "the owner holds all".
  const asked: string[] = [];
  const res = await checkPermissions(new Request('http://shell/api/user/me/permissions?p=apps.manage&p=app.use:i1'), {
    resolve: async () => ({ principal: member, via: 'login-session' }),
    held: async (p, n) => { asked.push(`${p.kind}:${n}`); return n === 'app.use:i1'; },
  });
  assert.deepEqual(await res.json(), { permissions: { 'apps.manage': false, 'app.use:i1': true } });
  assert.deepEqual(asked, ['user:apps.manage', 'user:app.use:i1']);
  // Handlers that trusted any verified user as the owner now ask the one test.
  const lib = (f: string) => readFileSync(new URL(`../src/lib/${f}`, import.meta.url), 'utf8');
  assert.doesNotMatch(lib('appSource.ts'), /principal\.kind === 'user' \|\| principal\.kind === 'operator'\) return true/);
  assert.match(lib('instanceAuth.ts'), /if \(isOwnerPrincipal\(p\)\) return \{ principal: p, level: 'owner' \}/);
});

test('D82 (C8): the desktop page lists only the signed-in user\'s windows; the handoff checks a member\'s instance and grant', () => {
  const page = readFileSync(new URL('../src/desktop-pages/index.astro', import.meta.url), 'utf8');
  assert.match(page, /\(inst as \{ owner\?: string \}\)\.owner \?\? localOwnerId\(\)\) !== userId\) continue;/);
  const handoff = readFileSync(new URL('../src/pages/api/app-hosts/handoff.ts', import.meta.url), 'utf8');
  assert.match(handoff, /identity\.role !== 'owner' && !\(await memberMayOpen\(/);
  assert.match(handoff, /instance\.owner !== userId\) return false/);
  assert.match(handoff, /grants\.get\(\{ kind: 'user', id: userId \}, core\.appUsePermission\(installationId\)\)/);
});

test('owner decision (5-main): a member\'s Terminal acts with the member\'s own grants, never its app\'s; no implicit other app or owner operation', async () => {
  const held = new Set<string>();
  const grants = { get: async (s: { kind: string; id: string }, p: string) => (held.has(`${s.kind}:${s.id}|${p}`) ? { permission: p } : null) } as unknown as GrantStore;
  const instances: Record<string, string | null> = { ...INSTANCES, 'io.ex.notes-1': 'default', 'io.ex.notes-2': MEMBER };
  const d = createDecide({
    // The Terminal app holds its declared app grants (the owner's); a member's Terminal must not inherit them.
    authorizer: new Authorizer({ grants, declared: (id: string) => (id === 'com.aura.terminal' ? ['apps.mount'] : []), appBinding: async () => ({ scope: 'system', installationId: 'inst-1' }) }),
    instanceOwner: (id) => instances[id] ?? null,
    installationOf: async (appId) => ({ 'com.aura.terminal': 'inst-term', 'io.ex.notes': 'inst-notes' } as Record<string, string>)[appId] ?? null,
    ownerAgent: (p) => p.appId === 'com.aura.terminal' && INSTANCES[p.instanceId] === 'default',
  });
  const memberTerm = inst('com.aura.terminal', { instanceId: 'com.aura.terminal-2', userId: MEMBER });
  const ownerTerm = inst('com.aura.terminal', { userId: 'default' });
  const mount: AccessRule = { allow: ['app-permission'], target: 'app', permissions: ['apps.mount'] };
  const proxy = route('/api/proxy/[id]/[...path]', 'GET');
  const start = route('/api/apps/[id]/start');
  const tok = 'instance-token' as AccessVia;
  // The Terminal app's own grant: the owner's Terminal holds it, a member's Terminal does not.
  assert.equal((await d(input(ownerTerm, mount, { appId: 'com.aura.terminal' }, tok))).outcome, 'allow');
  assert.equal((await d(input(memberTerm, mount, { appId: 'com.aura.terminal' }, tok))).outcome, 'deny');
  // (What a user may hold is core's Authorizer's rule: apps.mount is an app permission, so a member never holds it either.)
  held.add(`user:${MEMBER}|apps.mount`);
  assert.equal((await d(input(memberTerm, mount, { appId: 'com.aura.terminal' }, tok))).outcome, 'deny');
  // Other apps' upstreams: an app instance may call them by its token (D89 B6), a member's Terminal only as the member.
  assert.equal((await d(input(inst('io.ex.other'), proxy, { appId: 'io.ex.notes', instanceId: 'io.ex.notes-1' }, tok))).outcome, 'allow', 'unchanged for apps');
  assert.equal((await d(input(memberTerm, proxy, { appId: 'io.ex.notes', instanceId: 'io.ex.notes-1' }, tok))).outcome, 'deny', 'not the owner\'s instance');
  assert.equal((await d(input(memberTerm, proxy, { appId: 'io.ex.notes', instanceId: 'io.ex.notes-2' }, tok))).outcome, 'deny', 'not even its own without app.use');
  held.add(`user:${MEMBER}|app.use:inst-notes`);
  assert.equal((await d(input(memberTerm, proxy, { appId: 'io.ex.notes', instanceId: 'io.ex.notes-2' }, tok))).outcome, 'allow', 'its own instance with app.use');
  assert.equal((await d(input(memberTerm, proxy, { appId: 'io.ex.notes', instanceId: 'io.ex.notes-1' }, tok))).outcome, 'deny', 'never the owner\'s');
  // Owner operations: none (no owner level, whatever it holds).
  for (const [path, method] of [['/api/apps/[id]/start', 'POST'], ['/api/terminal/share', 'POST']] as const) {
    const r = ROUTE_ACCESS_MANIFEST.routes[path]?.methods?.[method];
    if (r && !r.memberPermissions && !r.allow.includes('own-instance')) assert.equal((await d(input(memberTerm, r, { appId: 'io.ex.other' }, tok))).outcome, 'deny', path);
  }
  assert.equal((await d(input(memberTerm, start, { appId: 'io.ex.other' }, tok))).outcome, 'deny', 'starting an app it holds no app.use for');
  // Its own Terminal: the session router still works (own-session), the owner's stays closed.
  assert.equal((await d(input(memberTerm, proxy, { appId: 'com.aura.terminal', instanceId: 'com.aura.terminal-2' }, tok))).outcome, 'allow');
  assert.equal((await d(input(memberTerm, proxy, { appId: 'com.aura.terminal', instanceId: 'com.aura.terminal-1' }, tok))).outcome, 'deny');
});

test('5-main integration (I.2 + D69): a member\'s app.use reaches its own Terminal past the owner-agent block, nothing else does', async () => {
  const held = new Set<string>(['user:' + MEMBER + '|app.use:inst-term', 'user:' + MEMBER + '|app.use:inst-shelld']);
  const grants = { get: async (s: { kind: string; id: string }, p: string) => (held.has(`${s.kind}:${s.id}|${p}`) ? { permission: p } : null) } as unknown as GrantStore;
  const d = createDecide({
    authorizer: new Authorizer({ grants, declared: () => [], appBinding: async () => ({ scope: 'system', installationId: 'inst-1' }) }),
    instanceOwner: (id) => INSTANCES[id] ?? null,
    installationOf: async (appId) => ({ 'com.aura.terminal': 'inst-term', 'com.aura.aurashelld': 'inst-shelld' } as Record<string, string>)[appId] ?? null,
  });
  const proxy = route('/api/proxy/[id]/[...path]', 'GET');
  assert.deepEqual(await d(input(member, proxy, { appId: 'com.aura.terminal', instanceId: 'com.aura.terminal-2' })), { outcome: 'allow', reason: 'app-permission' });
  assert.equal((await d(input(member, proxy, { appId: 'com.aura.terminal', instanceId: 'com.aura.terminal-1' }))).outcome, 'deny', 'the owner\'s Terminal');
  // aurashelld is an owner agent but no session host: the owner level only, whatever a member holds.
  assert.equal((await d(input(member, proxy, { appId: 'com.aura.aurashelld' }))).outcome, 'deny');
  // Another app's instance token with an app-permission grant still never reaches a Terminal upstream (D89 B6).
  assert.equal((await d(input(inst('io.ex.app', { userId: MEMBER }), proxy, { appId: 'com.aura.terminal', instanceId: 'com.aura.terminal-2' }, 'instance-token'))).outcome, 'deny');
});

test("5-main (VM finding): a member may be granted its own Terminal; the owner UIs stay the owner's", async () => {
  const { ownerUiApp } = await import("../server/gateway-identity.mjs");
  const { SESSION_HOST_APPS } = await import("../server/session-hosts.mjs");
  // The grant route refuses an owner UI unless it is the session host (lib/usersAdmin.ts changeUserGrant).
  const refused = (appId: string) => !!ownerUiApp(appId) && !SESSION_HOST_APPS.has(appId);
  assert.equal(refused("com.aura.terminal"), false, "a member's own Terminal (D82)");
  assert.equal(refused("com.aura.settings"), true);
  assert.equal(refused("com.aura.nexus"), true);
  const src = readFileSync(new URL("../src/lib/usersAdmin.ts", import.meta.url), "utf8");
  assert.match(src, /ownerUiApp\(appId\) && !SESSION_HOST_APPS\.has\(appId\)/);
});
