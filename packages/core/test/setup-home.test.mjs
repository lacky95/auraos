// D108 P9 (D107-a owner subset): the user's Private Home as an app's home
// environment. The `home.private[.sidecar:<n>]` grants (app subject, the
// home user's scope, pinned to the installation; never OS-wide, never the
// app's own), `grantHomePrivate` (only the home's own user decides),
// `homePrivateAuthorized` (grant ∧ D64 ∧ storage.privateHome instance ∧ not
// PRoot ∧ not root ∧ no shared listener), the spawn port, the teardown, the
// identity (A) of a private start and the owner-environment sidecar.
// (SidecarManager rows: setup-home-sidecars.test.mjs, without a KV server.)
// L5 rows: no other user's home; PRoot refused; root installation refused;
// a sidecar without its grant gets no home; no shared listener with a
// private home; revoke kills access; no self-grant by the app; policy off
// blocks.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { kvServer, createRedis } from '@aura/kv-store';
import * as core from '../dist/index.js';
import { featuresOf } from '../dist/runtimes/ari.js';
import { PROOT_CAPABILITIES } from '../dist/app-manager/ProotRunner.js';
import { containerIdentityArgs, renderIdentityFiles, sidecarIdentityArgs } from '../dist/runtimes/spawn/identityArgs.js';
import { appIdentityProvider, sessionHostIdentityProvider } from '../dist/identity/appIdentityProvider.js';
import { kernelHomeResolver } from '../dist/homes/HomeResolver.js';

const {
  GrantStore, GrantError, isPrivilegedPermission, HOME_PRIVATE_PERMISSION_RE, userScope,
  grantHomePrivate, homePrivateAuthorized, loadHomePrivateFacts, privateHomeSpawnPort, privateHomeTeardown,
  HomePrivateError, HOME_PRIVATE_AUDIT, isUserEnvironment, resolveSidecarSpec, specHash,
} = core;

const APP = 'io.test.webui';
const INSTALL = '6f1c1c7e-4d7a-4c55-9b2e-0000000000a1';
const OTHER_INSTALL = '6f1c1c7e-4d7a-4c55-9b2e-0000000000a2';
const OWNER = 'default';
const MEMBER = 'bob';
const BINDING = { scope: 'user', installationId: INSTALL };

const CONTAINER_CAPS = {
  isolation: 'namespace', network: 'bridge', appHome: true, privateHomeSession: true, sessionExec: true, identity: 'enforced',
  readOnlyBinds: true, hostFilesystem: true, mounts: true, idmappedMounts: false, portExpose: true, sidecars: true, warmPool: true,
  survivesShellRestart: true, usage: true, gpu: false, userNamespaces: false,
};

const DATA = mkdtempSync(join(tmpdir(), 'aura-p9-'));
let redis;
let grants;
before(async () => {
  redis = createRedis(await kvServer.start({ dataDir: join(DATA, 'kv') }));
});
beforeEach(async () => {
  await redis.flushall();
  grants = new GrantStore(() => redis);
});
after(async () => {
  redis?.disconnect();
  await kvServer.stop();
});

const ownerBy = { kind: 'user', userId: OWNER };
const services = (over = {}) => [
  { name: 'webui', network: 'instance' },
  { name: 'terminal', home: 'owner-environment', ...over },
];

/** Facts that authorize everything; each test breaks one condition. */
async function facts(over = {}, input = {}) {
  const f = await loadHomePrivateFacts({
    grants,
    binding: async () => BINDING,
    policy: async () => 'grant',
    runtime: async () => ({ id: 'container', capabilities: CONTAINER_CAPS }),
    installation: async () => ({ runAs: 'app' }),
  }, {
    appId: APP, installationId: INSTALL, userId: OWNER,
    manifest: { homeEnvironments: { supported: ['app', 'private'] }, services: services() },
    sidecars: ['terminal'], ...input,
  });
  return { ...f, ...over };
}

async function grantAll(sidecars = ['terminal']) {
  return grantHomePrivate({ grants, binding: async () => BINDING, audit: async () => undefined, ownerId: OWNER }, {
    appId: APP, installationId: INSTALL, userId: OWNER, sidecars, decidedBy: ownerBy, approvalId: 'ap-1',
  });
}

// ── GrantStore: the permission names ────────────────────────────────────────

test('GrantStore: home.private[.sidecar:<n>] is an app\'s grant for one user\'s home, never OS-wide or a user\'s', async () => {
  assert.ok(HOME_PRIVATE_PERMISSION_RE.test('home.private'));
  assert.ok(HOME_PRIVATE_PERMISSION_RE.test('home.private.sidecar:terminal'));
  assert.ok(!HOME_PRIVATE_PERMISSION_RE.test('home.private.sidecar:Bad'));
  assert.ok(!HOME_PRIVATE_PERMISSION_RE.test('home.private.x'));
  assert.ok(isPrivilegedPermission('home.private') && isPrivilegedPermission('home.private.sidecar:terminal'));
  const app = { kind: 'app', id: APP };
  // The admin grants route passes no scope (OS-wide): refused, so it can't give a Private Home.
  await assert.rejects(grants.grant(app, 'home.private', { by: ownerBy, installationId: INSTALL }), (e) => e instanceof GrantError && e.status === 400);
  await assert.rejects(grants.grant({ kind: 'user', id: OWNER }, 'home.private', { by: ownerBy, scope: userScope(OWNER) }), GrantError);
  await assert.rejects(grants.grant({ kind: 'apiKey', id: 'k1' }, 'home.private', { by: ownerBy, scope: userScope(OWNER) }), GrantError);
  await assert.rejects(grants.revoke(app, 'home.private'), GrantError, 'an OS-wide revoke names no home');
  const r = await grants.grant(app, 'home.private', { by: ownerBy, scope: userScope(OWNER), installationId: INSTALL });
  assert.deepEqual(r.record.scope, { kind: 'user', id: OWNER });
  assert.equal(r.record.installationId, INSTALL);
});

// ── grantHomePrivate ────────────────────────────────────────────────────────

test('grantHomePrivate: the home\'s own user grants home and sidecar, pinned to the installation, audited', async () => {
  const audit = [];
  const r = await grantHomePrivate({ grants, binding: async () => BINDING, audit: async (e) => { audit.push(e); }, ownerId: OWNER }, {
    appId: APP, installationId: INSTALL, userId: OWNER, sidecars: ['terminal', 'terminal'], decidedBy: ownerBy, approvalId: 'ap-1',
  });
  assert.deepEqual(r.granted, ['home.private', 'home.private.sidecar:terminal']);
  const rec = await grants.get({ kind: 'app', id: APP }, 'home.private.sidecar:terminal', userScope(OWNER));
  assert.equal(rec.installationId, INSTALL);
  assert.equal(rec.appScope, 'user');
  assert.deepEqual(rec.grantedBy, ownerBy);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, HOME_PRIVATE_AUDIT.granted);
  assert.deepEqual(audit[0].detail, { installation: INSTALL, user: OWNER, sidecars: ['terminal'], approval: 'ap-1' });
});

test('grantHomePrivate L5: no self-grant, no other user\'s home, no stale installation, nothing written on a refusal', async () => {
  const deps = { grants, binding: async () => BINDING, audit: async () => undefined, ownerId: OWNER };
  const base = { appId: APP, installationId: INSTALL, userId: OWNER, sidecars: [], approvalId: 'ap-1' };
  const refused = async (input, re) => {
    await assert.rejects(grantHomePrivate(deps, { ...base, ...input }), (e) => e instanceof HomePrivateError && e.code === 'requirement-unauthorized'
      && e.body.category === 'missing-permission' && re.test(e.message));
  };
  // The app itself (or anything not a user/operator decision) never grants.
  await refused({ decidedBy: { kind: 'app', id: APP } }, /own user/);
  await refused({ decidedBy: { kind: 'system' } }, /own user/);
  // Another user (even the owner) never decides about a member's home; the member never about the owner's.
  await refused({ decidedBy: ownerBy, userId: MEMBER }, /own user/);
  await refused({ decidedBy: { kind: 'user', userId: MEMBER } }, /own user/);
  // The host operator acts for the owner only.
  await refused({ decidedBy: { kind: 'operator' }, userId: MEMBER }, /own user/);
  await refused({ decidedBy: ownerBy, approvalId: '' }, /approval/);
  await refused({ decidedBy: ownerBy, installationId: OTHER_INSTALL }, /another installation/);
  await refused({ decidedBy: ownerBy, sidecars: ['Bad Name'] }, /invalid sidecar/);
  assert.deepEqual(await grants.listFor({ kind: 'app', id: APP }), []);
  const ok = await grantHomePrivate(deps, { ...base, decidedBy: { kind: 'operator' } });
  assert.deepEqual(ok.granted, ['home.private']);
});

// ── homePrivateAuthorized ───────────────────────────────────────────────────

test('homePrivateAuthorized: authorized with every condition; the sidecar needs its own grant', async () => {
  await grantAll([]);
  const f = await facts();
  assert.deepEqual(homePrivateAuthorized(f, { kind: 'home-private', userId: OWNER }), { ok: true });
  const sc = homePrivateAuthorized(f, { kind: 'home-private-sidecar', sidecar: 'terminal', userId: OWNER });
  assert.equal(sc.ok, false);
  assert.equal(sc.error.error, 'requirement-unauthorized');
  assert.deepEqual(sc.error.missing, ['home.private.sidecar:terminal']);
  await grantAll(['terminal']);
  assert.deepEqual(homePrivateAuthorized(await facts(), { kind: 'home-private-sidecar', sidecar: 'terminal', userId: OWNER }), { ok: true });
});

test('homePrivateAuthorized L5: each condition fails closed with its D105 body', async () => {
  await grantAll();
  const no = (f, req = { kind: 'home-private', userId: OWNER }) => {
    const d = homePrivateAuthorized(f, req);
    assert.equal(d.ok, false);
    return d.error;
  };
  // No other user's home (and the body names nobody).
  const other = no(await facts(), { kind: 'home-private', userId: MEMBER });
  assert.equal(other.error, 'requirement-unauthorized');
  assert.ok(!other.message.includes(MEMBER) && !other.message.includes(OWNER));
  // Policy off blocks.
  const pol = no(await facts({ policy: 'off' }));
  assert.equal(pol.error, 'policy-refused');
  assert.equal(pol.category, 'not-grantable');
  assert.equal(pol.policy, 'app-private-home');
  // PRoot refused (its caps have no instance Private Home; the id alone refuses too).
  const proot = await loadHomePrivateFacts({
    grants, binding: async () => BINDING, policy: async () => 'grant',
    runtime: async () => ({ id: 'proot', capabilities: PROOT_CAPABILITIES.master }), installation: async () => ({ runAs: 'app' }),
  }, { appId: APP, installationId: INSTALL, userId: OWNER, manifest: { homeEnvironments: { supported: ['app', 'private'] }, services: services() } });
  assert.equal(proot.runtime.privateHomeInstance, false);
  assert.equal(no(proot).error, 'requirement-unsupported');
  assert.deepEqual(no(proot).missing, ['storage.privateHome']);
  assert.equal(no(await facts({ runtime: { id: 'proot', privateHomeInstance: true } })).error, 'requirement-unsupported');
  assert.equal(no(await facts({ runtime: null })).error, 'requirement-unsupported');
  // Root installation refused (legacy root, or a root execution request).
  assert.match(no(await facts({ installation: { runAs: 'root', rootExecution: false } })).message, /root installation/);
  assert.match(no(await facts({ installation: { runAs: 'app', rootExecution: true } })).message, /root installation/);
  assert.match(no(await facts({}, { manifest: { homeEnvironments: { supported: ['app', 'private'] }, services: services(), execution: { runAs: 'root' } } })).message, /root/);
  // No shared listener with a private home (the net-iso2 default: a sidecar without home is shared).
  const shared = no(await facts({}, { manifest: { homeEnvironments: { supported: ['app', 'private'] }, services: [{ name: 'webui' }, { name: 'terminal', home: 'owner-environment' }] } }));
  assert.equal(shared.error, 'requirement-unsupported');
  assert.deepEqual(shared.missing, ['services[webui].network']);
  // The manifest must declare private for the grant to count.
  assert.equal(no(await facts({ declaresPrivate: false })).manifestField, 'homeEnvironments.supported');
  // A grant of another installation (or scope) does not count.
  assert.equal(no(await facts({ binding: { scope: 'user', installationId: OTHER_INSTALL } })).error, 'requirement-unauthorized');
  assert.equal(no(await facts({ binding: { scope: 'global', installationId: INSTALL } })).error, 'requirement-unauthorized');
  // A sidecar that is not owner-environment, or is privileged / has its own user, never gets the home.
  const side = (svc) => facts({}, { manifest: { homeEnvironments: { supported: ['app', 'private'] }, services: [{ name: 'webui', network: 'instance' }, svc] } });
  const sreq = { kind: 'home-private-sidecar', sidecar: 'terminal', userId: OWNER };
  assert.equal(no(await side({ name: 'terminal', home: 'app' }), sreq).error, 'requirement-unsupported');
  assert.match(no(await side({ name: 'terminal', home: 'owner-environment', privileged: true }), sreq).message, /privileged/);
  assert.match(no(await side({ name: 'terminal', home: 'owner-environment', user: '0:0' }), sreq).message, /user 0:0/);
  assert.match(no(await side({ name: 'terminal', home: 'owner-environment', capabilities: ['SYS_ADMIN'] }), sreq).message, /capabilities/);
});

test('homePrivateAuthorized L5: revoking the grant ends the authorization (no App Home answer)', async () => {
  await grantAll();
  assert.equal(homePrivateAuthorized(await facts(), { kind: 'home-private', userId: OWNER }).ok, true);
  await grants.revoke({ kind: 'app', id: APP }, 'home.private', userScope(OWNER));
  const d = homePrivateAuthorized(await facts(), { kind: 'home-private', userId: OWNER });
  assert.equal(d.ok, false);
  assert.equal(d.error.error, 'requirement-unauthorized');
  // The sidecar needs the home grant too.
  assert.equal(homePrivateAuthorized(await facts(), { kind: 'home-private-sidecar', sidecar: 'terminal', userId: OWNER }).ok, false);
});

// ── the spawn port ──────────────────────────────────────────────────────────

test('privateHomeSpawnPort: app for every non-private config; private re-authorized at each start, refusal throws', async () => {
  let eff = null;
  const port = privateHomeSpawnPort({ effective: async () => eff, facts: async (_a, _i, _u, sc) => facts({}, { sidecars: sc }) });
  assert.equal(await port.homeEnvironmentFor(APP, OWNER), 'app', 'an app without setup');
  eff = { installationId: INSTALL, homeEnvironment: 'app', ownerEnvironmentSidecars: [] };
  assert.equal(await port.homeEnvironmentFor(APP, OWNER), 'app');
  eff = { installationId: INSTALL, homeEnvironment: 'private', ownerEnvironmentSidecars: ['terminal'] };
  await assert.rejects(port.homeEnvironmentFor(APP, OWNER), (e) => e instanceof HomePrivateError && e.code === 'requirement-unauthorized');
  await grantAll();
  assert.equal(await port.homeEnvironmentFor(APP, OWNER), 'private');
  assert.equal(await port.sidecarAuthorized(APP, OWNER, 'terminal'), true);
  assert.equal(await port.sidecarAuthorized(APP, OWNER, 'webui'), false, 'not an owner-environment sidecar of the config');
  await assert.rejects(port.homeEnvironmentFor(APP, undefined), HomePrivateError, 'never warmed for nobody (the pool)');
  await assert.rejects(port.homeEnvironmentFor(APP, MEMBER), HomePrivateError, 'never another user\'s home');
  await grants.revoke({ kind: 'app', id: APP }, 'home.private.sidecar:terminal', userScope(OWNER));
  assert.equal(await port.sidecarAuthorized(APP, OWNER, 'terminal'), false);
  await grants.revoke({ kind: 'app', id: APP }, 'home.private', userScope(OWNER));
  await assert.rejects(port.homeEnvironmentFor(APP, OWNER), HomePrivateError, 'revoked: refused, never the App Home');
});

// ── teardown ────────────────────────────────────────────────────────────────

test('privateHomeTeardown L5: revoke stops the user\'s private instances and ends their sessions; audited; nothing else', async () => {
  const stopped = [];
  const ended = [];
  const audit = [];
  const r = await privateHomeTeardown({
    instances: () => [
      { instanceId: `${APP}-1`, owner: OWNER, runAs: 'user' },
      { instanceId: `${APP}-2`, owner: OWNER, runAs: 'app' },
      { instanceId: `${APP}-3`, owner: MEMBER, runAs: 'user' },
    ],
    stop: async (id) => { stopped.push(id); },
    sessions: () => [{ sessionId: 's1', instanceId: `${APP}-1` }, { sessionId: 's2', instanceId: `${APP}-2` }],
    endSession: async (id) => { ended.push(id); return true; },
    audit: async (e) => { audit.push(e); },
  }, { appId: APP, installationId: INSTALL, userId: OWNER, cause: { kind: 'grant', permission: 'home.private' }, actor: ownerBy });
  assert.deepEqual(r, { stopped: [`${APP}-1`], failed: [], sessionsEnded: 1 });
  assert.deepEqual(stopped, [`${APP}-1`]);
  assert.deepEqual(ended, ['s1']);
  assert.equal(audit[0].action, HOME_PRIVATE_AUDIT.revoked);
  assert.deepEqual(audit[0].by, ownerBy);
  assert.equal(audit[0].outcome, 'ok');
  const failing = await privateHomeTeardown({
    instances: () => [{ instanceId: `${APP}-1`, owner: OWNER, runAs: 'user' }], stop: async () => { throw new Error('busy'); },
    sessions: () => [], endSession: async () => true, audit: async (e) => { audit.push(e); },
  }, { appId: APP, installationId: INSTALL, userId: OWNER, cause: { kind: 'policy' }, actor: { kind: 'system' } });
  assert.deepEqual(failing.failed, [`${APP}-1`]);
  assert.equal(audit[1].outcome, 'failed');
});

// ── identity (A) ────────────────────────────────────────────────────────────

const userEnvDeps = {
  isUserEnvironment,
  ownerId: OWNER,
  account: async (u) => ({ username: u === OWNER ? 'lukas' : u, disabled: false }),
  identity: async (u) => (u === OWNER ? { uid: 1000, gid: 1000, state: 'active' } : { uid: 100001, gid: 100001, state: 'active' }),
};
const appBase = { identityFor: async () => ({ uid: 200001, gid: 200001, range: 'app' }) };

test('identity (A): a private start runs as its user (userApp), an app start keeps its app uid, a root installation is refused', async () => {
  const p = sessionHostIdentityProvider(appBase, userEnvDeps);
  assert.deepEqual(await p.identityFor({ appId: APP, installationId: INSTALL, runAs: 'app', userId: OWNER }), { uid: 200001, gid: 200001, range: 'app' });
  assert.deepEqual(await p.identityFor({ appId: APP, installationId: INSTALL, runAs: 'app', userId: OWNER, homeEnvironment: 'private' }),
    { uid: 1000, gid: 1000, range: 'owner', userId: OWNER, account: 'lukas', userApp: true });
  await assert.rejects(p.identityFor({ appId: APP, installationId: INSTALL, runAs: 'root', userId: OWNER, homeEnvironment: 'private' }), /root installation/);
  await assert.rejects(p.identityFor({ appId: APP, installationId: INSTALL, runAs: 'app', homeEnvironment: 'private' }), /for nobody/);
  // The Terminal is unchanged: a session host, no userApp.
  const term = await p.identityFor({ appId: 'com.aura.terminal', installationId: INSTALL, runAs: 'root', userId: OWNER });
  assert.equal(term.userApp, undefined);
  assert.equal(isUserEnvironment({ appId: APP }), false);
  assert.equal(isUserEnvironment({ appId: APP, homeEnvironment: 'private' }), true);
  assert.equal(typeof appIdentityProvider, 'function');
});

test('identity (A): a userApp container runs as the user with no capability, never the Terminal launcher\'s root', () => {
  const opts = { appDataVolume: 'vol', instanceId: `${APP}-1` };
  const user = { uid: 1000, gid: 1000, range: 'owner', userId: OWNER, account: 'lukas', userApp: true };
  const argv = containerIdentityArgs(user, opts);
  assert.deepEqual(argv.slice(0, 6), ['--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges']);
  assert.ok(!argv.includes('SETUID') && !argv.includes('0:0'));
  assert.ok(argv.includes('AURA_RUN_AS=user'));
  assert.ok(!renderIdentityFiles(user, INSTALL).passwd.includes('aura-terminal'), 'no Terminal service account');
  // The Terminal session host is byte-identical to before.
  const host = containerIdentityArgs({ uid: 1000, gid: 1000, range: 'owner', userId: OWNER, account: 'lukas' }, opts);
  assert.deepEqual(host.slice(0, 8), ['--user', '0:0', '--cap-drop', 'ALL', '--cap-add', 'SETUID', '--cap-add', 'SETGID']);
  // An owner-environment sidecar of it runs as the user too (B12 base).
  assert.deepEqual(sidecarIdentityArgs({ image: 'ghcr.io/x/term', inheritHome: true }, user, { ...opts, baseImage: 'aura-base' }),
    ['--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges']);
});

test('home (A): a private start resolves its user\'s Private Home as that user; never another user\'s; PRoot refused', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'aura-p9h-'));
  const r = kernelHomeResolver({ dataDir, userIdentity: async () => ({ uid: 1000, gid: 1000 }), mayJumpApp: async () => false, chown: () => undefined });
  const req = {
    installationId: INSTALL, environmentScope: 'global', executionContext: 'user-environment', userId: OWNER,
    principal: { userId: OWNER, role: 'owner' }, appIdentity: { uid: 1000, gid: 1000 }, runtime: CONTAINER_CAPS,
  };
  const home = await r.resolve(req);
  assert.equal(home.kind, 'private');
  assert.equal(home.volumeSubpath, `aura/home/${OWNER}`);
  await assert.rejects(r.resolve({ ...req, userId: MEMBER }), /own user/);
  await assert.rejects(r.resolve({ ...req, appIdentity: { uid: 200001, gid: 200001 } }), /own user only/);
  await assert.rejects(r.resolve({ ...req, runtime: PROOT_CAPABILITIES.master }), (e) => e.name === 'RuntimeCapabilityError');
  // An app process with a principal (the `application` context) is still refused a Private Home.
  await assert.rejects(r.resolve({ ...req, executionContext: 'application' }), /never carries a user principal/);
});

// ── sidecars ────────────────────────────────────────────────────────────────

test('sidecar spec: home owner-environment = inheritHome + ownerEnvironment on the instance network; old specs unchanged', () => {
  const ctx = (svc) => ({
    appId: APP, instanceId: `${APP}-1`, manifest: { id: APP, services: [svc] }, can: () => false,
    appDataSubpath: 'scopes/x', appDataVolume: 'vol', legacyVolumeExists: () => false,
  });
  const owner = resolveSidecarSpec({ template: 'terminal' }, ctx({ name: 'terminal', image: 'img', home: 'owner-environment' }));
  assert.equal(owner.inheritHome, true);
  assert.equal(owner.ownerEnvironment, true);
  assert.equal(owner.network, 'instance');
  const app = resolveSidecarSpec({ template: 'terminal' }, ctx({ name: 'terminal', image: 'img', home: 'app' }));
  const alias = resolveSidecarSpec({ template: 'terminal' }, ctx({ name: 'terminal', image: 'img', inheritHome: true }));
  assert.equal(specHash(app), specHash(alias), 'home app is the inheritHome alias');
  assert.equal('ownerEnvironment' in alias, false);
  const none = resolveSidecarSpec({ template: 'terminal' }, ctx({ name: 'terminal', image: 'img' }));
  assert.equal('inheritHome' in none || 'network' in none, false);
});

test('storage.privateHome instance constraint: container yes, PRoot no (the facts loader reads it)', () => {
  const inst = (caps) => featuresOf(caps).find((f) => f.id === 'storage.privateHome').constraints.instance;
  assert.equal(inst(CONTAINER_CAPS), true);
  assert.equal(inst(PROOT_CAPABILITIES.master), false);
});
