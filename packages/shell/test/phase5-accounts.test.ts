// Phase 5 I.2 part 1 (accounts plumbing) in the shell: the role from the
// record (C2), per-user session checks (C3), D29 bound to the owner (C4),
// the `user` grant subject on `app-permission` rules (C7), per-user desktop
// state (C8), user-initiated starts (C9), and the D85 A1 foreign-system guard.
//
//   cd packages/shell && npx tsx --test test/phase5-accounts.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Authorizer, GrantStore } from '@aura/core';
import type { AccessPrincipal, InstancePrincipal, UserPrincipal } from '@aura/core';
import { localSystemId } from '@aura/core/system-identity';
import { createDecide } from '../src/lib/access/decide.ts';
import { isTrustedOwnerAgent, resolvePrincipal } from '../src/lib/access/identify.ts';
import type { AccessLabel, AccessRule, DecideInput } from '../src/lib/access/types.ts';
import { ownerAction } from '../src/lib/approvals/admin.ts';
import { userSessionOf } from '../src/lib/authSurface.ts';
import { reopenActivities, sessionInstances, type DesktopSnapshot, type RestoreReport } from '../src/lib/desktopSession.ts';
import { actingUserId } from '../src/lib/userContext.ts';
import { createSessionLive } from '../server/app-host-auth.mjs';
import { ownerUiActs } from '../server/gateway-identity.mjs';

const SYS = localSystemId();
const MEMBER_ID = 'uaaaaaaaaaaaaaaa';
const owner: UserPrincipal = { kind: 'user', userId: 'default', role: 'owner', sessionId: 's1', verification: 'verified', systemId: SYS };
const member: UserPrincipal = { kind: 'user', userId: MEMBER_ID, role: 'member', sessionId: 's2', verification: 'verified', systemId: SYS };
const inst = (appId: string, extra: Partial<InstancePrincipal> = {}): InstancePrincipal =>
  ({ kind: 'instance', appId, instanceId: `${appId}-1`, verification: 'verified', systemId: SYS, ...extra });

/** Grants in memory, the GrantStore surface the Authorizer reads. */
function memoryGrants(): GrantStore {
  const held = new Set<string>();
  return {
    get: async (s: { kind: string; id: string }, p: string) => (held.has(`${s.kind}:${s.id}|${p}`) ? { permission: p } : null),
    add: (kind: string, id: string, p: string) => held.add(`${kind}:${id}|${p}`),
  } as unknown as GrantStore;
}

const OWNER_RULE: AccessRule = { allow: ['owner'], target: 'system' };
const INSTANCE_RULE: AccessRule = { allow: ['own-instance', 'owner'], target: 'instance' };
const USE_RULE: AccessRule = { allow: ['app-permission', 'owner'], target: 'app', permissions: ['app.use:inst-1'] };

const input = (principal: AccessPrincipal, rule: AccessRule, via: DecideInput['auth']['via'] = 'login-session'): DecideInput => ({
  principal,
  action: { surface: 'api', subject: '/api/x' as AccessLabel, method: 'GET', variant: null, rule },
  resource: { target: rule.target, appId: 'com.example.app', instanceId: 'com.example.app-1' },
  transport: 'http', auth: { fresh: false, via }, accessProfile: 'open', systemMode: 'normal', deployment: 'private',
});

test('C2: a member satisfies no owner level; the owner does', async () => {
  const d = createDecide({ authorizer: new Authorizer({ grants: memoryGrants(), declared: () => [], appBinding: async () => ({ scope: 'user', installationId: 'inst-1' }) }) });
  assert.equal((await d(input(owner, OWNER_RULE))).outcome, 'allow');
  assert.deepEqual(await d(input(member, OWNER_RULE)), { outcome: 'deny', reason: 'wrong-principal' });
  assert.equal((await d(input(member, INSTANCE_RULE))).outcome, 'deny');
});

test('C7: a member holds an app-permission rule only with its own user grant', async () => {
  const grants = memoryGrants();
  const d = createDecide({ authorizer: new Authorizer({ grants, declared: () => [], appBinding: async () => ({ scope: 'user', installationId: 'inst-1' }) }) });
  assert.deepEqual(await d(input(member, USE_RULE)), { outcome: 'deny', reason: 'missing-permission' });
  (grants as unknown as { add(k: string, i: string, p: string): void }).add('user', MEMBER_ID, 'app.use:inst-1');
  assert.deepEqual(await d(input(member, USE_RULE)), { outcome: 'allow', reason: 'app-permission' });
  // An instance acting for the member holds the member's grant (the member's own instance, C7).
  assert.deepEqual(await d(input(inst('com.aura.terminal', { userId: MEMBER_ID }), USE_RULE, 'instance-token')), { outcome: 'allow', reason: 'app-permission' });
  // A rule without permissions never opens to a member.
  assert.equal((await d(input(member, { allow: ['app-permission', 'owner'], target: 'app' }))).outcome, 'deny');
});

test('D85 A1: a foreign-system principal is refused before any role or grant rule; absent systemId is local', async () => {
  const grants = memoryGrants();
  (grants as unknown as { add(k: string, i: string, p: string): void }).add('user', MEMBER_ID, 'app.use:inst-1');
  const d = createDecide({
    authorizer: new Authorizer({ grants, declared: () => [], appBinding: async () => ({ scope: 'user', installationId: 'inst-1' }) }),
    ownerAgent: () => true,
  });
  const remoteOwner = { ...owner, systemId: 'another-aura' };
  for (const rule of [OWNER_RULE, INSTANCE_RULE, USE_RULE]) {
    assert.deepEqual(await d(input(remoteOwner, rule)), { outcome: 'deny', reason: 'foreign-system' }, rule.allow.join());
  }
  assert.deepEqual(await d(input(inst('com.aura.terminal', { systemId: 'another-aura' }), OWNER_RULE, 'instance-token')), { outcome: 'deny', reason: 'foreign-system' });
  assert.deepEqual(await d(input({ ...member, systemId: 'another-aura' }, USE_RULE)), { outcome: 'deny', reason: 'foreign-system' });
  const { systemId: _s, ...localOwner } = owner;
  assert.equal((await d(input(localOwner as AccessPrincipal, OWNER_RULE))).outcome, 'allow', 'absent systemId means local');
});

test('C4: only the owner\'s System Terminal is a trusted owner agent; a member\'s or an unclaimed one is not', () => {
  const instances: Record<string, { appId: string; instanceId: string; owner?: string; inPool?: boolean }> = {
    'com.aura.terminal-1': { appId: 'com.aura.terminal', instanceId: 'com.aura.terminal-1', owner: 'default' },
    'com.aura.terminal-2': { appId: 'com.aura.terminal', instanceId: 'com.aura.terminal-2', owner: MEMBER_ID },
    'com.aura.terminal-3': { appId: 'com.aura.terminal', instanceId: 'com.aura.terminal-3', inPool: true },
    'com.aura.terminal-4': { appId: 'com.aura.terminal', instanceId: 'com.aura.terminal-4' },
  };
  const mgr = { isTrustedSystemCopy: () => true, getInstance: (id: string) => instances[id] };
  const t = (instanceId: string, extra: Partial<InstancePrincipal> = {}) =>
    isTrustedOwnerAgent({ ...inst('com.aura.terminal'), instanceId, ...extra }, mgr as never);
  assert.equal(t('com.aura.terminal-1'), true);
  assert.equal(t('com.aura.terminal-1', { userId: 'default' }), true);
  assert.equal(t('com.aura.terminal-1', { userId: MEMBER_ID }), false, 'a token acting for a member');
  assert.equal(t('com.aura.terminal-2'), false, 'a member\'s Terminal');
  assert.equal(t('com.aura.terminal-3'), false, 'an unclaimed pool member');
  assert.equal(t('com.aura.terminal-4'), false, 'no server-side owner');
  assert.equal(t('missing'), false);
  assert.equal(isTrustedOwnerAgent(inst('com.aura.terminal'), { ...mgr, isTrustedSystemCopy: () => false } as never), false);
});

test('I.2 §3: a member\'s escalation is refused, not routed to the owner; foreign principals too', async () => {
  let asked = 0;
  const deps = (p: AccessPrincipal) => ({
    approvals: new Proxy({}, { get: () => { asked++; throw new Error('never asked'); } }) as never,
    authenticate: async () => p as never,
    shellOwner: async () => ({ identity: {} }),
  });
  const ctx = { request: new Request('http://shell/api/admin/audit'), cookies: {} as never };
  const req = { action: 'admin.read', payload: {}, level: 'session', title: 't' } as never;
  for (const p of [member, inst('com.aura.terminal', { userId: MEMBER_ID }), { ...owner, systemId: 'another-aura' }]) {
    const r = await ownerAction(ctx, req, deps(p as AccessPrincipal));
    assert.ok(r instanceof Response);
    assert.equal(r.status, 403);
  }
  assert.equal(asked, 0, 'no approval was created for the owner');
  const ok = await ownerAction(ctx, req, deps(owner));
  assert.ok(!(ok instanceof Response));
});

test('C3: a session is its own user\'s, with the record\'s role; disabled or another id is not live', async () => {
  const accounts: Record<string, { id: string; username: string; role: 'owner' | 'member'; createdAt: number; disabled: boolean }> = {
    default: { id: 'default', username: 'lukas', role: 'owner', createdAt: 1, disabled: false },
    [MEMBER_ID]: { id: MEMBER_ID, username: 'bob', role: 'member', createdAt: 2, disabled: false },
  };
  const sessions: Record<string, { sessionId: string; userId: string; method: 'password'; expiresAt: number }> = {
    tOwner: { sessionId: 'a'.repeat(32), userId: 'default', method: 'password', expiresAt: 1 },
    tBob: { sessionId: 'b'.repeat(32), userId: MEMBER_ID, method: 'password', expiresAt: 1 },
    tGhost: { sessionId: 'c'.repeat(32), userId: 'unobody00000000', method: 'password', expiresAt: 1 },
  };
  const svc = {
    loginSessions: { verify: async (t: string | null | undefined) => sessions[t ?? ''] ?? null },
    users: { getUser: async (id: string) => accounts[id] ?? null },
  };
  // Members act only under `enforce` (I.2 part 2, phase5-members.test.ts); here they may.
  const enforced = () => true;
  assert.equal((await userSessionOf('tOwner', svc, enforced))?.user.role, 'owner');
  assert.equal((await userSessionOf('tBob', svc, enforced))?.user.role, 'member');
  assert.equal(await userSessionOf('tGhost', svc, enforced), null);
  accounts[MEMBER_ID]!.disabled = true;
  assert.equal(await userSessionOf('tBob', svc, enforced), null, 'disabled: dead on the next request');

  const live = createSessionLive({
    sessions: { isLive: async (sid: string, userId: string) => Object.values(sessions).some((s) => s.sessionId === sid && s.userId === userId) },
    users: { getUser: async (id: string) => accounts[id] ?? null },
    members: enforced,
  });
  accounts[MEMBER_ID]!.disabled = false;
  assert.deepEqual(await live('b'.repeat(32), MEMBER_ID), { role: 'member' });
  accounts[MEMBER_ID]!.disabled = true;
  assert.equal(await live('b'.repeat(32), MEMBER_ID), false, 'the App Host cookie dies with the account');
});

test('D45: a member\'s live session never acts as the owner through a trusted UI', async () => {
  const registry = { getInstallation: async () => ({ appId: 'com.aura.settings', scope: 'system', state: 'active' }) };
  const ref = { appId: 'com.aura.settings', installationId: 'i-settings', sid: 'b'.repeat(32), userId: MEMBER_ID, path: '/api/os/theme' };
  assert.equal(await ownerUiActs(ref, { registry, sessionLive: async () => ({ role: 'member' }) }), false);
  assert.equal(await ownerUiActs({ ...ref, userId: 'default' }, { registry, sessionLive: async () => ({ role: 'owner' }) }), true);
  assert.equal(await ownerUiActs(ref, { registry, sessionLive: async () => false }), false);
});

// ── C8: per-user desktop state ──────────────────────────────────────────────

test('C8: a user\'s desktop snapshot holds only that user\'s instances, and the restore starts them as that user', async () => {
  const list = [
    { instanceId: 'a-1', appId: 'io.ex.a', state: 'resumed', sandbox: 'container', owner: 'default' },
    { instanceId: 'a-2', appId: 'io.ex.a', state: 'resumed', sandbox: 'container', owner: MEMBER_ID },
    { instanceId: 'a-3', appId: 'io.ex.a', state: 'resumed', sandbox: 'container' },
  ];
  const mgrView = {
    getAllInstances: () => list,
    getManifest: () => ({ activityMode: 'none' }),
    // Stream R: containers survive a shell restart (no respawn).
    runtimeCapabilitiesOf: () => ({ survivesShellRestart: true }),
  };
  const all = new Set(list.map((i) => i.instanceId));
  assert.deepEqual(sessionInstances(mgrView as never, all, new Set(), 'default').map((i) => i.instanceId), ['a-1', 'a-3'], 'unlabelled instances are the owner\'s');
  assert.deepEqual(sessionInstances(mgrView as never, all, new Set(), MEMBER_ID).map((i) => i.instanceId), ['a-2']);

  const started: Array<{ appId: string; opts: unknown }> = [];
  const opened: unknown[] = [];
  const mgr = {
    getInstance: () => undefined, getManifest: () => ({}), isEnabled: () => true,
    start: async (appId: string, opts: unknown) => { started.push({ appId, opts }); return `${appId}-new`; },
    openActivity: async (_id: string, _d: unknown, opts: unknown) => { opened.push(opts); return { activityId: 'x' }; },
  };
  const snap: DesktopSnapshot = {
    schema: 1, savedAt: '2026-11-26T00:00:00.000Z', reason: 'auto',
    instances: [{ instanceId: 'a-2', appId: 'io.ex.a', view: true }],
    activities: [{ activityId: 'b-1#1', parentInstanceId: 'b-1', appId: 'io.ex.b', path: '/', createdAt: '2026-11-26T00:00:00.000Z' }],
  };
  const report: RestoreReport = { restored: 0, respawned: 0, failed: [], idMap: {}, pruned: 0 };
  await reopenActivities(mgr as never, snap, report, true, MEMBER_ID);
  assert.deepEqual(started, [{ appId: 'io.ex.a', opts: { userId: MEMBER_ID } }, { appId: 'io.ex.b', opts: { userId: MEMBER_ID } }]);
  assert.equal((opened[0] as { userId?: string }).userId, MEMBER_ID);
});

test('C8: desktop state, workspaces and restarts are keyed by the user, never by localOwnerId() alone', () => {
  const src = (f: string) => readFileSync(new URL(`../src/lib/${f}`, import.meta.url), 'utf8');
  assert.doesNotMatch(src('desktopSession.ts'), /writeUserPref\(kv, localOwnerId\(\)/);
  assert.doesNotMatch(src('desktopSession.ts'), /readUserPrefValue<[^>]+>\(kv, localOwnerId\(\)/);
  assert.doesNotMatch(src('appRestart.ts'), /UserPref\(defaultKv\(\), localOwnerId\(\)/);
  assert.match(src('appRestart.ts'), /mgr\.start\(appId, \{ userId \}\)/);
});

// ── C9: user-initiated starts carry the verified user ───────────────────────

test('C9: a member-initiated start acts for the member, never for the owner by default', () => {
  assert.equal(actingUserId(member), MEMBER_ID);
  assert.equal(actingUserId(inst('io.ex.a', { userId: MEMBER_ID })), MEMBER_ID);
  const mgr = { getInstance: () => ({ owner: MEMBER_ID }) };
  assert.equal(actingUserId(inst('io.ex.a'), mgr as never), MEMBER_ID, 'the instance\'s server-side owner');
  // The user-initiated start routes pass the verified user to AppManager.
  const route = (f: string) => readFileSync(new URL(`../src/pages/api/${f}`, import.meta.url), 'utf8');
  assert.match(route('apps/[id]/start.ts'), /requestUserId\(request\)[\s\S]*mgr\.start\(appId, userId \? \{ userId \} : \{\}\)/);
  assert.match(route('intents/start.ts'), /requestUserId\(request\)[\s\S]*startIntent\(intent, userId \? \{ userId \} : \{\}\)/);
  assert.match(route('instances/[instanceId]/activities.ts'), /requestUserId\(request\)[\s\S]*\.\.\.\(userId \? \{ userId \} : \{\}\)/);
});

// ── D85 A9 ───────────────────────────────────────────────────────────────────

test('A9: an instance principal carries its spawn\'s lifetime, so its approvals bind this life only', async () => {
  let life = 'L1';
  const mgr = {
    tokens: { verify: (t: string) => (t === 'aura1.x' ? { instanceId: 'com.aura.terminal-2' } : null), lifetimeId: () => life },
    getInstance: () => ({ appId: 'com.aura.terminal', instanceId: 'com.aura.terminal-2', owner: 'default' }),
    getManifest: () => ({}), isTrustedSystemCopy: () => true,
  };
  const req = () => new Request('http://shell/api/x', { headers: { authorization: 'Bearer aura1.x' } });
  const a = await resolvePrincipal(req(), { mgr: mgr as never, apiKeys: null, login: null });
  assert.equal((a.principal as InstancePrincipal).lifetime, 'L1');
  life = 'L2'; // the id was reused by a new spawn
  const b = await resolvePrincipal(req(), { mgr: mgr as never, apiKeys: null, login: null });
  assert.equal((b.principal as InstancePrincipal).lifetime, 'L2');
});

test('B1: a screen registered by a user\'s own login is bound to it; approvals read the deciding owner\'s screen only', () => {
  const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
  assert.match(src('pages/api/os/clients/index.ts'), /p\.kind === 'user' && !p\.through\) owner = \{ userId: p\.userId, loginSessionId: p\.sessionId \}/);
  assert.match(src('lib/approvals/routes.ts'), /deps\.lockOf\(sid, shell\.owner\.userId\)/);
  assert.match(src('lib/clientSession.ts'), /effectiveLock\(sid, userId !== undefined \? \{ userId \} : \{\}\)/);
});
