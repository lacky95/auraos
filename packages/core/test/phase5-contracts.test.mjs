// Phase 5 Stage 1 contracts: runtime, home and identity types, the manifest's
// `sandbox`/`environmentScope`, the runner capabilities and the AppManager
// spawn seam. Run via: node tools/run-tests.mjs --only=core

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RUNTIME_ID_PATTERN, RuntimeUnavailableError, RuntimeCapabilityError, missingCapabilities, requireCapabilities,
} from '../dist/runtimes/types.js';
import { HomeDeniedError, LOGICAL_HOME_PATH } from '../dist/homes/types.js';
import {
  LINUX_ID_RANGES, OWNER_UID, linuxIdRangeOf, formatPrincipalRef, parsePrincipalRef, ROOT_IDENTITY_PROVIDER,
} from '../dist/identity/types.js';
import { AppManifestSchema } from '../dist/types/manifest.js';
import { RuntimeRegistry } from '../dist/runtimes/registry.js';
import { AppManager } from '../dist/app-manager/AppManager.js';
import { ProotRunner } from '../dist/app-manager/ProotRunner.js';
import { ContainerRunner } from '../dist/app-manager/ContainerRunner.js';

const base = { id: 'org.p5.app', name: 'P5', version: '1.0.0' };

test('manifest: sandbox has no schema default (an omitted value is the Runtime Settings default, stream R)', () => {
  const m = AppManifestSchema.parse(base);
  assert.equal(m.sandbox, undefined, 'the omission survives parsing (§11.2)');
  assert.equal(AppManifestSchema.parse({ ...base, sandbox: 'container' }).sandbox, 'container');
});

test('manifest: sandbox is a runtime id, checked at start, not a closed pair at parse', () => {
  assert.equal(AppManifestSchema.parse({ ...base, sandbox: 'gvisor' }).sandbox, 'gvisor');
  for (const bad of ['', 'A', 'x', '9abc', 'has space', 'a'.repeat(33)]) {
    assert.equal(AppManifestSchema.safeParse({ ...base, sandbox: bad }).success, false, bad);
  }
  assert.ok(RUNTIME_ID_PATTERN.test('container') && RUNTIME_ID_PATTERN.test('proot'));
});

test('manifest: environmentScope defaults to global; useProot still parses', () => {
  assert.equal(AppManifestSchema.parse(base).environmentScope, 'global');
  assert.equal(AppManifestSchema.parse({ ...base, environmentScope: 'user' }).environmentScope, 'user');
  assert.equal(AppManifestSchema.safeParse({ ...base, environmentScope: 'team' }).success, false);
  assert.equal(AppManifestSchema.parse({ ...base, useProot: false }).useProot, false);
});

test('runtime errors: Q17 texts and codes, no fallback', () => {
  const a = new RuntimeUnavailableError('runtime-not-installed', 'gvisor');
  assert.equal(a.message, 'runtime gvisor is not installed');
  assert.equal(a.code, 'runtime-not-installed');
  assert.equal(a.name, 'RuntimeUnavailableError');
  assert.equal(new RuntimeUnavailableError('runtime-disabled', 'proot').message, 'runtime proot is disabled');
  const c = new RuntimeCapabilityError('proot', ['privateHomeSession']);
  assert.equal(c.code, 'capability-missing');
  assert.deepEqual(c.missing, ['privateHomeSession']);
  assert.ok(new HomeDeniedError('user-required', 'x') instanceof Error);
});

test('capabilities: booleans, identity order and isolation order fail closed', () => {
  const proot = new ProotRunner({ baseRootfs: '/nonexistent', toolchainDir: '/nonexistent', appsDir: '/nonexistent', dataDir: '/tmp', osApiBase: 'http://127.0.0.1:3000' }).capabilities();
  assert.deepEqual(missingCapabilities(proot, { privateHomeSession: true, sessionExec: true }), ['privateHomeSession', 'sessionExec']);
  assert.deepEqual(missingCapabilities(proot, { readOnlyBinds: true }), ['readOnlyBinds'], 'ARI-4: closed source fails closed on PRoot');
  assert.deepEqual(missingCapabilities(proot, { identity: 'enforced' }), ['identity']);
  assert.deepEqual(missingCapabilities(proot, { isolation: 'namespace' }), ['isolation']);
  assert.deepEqual(missingCapabilities(proot, { isolation: 'ptrace', warmPool: true }), []);
  assert.deepEqual(missingCapabilities({ ...proot, isolation: 'vm' }, { isolation: 'namespace' }), []);
  assert.deepEqual(missingCapabilities({ ...proot, isolation: 'remote' }, { isolation: 'ptrace' }), ['isolation']);
  assert.deepEqual(missingCapabilities({ ...proot, identity: 'enforced' }, { identity: 'emulated' }), []);
  assert.throws(() => requireCapabilities('proot', proot, { mounts: true }), (e) => e instanceof RuntimeCapabilityError && e.runtime === 'proot');
});

test('runner capabilities declare today honestly', () => {
  const proot = new ProotRunner({ baseRootfs: '/nonexistent', toolchainDir: '/nonexistent', appsDir: '/nonexistent', dataDir: '/tmp', osApiBase: 'x' }).capabilities();
  assert.deepEqual(proot, {
    isolation: 'ptrace', privateHomeSession: false, sessionExec: false, identity: 'none', readOnlyBinds: false,
    mounts: false, portExpose: false, sidecars: false, warmPool: true, survivesShellRestart: false,
  });
  // capabilities() reads no instance state: call it without constructing (no docker).
  const container = ContainerRunner.prototype.capabilities.call({});
  assert.deepEqual(container, {
    // Stream A (P5-3): --user, cap-drop ALL, no-new-privileges for runAs: app.
    isolation: 'namespace', privateHomeSession: false, sessionExec: false, identity: 'enforced', readOnlyBinds: true,
    mounts: true, portExpose: true, sidecars: true, warmPool: true, survivesShellRestart: true,
  });
});

test('identity: D84 ranges, owner fixed, ranges disjoint', () => {
  assert.equal(OWNER_UID, 1000);
  assert.equal(linuxIdRangeOf(1000), 'owner');
  assert.equal(linuxIdRangeOf(100_000), 'user');
  assert.equal(linuxIdRangeOf(199_999), 'user');
  assert.equal(linuxIdRangeOf(200_000), 'app');
  assert.equal(linuxIdRangeOf(350_000), 'ari');
  assert.equal(linuxIdRangeOf(499_999), 'principal');
  assert.equal(linuxIdRangeOf(0), null);
  assert.equal(linuxIdRangeOf(500_000), null);
  const ranges = Object.values(LINUX_ID_RANGES).sort((a, b) => a.first - b.first);
  for (let i = 1; i < ranges.length; i++) assert.ok(ranges[i].first > ranges[i - 1].last);
});

test('principal refs: kind:id, qualified kind:id@systemId, open kind, no @ in ids', () => {
  assert.equal(formatPrincipalRef({ kind: 'user', id: 'default' }), 'user:default');
  assert.equal(formatPrincipalRef({ kind: 'app', id: 'inst-1', systemId: 'sys1' }), 'app:inst-1@sys1');
  assert.equal(formatPrincipalRef({ kind: 'agent', id: 'a1' }), 'agent:a1', 'a later kind needs no schema change (D84)');
  assert.deepEqual(parsePrincipalRef('user:u1@sys9'), { kind: 'user', id: 'u1', systemId: 'sys9' });
  assert.deepEqual(parsePrincipalRef('app:x:y'), { kind: 'app', id: 'x:y' });
  for (const bad of ['user', ':x', 'user:', 'User:x', 'user:a@', 'user:a@b@c']) assert.equal(parsePrincipalRef(bad), null, bad);
  assert.throws(() => formatPrincipalRef({ kind: 'user', id: 'a@b' }));
});

test('root identity provider: root for every request without runAs: app', async () => {
  assert.deepEqual(await ROOT_IDENTITY_PROVIDER.identityFor({ appId: 'a', installationId: null }), { uid: 0, gid: 0, range: 'root' });
});

test('AppManager spawn seam: homes and identities are asked, with the runner capabilities', async () => {
  const asked = {};
  const fake = {
    homes: { resolve: async (req) => { asked.home = req; return { kind: 'app-user', hostPath: '/h', volumeSubpath: 'h', logicalPath: '/home/aura', uid: 7, gid: 7, mode: 0o700 }; } },
    identities: { identityFor: async (req) => { asked.identity = req; return { uid: 200001, gid: 200001, range: 'app' }; } },
  };
  const caps = ContainerRunner.prototype.capabilities.call({});
  const manifest = AppManifestSchema.parse({ ...base, environmentScope: 'user' });
  fake.homeRequest = AppManager.prototype.homeRequest;
  fake.poolHomeUser = AppManager.prototype.poolHomeUser;
  const installation = { installationId: 'inst-1', runAs: 'app' };
  const ctx = await AppManager.prototype.spawnContext.call(fake, 'org.p5.app', 'org.p5.app-1', { manifest, runtime: { capabilities: caps }, owner: 'u1', installation });
  assert.equal(ctx.home.kind, 'app-user');
  assert.equal(ctx.identity.uid, 200001);
  // Stream H: the App Home of the installation, owned by the identity the app runs as.
  assert.deepEqual(asked.home, {
    installationId: 'inst-1', environmentScope: 'user', executionContext: 'application', userId: 'u1',
    appIdentity: { uid: 200001, gid: 200001 }, runtime: caps,
  });
  assert.deepEqual(asked.identity, { appId: 'org.p5.app', installationId: 'inst-1', runAs: 'app', userId: 'u1' });
  // A pool member of a user-scope app is warmed for the owner (only the owner claims it).
  await AppManager.prototype.spawnContext.call(fake, 'org.p5.app', 'org.p5.app-2', { manifest, runtime: { capabilities: caps }, inPool: true, installation });
  assert.equal(asked.home.userId, 'default');
  // A global app's pool member asks for no user.
  const global = AppManifestSchema.parse({ ...base });
  await AppManager.prototype.spawnContext.call(fake, 'org.p5.app', 'org.p5.app-3', { manifest: global, runtime: { capabilities: caps }, inPool: true, installation });
  assert.equal('userId' in asked.home, false);
  // No recorded installation: no App Home, no start (fail closed, never the shared home).
  await assert.rejects(
    AppManager.prototype.spawnContext.call(fake, 'org.p5.app', 'org.p5.app-4', { manifest, runtime: { capabilities: caps }, owner: 'u1', installation: null }),
    (e) => e instanceof HomeDeniedError && e.reason === 'installation-unresolved');
});

test('AppManager runner selection: a latched runtime id that is not installed is a Q17 error, never PRoot', () => {
  const runtimes = new RuntimeRegistry();
  const p = { id: 'p' }, c = { id: 'c' };
  runtimes.register({ descriptor: { id: 'proot', settingsSchema: { type: 'object', properties: {} } }, runner: p });
  runtimes.register({ descriptor: { id: 'container', settingsSchema: { type: 'object', properties: {} } }, runner: c });
  const self = { runtimes, instances: new Map([['a-1', { sandbox: 'proot' }], ['b-1', { sandbox: 'container' }], ['g-1', { sandbox: 'gvisor' }], ['n-1', {}]]) };
  assert.equal(AppManager.prototype.runnerOf.call(self, 'a-1'), p);
  assert.equal(AppManager.prototype.runnerOf.call(self, 'b-1'), c);
  assert.throws(() => AppManager.prototype.runnerOf.call(self, 'g-1'),
    (e) => e instanceof RuntimeUnavailableError && e.code === 'runtime-not-installed' && e.runtime === 'gvisor');
  assert.throws(() => AppManager.prototype.runnerOf.call(self, 'n-1'), /has no runtime/, 'no latched runtime: no fallback');
  assert.throws(() => AppManager.prototype.runnerOf.call(self, 'unknown-1'), /has no runtime/);
});
