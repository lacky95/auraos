// App Host registry and installation lifecycle against a REAL valkey-server
// (KvServer on a tmp dataDir). Every path is under a temp dir.
//
//   node tools/run-tests.mjs --only=packages/core
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KvServer, createRedis, isValidNamespace } from '@aura/kv-store';
import { AppHostRestoreError, createAppHostRegistry, sameAppSource } from '../dist/app-hosts/AppHostRegistry.js';
import { AppHostLifecycle } from '../dist/app-hosts/lifecycle.js';
import { ManifestHostGuard, manifestHostClaim } from '../dist/app-hosts/manifestHostGuard.js';
import { Installer, isTrashEntryOf, removeContained } from '../dist/nexus/Installer.js';
import { NexusManager, SystemAppRemovalError } from '../dist/nexus/NexusManager.js';
import { GrantStore } from '../dist/auth/GrantStore.js';
import { AppManager } from '../dist/app-manager/AppManager.js';
import { AppRegistry } from '../dist/app-manager/AppRegistry.js';
import { OsEventBus } from '../dist/ipc/OsEventBus.js';

const ROOT = mkdtempSync(join(tmpdir(), 'aura-apphost-'));
const server = new KvServer();
let redis;
let registry;
let lifecycle;
let grants;
const USER = { kind: 'user', userId: 'default' };
const SRC = { kind: 'oci', ref: 'reg.example/apps/notes:1.0.0' };

before(async () => {
  const uri = await server.start({ dataDir: join(ROOT, 'kv') });
  redis = createRedis(uri);
});
after(async () => {
  redis.disconnect();
  await server.stop();
  rmSync(ROOT, { recursive: true, force: true });
});
beforeEach(async () => {
  await redis.flushall();
  registry = createAppHostRegistry(() => redis);
  grants = new GrantStore(() => redis);
  // As app-hosts/services.ts wires it: grants follow the installation (Hotfix 2, S1).
  lifecycle = new AppHostLifecycle(registry, null, { revokeAppGrants: (appId, scope) => grants.revokeAppScope(appId, scope) });
});
const BY = { by: { kind: 'system' } };
const grantApp = (id, permission = 'notifications.popup', appScope = 'user') => grants.grant({ kind: 'app', id }, permission, { ...BY, appScope });
const grantsOf = async (id) => (await grants.listFor({ kind: 'app', id })).map((g) => `${g.permission}@${g.appScope ?? '*'}`).sort();

const newInstall = (over = {}) => registry.createInstallation({
  appId: 'com.example.notes', originId: randomUUID(), scope: 'user', source: SRC, ...over,
});
const allocate = (installation, isSystemApp = false) => registry.allocate({ installation, instanceScope: USER, isSystemApp });

function scopes() {
  const base = mkdtempSync(join(ROOT, 'scopes-'));
  const def = (id, priority, immutable) => {
    const dataDir = join(base, id);
    const appsDir = id === 'system' ? join(base, 'repo', 'apps') : join(dataDir, 'apps');
    mkdirSync(appsDir, { recursive: true });
    return { id, priority, immutable, appsDir, dataDir };
  };
  return [def('system', 0, true), def('global', 1, false), def('user', 2, false)];
}
function putApp(scope, id, manifest = {}) {
  const dir = join(scope.appsDir, id);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'app.manifest.json');
  writeFileSync(p, JSON.stringify({ id, name: 'App', version: '1.0.0', ...manifest }));
  return p;
}

// ── allocation ───────────────────────────────────────────────────────────────

test('allocate: readable generated host, stored once, idempotent', async () => {
  const originId = 'b61b5559-5176-4a3a-8f7e-111111111111';
  const inst = await newInstall({ appId: 'com.aura.nexus', originId, scope: 'system' });
  const rec = await allocate(inst, true);
  assert.equal(rec.baseName, 'nexusb61b5559');
  assert.deepEqual(rec.slots.map((s) => [s.slot, s.label, s.instanceId]), [[1, 'nexusb61b5559', null]]);
  assert.deepEqual(await allocate(inst, true), rec);
  const r = await registry.resolveLabel('NEXUSB61B5559');
  assert.equal(r.status, 'active');
  assert.equal(r.record.installationId, inst.installationId);
});

test('allocate: an app without originId falls back to the installation id', async () => {
  const inst = await newInstall({ appId: 'com.example.hello', originId: null });
  const rec = await allocate(inst);
  assert.equal(rec.baseName, `hello${inst.installationId.replace(/-/g, '').slice(0, 8)}`);
});

test('allocate: a non-system app named after a system app gets the neutral prefix', async () => {
  const inst = await newInstall({ appId: 'com.evil.settings', originId: 'aaaaaaaa-5176-4a3a-8f7e-111111111111' });
  assert.equal((await allocate(inst)).baseName, 'appaaaaaaaa');
});

test('allocate: a copied originId inherits nothing', async () => {
  const originId = randomUUID();
  const a = await allocate(await newInstall({ originId }));
  const b = await allocate(await newInstall({ appId: 'com.other.notes', originId }));
  assert.notEqual(a.baseName, b.baseName);
  assert.notEqual(a.installationId, b.installationId);
});

test('allocate: never equals a manifest host or the base of its slot form', async () => {
  const originId = 'cccccccc-5176-4a3a-8f7e-111111111111';
  for (const held of ['notescccccccc', 'notesccccccccx2']) {
    await redis.flushall();
    const reg = createAppHostRegistry(() => redis, { reservedNames: () => [held] });
    const inst = await reg.createInstallation({ appId: 'com.example.notes', originId, scope: 'user', source: SRC });
    const rec = await reg.allocate({ installation: inst, instanceScope: USER, isSystemApp: false });
    assert.notEqual(rec.baseName, 'notescccccccc');
  }
});

test('concurrency: one record for concurrent allocates of one installation', async () => {
  const inst = await newInstall();
  const recs = await Promise.all(Array.from({ length: 40 }, () => allocate(inst)));
  assert.equal(new Set(recs.map((r) => r.baseName)).size, 1);
  assert.equal((await registry.listForApp(inst.appId)).length, 1);
});

test('concurrency: installations racing for one name all get distinct labels', async () => {
  const originId = randomUUID();
  const installs = await Promise.all(Array.from({ length: 16 }, (_, i) => registry.createInstallation({
    appId: `com.racer${i}.notes`, originId, scope: 'user', source: SRC,
  })));
  const recs = await Promise.all(installs.map((i) => allocate(i)));
  assert.equal(new Set(recs.map((r) => r.baseName)).size, 16);
  for (const r of recs) {
    const res = await registry.resolveLabel(r.baseName);
    assert.equal(res.record.installationId, r.installationId);
  }
});

test('concurrency: createInstallation yields one binding', async () => {
  const input = { appId: 'com.example.notes', originId: randomUUID(), scope: 'user', source: SRC };
  const all = await Promise.all(Array.from({ length: 30 }, () => registry.createInstallation(input)));
  assert.equal(new Set(all.map((i) => i.installationId)).size, 1);
});

test('concurrency: concurrent claims get distinct, gapless slots', async () => {
  const inst = await newInstall();
  await allocate(inst);
  const got = await Promise.all(Array.from({ length: 24 }, (_, i) => registry.assignSlot(inst.installationId, USER, `i-${i}`)));
  assert.deepEqual(got.map((s) => s.slot).sort((a, b) => a - b), Array.from({ length: 24 }, (_, i) => i + 1));
  assert.equal(new Set(got.map((s) => s.label)).size, 24);
});

// ── tombstones ───────────────────────────────────────────────────────────────

test('tombstones: every label of a retired installation is never allocated again', async () => {
  const originId = 'dddddddd-5176-4a3a-8f7e-111111111111';
  const inst = await newInstall({ originId });
  const rec = await allocate(inst);
  await registry.assignSlot(inst.installationId, USER, 'a');
  const second = await registry.assignSlot(inst.installationId, USER, 'b');
  assert.equal(second.label, `${rec.baseName}x2`);

  const stones = await registry.retire(inst.installationId);
  assert.deepEqual(stones.map((t) => t.label).sort(), [rec.baseName, second.label].sort());
  assert.equal((await registry.resolveLabel(rec.baseName)).status, 'retired');
  assert.equal((await registry.resolveLabel(second.label)).status, 'retired');
  await assert.rejects(allocate(inst), /retired/);

  // The same app, same originId, installed again: fresh names, old ones stay dead.
  const again = await newInstall({ originId });
  assert.notEqual(again.installationId, inst.installationId);
  const fresh = await allocate(again);
  assert.notEqual(fresh.baseName, rec.baseName);
  await registry.assignSlot(again.installationId, USER, 'c');
  const fresh2 = await registry.assignSlot(again.installationId, USER, 'd');
  assert.notEqual(fresh2.label, second.label);
  assert.equal((await registry.resolveLabel(rec.baseName)).tombstone.installationId, inst.installationId);
});

test('tombstones: concurrent retire and allocate never revive a label', async () => {
  const originId = 'eeeeeeee-5176-4a3a-8f7e-111111111111';
  const inst = await newInstall({ originId });
  const { baseName } = await allocate(inst);
  const other = await registry.createInstallation({ appId: 'com.example.notes', originId, scope: 'global', source: SRC });
  const [, rec] = await Promise.all([registry.retire(inst.installationId), allocate(other)]);
  assert.notEqual(rec.baseName, baseName);
  assert.equal((await registry.resolveLabel(baseName)).status, 'retired');
});

// ── slots ────────────────────────────────────────────────────────────────────

test('slots: stable across container replacement and a shell restart', async () => {
  const inst = await newInstall();
  const rec = await allocate(inst);
  const a = await registry.assignSlot(inst.installationId, USER, 'container-1');
  assert.equal(a.label, rec.baseName);
  assert.equal((await registry.assignSlot(inst.installationId, USER, 'container-1')).slot, 1);
  const b = await registry.assignSlot(inst.installationId, USER, 'container-2');
  assert.equal(b.slot, 2);

  await registry.releaseSlot(inst.installationId, USER, 'container-1');
  const restarted = createAppHostRegistry(() => redis);
  const replaced = await restarted.assignSlot(inst.installationId, USER, 'container-3');
  assert.deepEqual([replaced.slot, replaced.label], [1, rec.baseName]);
  assert.equal((await restarted.resolveLabel(b.label)).slot.instanceId, 'container-2');
});

test('slots: a warm-pool member has none until claimed', async () => {
  const s = scopes()[2];
  putApp(s, 'com.example.notes');
  const { installation, record } = await lifecycle.sync({ appId: 'com.example.notes', originId: null, scope: 'user', source: SRC });
  assert.equal(record.slots[0].instanceId, null);
  await lifecycle.claimSlot('com.example.notes', 'user', 'pool-1');
  assert.equal((await registry.listForApp(installation.appId))[0].slots[0].instanceId, 'pool-1');
  await lifecycle.releaseDeadSlots('com.example.notes', () => false);
  assert.equal((await registry.listForApp(installation.appId))[0].slots[0].instanceId, null);
});

test('slots: separate user scopes get separate hosts', async () => {
  const inst = await newInstall();
  const a = await registry.allocate({ installation: inst, instanceScope: USER, isSystemApp: false });
  const b = await registry.allocate({ installation: inst, instanceScope: { kind: 'user', userId: 'other' }, isSystemApp: false });
  assert.notEqual(a.baseName, b.baseName);
});

// ── KV reachability ──────────────────────────────────────────────────────────

test('apphost: is not reachable as a /api/kv namespace', () => {
  for (const ns of ['apphost', 'apphost:label', 'apphost:install', 'app/apphost', 'apphost:frame:com.a.b']) {
    assert.equal(isValidNamespace(ns), false, ns);
  }
});

// ── restore ──────────────────────────────────────────────────────────────────

test('sameAppSource: a version change is the same place, another repo is not', () => {
  assert.ok(sameAppSource(SRC, { kind: 'oci', ref: 'reg.example/apps/notes:2.0.0' }));
  assert.ok(sameAppSource({ kind: 'git', ref: 'https://x/y.git#v1' }, { kind: 'git', ref: 'https://x/y.git#v2' }));
  assert.ok(!sameAppSource(SRC, { kind: 'oci', ref: 'evil.example/apps/notes:1.0.0' }));
  assert.ok(!sameAppSource(SRC, { kind: 'git', ref: SRC.ref }));
  assert.ok(!sameAppSource({ kind: 'git', ref: 'git@github.com:alice/notes.git' }, { kind: 'git', ref: 'git@github.com:mallory/notes.git' }));
  assert.ok(sameAppSource({ kind: 'git', ref: 'git@github.com:alice/notes.git#v1' }, { kind: 'git', ref: 'git@github.com:alice/notes.git#v2' }));
  assert.ok(!sameAppSource({ kind: 'local', ref: '/src/a:1' }, { kind: 'local', ref: '/src/a:2' }));
});

test('reactivate: needs the same origin, and confirmation for a changed source', async () => {
  const originId = randomUUID();
  const inst = await newInstall({ originId });
  const rec = await allocate(inst);
  await registry.assignSlot(inst.installationId, USER, 'x');
  await registry.reserve(inst.installationId);
  const held = await registry.resolveLabel(rec.baseName);
  assert.equal(held.status, 'reserved');
  assert.equal(held.slot.instanceId, null);

  const id = inst.installationId;
  await assert.rejects(registry.reactivate({ installationId: id, originId: randomUUID(), source: SRC }),
    (e) => e instanceof AppHostRestoreError && e.code === 'origin-mismatch');
  const moved = { kind: 'oci', ref: 'other.example/notes:1.0.0' };
  await assert.rejects(registry.reactivate({ installationId: id, originId, source: moved }),
    (e) => e instanceof AppHostRestoreError && e.code === 'source-changed');
  assert.equal((await registry.resolveLabel(rec.baseName)).status, 'reserved');

  const back = await registry.reactivate({ installationId: id, originId, source: moved, confirmedSourceChange: true });
  assert.equal(back[0].baseName, rec.baseName);
  assert.equal((await registry.resolveLabel(rec.baseName)).status, 'active');
});

// ── lifecycle ────────────────────────────────────────────────────────────────

test('migration: every app gets a host, idempotent, no manifest written', async () => {
  const [sys, glob, user] = scopes();
  const files = [
    putApp(sys, 'com.aura.terminal', { originId: randomUUID() }),
    putApp(user, 'io.lakner.callgemini'),
    putApp(user, 'com.example.hello', { hosts: [{ name: 'settings' }] }),
    putApp(glob, 'com.example.testproot'),
    putApp(glob, 'com.example.notes', { originId: randomUUID() }),
    putApp(user, 'com.example.notes', { originId: randomUUID() }),
  ];
  const before = files.map((f) => [readFileSync(f, 'utf8'), statSync(f).mtimeMs]);
  const guard = new ManifestHostGuard();
  const life = new AppHostLifecycle(registry, guard);

  const first = await life.migrate([sys, glob, user]);
  assert.deepEqual(first, { apps: 6, failed: [] });
  const snapshot = async () => {
    const out = {};
    for (const id of ['com.aura.terminal', 'io.lakner.callgemini', 'com.example.hello', 'com.example.testproot', 'com.example.notes']) {
      out[id] = (await registry.listForApp(id)).map((r) => [r.installationId, r.baseName]).sort();
    }
    return out;
  };
  const once = await snapshot();
  assert.equal(once['com.example.notes'].length, 2, 'a shadowed copy has its own installation');
  for (const id of Object.keys(once)) assert.ok(once[id].length >= 1, id);

  assert.deepEqual(await life.migrate([sys, glob, user]), { apps: 6, failed: [] });
  assert.deepEqual(await snapshot(), once);
  assert.deepEqual(files.map((f) => [readFileSync(f, 'utf8'), statSync(f).mtimeMs]), before);
  assert.ok((await registry.getKnownManifestHosts()).has(manifestHostClaim('com.example.hello', 'settings')));
});

test('lifecycle: update keeps the installation, origin assignment fills it in', async () => {
  const app = { appId: 'com.example.notes', originId: null, scope: 'user', source: SRC };
  const a = await lifecycle.sync(app);
  const originId = randomUUID();
  const b = await lifecycle.sync({ ...app, originId, source: { kind: 'oci', ref: 'reg.example/apps/notes:2.0.0', digest: 'sha256:1' } });
  assert.equal(b.installation.installationId, a.installation.installationId);
  assert.equal(b.installation.originId, originId);
  assert.equal(b.record.baseName, a.record.baseName);
});

test('lifecycle: a different originId is a new installation, the old one stays reserved', async () => {
  const app = { appId: 'com.example.notes', originId: randomUUID(), scope: 'user', source: SRC };
  const a = await lifecycle.sync(app);
  const b = await lifecycle.sync({ ...app, originId: randomUUID() });
  assert.notEqual(b.installation.installationId, a.installation.installationId);
  assert.notEqual(b.record.baseName, a.record.baseName);
  assert.equal((await registry.getInstallation(a.installation.installationId)).state, 'reserved');
  assert.equal((await registry.resolveLabel(a.record.baseName)).status, 'reserved');
});

test('lifecycle: clone and shadow get their own installations', async () => {
  const originId = randomUUID();
  const a = await lifecycle.sync({ appId: 'com.example.notes', originId, scope: 'global', source: SRC });
  const shadow = await lifecycle.sync({ appId: 'com.example.notes', originId, scope: 'user', source: { kind: 'local', ref: '/x' } });
  const clone = await lifecycle.sync({ appId: 'com.example.notes.copy', originId, scope: 'user', source: { kind: 'local', ref: '/y' } });
  assert.equal(new Set([a, shadow, clone].map((x) => x.installation.installationId)).size, 3);
  assert.equal(new Set([a, shadow, clone].map((x) => x.record.baseName)).size, 3);
});

// A clone lands a directory and registers it itself (/api/admin/clone-app).
// AppManager's constructor wires real runners, so (as app-preview.test.mjs
// does) the prototype methods run against a small fake `this` around a real
// AppRegistry and the real lifecycle.
function landedAppManager(scope) {
  const registry = new AppRegistry([scope]);
  const fake = {
    registry, appHostsReady: true, rebound: [],
    scopeRegistry: { getById: () => scope },
    mounts: { rebindTarget: async (id) => { fake.rebound.push(id); } },
    refreshManifestDerived() {},
    async blockForeignHosts() {},
  };
  for (const name of ['reloadScopedApp', 'reloadManifest', 'syncAppHost']) fake[name] = AppManager.prototype[name].bind(fake);
  return fake;
}
function installedEvents(appId) {
  const seen = [];
  const on = (e) => { if (e.appId === appId) seen.push(e.appId); };
  OsEventBus.on('app:installed', on);
  return { seen, off: () => OsEventBus.off('app:installed', on) };
}

test('clone: a landed app is announced once and has its own installation when the route answers (D20)', async () => {
  const user = scopes()[2];
  const source = await lifecycle.sync({ appId: 'io.lakner.compass', originId: randomUUID(), scope: 'user', source: { kind: 'local', ref: '/src' } });
  const id = 'com.aura.diagnostics';
  const manifestPath = putApp(user, id, { originId: randomUUID() });
  const mgr = landedAppManager(user);
  const ev = installedEvents(id);
  try {
    mgr.reloadScopedApp(id);
    assert.equal(await mgr.syncAppHost(id, undefined, lifecycle), null);
    // The watcher's own `add` comes later: the app is known by then, no second event.
    mgr.registry['loadManifestFile'](manifestPath, user);
    assert.deepEqual(ev.seen, [id], 'app:installed exactly once');
  } finally { ev.off(); }
  assert.deepEqual(mgr.rebound, [id]);
  const inst = await registry.findInstallation(id, 'user');
  assert.ok(inst, 'the clone has an installation record');
  assert.notEqual(inst.installationId, source.installation.installationId);
  assert.equal((await registry.listForApp(id)).length, 1, 'and its host');
  // The `app:installed` listener and the route may sync at once: still one installation.
  await Promise.all([mgr.syncAppHost(id, undefined, lifecycle), mgr.syncAppHost(id, undefined, lifecycle)]);
  assert.equal((await registry.listInstallations(id)).length, 1);
});

test('clone: a silent reloadManifest of a landed app hides it from the watcher (the 0.0.49 clone bug)', () => {
  const user = scopes()[2];
  const id = 'com.example.silent';
  const manifestPath = putApp(user, id);
  const mgr = landedAppManager(user);
  const ev = installedEvents(id);
  try {
    mgr.reloadManifest(id);
    mgr.registry['loadManifestFile'](manifestPath, user);
    assert.deepEqual(ev.seen, [], 'no app:installed: nothing would allocate its installation');
  } finally { ev.off(); }
});

test('syncAppHost: says why it failed, and that app hosts are not ready before the boot migration', async () => {
  const user = scopes()[2];
  const id = 'com.example.later';
  putApp(user, id);
  const mgr = landedAppManager(user);
  mgr.registry.reloadFromDisk(id);
  assert.equal(await mgr.syncAppHost(id, undefined, { syncDiscovered: async () => { throw new Error('kv down'); } }), 'kv down');
  mgr.appHostsReady = false;
  let called = false;
  assert.match(await mgr.syncAppHost(id, undefined, { syncDiscovered: async () => { called = true; } }), /not ready/,
    'B8: no boot migration (failed or not run yet) is reported, not success');
  assert.equal(called, false);
});

test('syncAppHost: a copy landed in a shadowed scope gets its own installation (B8)', async () => {
  const [, global, user] = scopes();
  const id = 'com.example.shadowed';
  putApp(user, id, { originId: randomUUID() });
  const gOrigin = randomUUID();
  putApp(global, id, { originId: gOrigin });
  const appRegistry = new AppRegistry([global, user]);
  appRegistry.reloadFromDisk(id);
  const fake = {
    registry: appRegistry, appHostsReady: true,
    scopeRegistry: { getById: (s) => (s === 'global' ? global : user) },
    async blockForeignHosts() {},
  };
  const sync = AppManager.prototype.syncAppHost.bind(fake);
  assert.equal(appRegistry.getById(id).scopeId, 'user', 'the user copy wins');
  assert.equal(await sync(id, 'global', lifecycle), null);
  const g = await registry.findInstallation(id, 'global');
  assert.ok(g, 'the landed (global) copy has its installation');
  assert.equal(g.originId, gOrigin, 'from its own manifest, not the winner');
  assert.equal(await registry.findInstallation(id, 'user'), null, 'the winner is not touched');
  assert.equal(await sync('com.example.nowhere', 'global', lifecycle), null, 'nothing landed there: nothing to do');
});

// ── grants follow the installation (Hotfix 2, S1) ──────────────────────────

test('GrantStore.revokeAppScope: that scope and unpinned grants go; another scope\'s stay', async () => {
  const id = 'com.example.granted';
  await grantApp(id, 'notifications.popup', 'user');
  await grants.grant({ kind: 'app', id }, 'notifications.locked', BY);
  await grantApp(id, 'terminal.embed', 'global');
  await grants.grant({ kind: 'app', id }, 'credential.read:GEMINI_API_KEY', { ...BY, appScope: 'user', scope: { kind: 'user', id: 'default' } });
  const dropped = await grants.revokeAppScope(id, 'user');
  assert.deepEqual(dropped.map((g) => g.permission).sort(), ['credential.read:GEMINI_API_KEY', 'notifications.locked', 'notifications.popup']);
  assert.deepEqual(await grantsOf(id), ['terminal.embed@global']);
});

test('grants: the first installation keeps grants from before installations existed', async () => {
  const id = 'com.example.old';
  await grantApp(id);
  await lifecycle.sync({ appId: id, originId: randomUUID(), scope: 'user', source: SRC });
  assert.deepEqual(await grantsOf(id), ['notifications.popup@user']);
});

test('grants: deleting app data revokes them; an app created later under the id starts with none', async () => {
  const id = 'com.example.deleted';
  await lifecycle.sync({ appId: id, originId: randomUUID(), scope: 'user', source: SRC });
  await grantApp(id);
  await grantApp(id, 'terminal.embed', 'global');
  await lifecycle.retireApp(id, 'user');
  assert.deepEqual(await grantsOf(id), ['terminal.embed@global'], 'only the user-scope ones');
  // A grant left behind by any other path still does not reach the next app.
  await grantApp(id);
  await lifecycle.sync({ appId: id, originId: randomUUID(), scope: 'user', source: { kind: 'local', ref: '/new' } });
  assert.deepEqual(await grantsOf(id), ['terminal.embed@global']);
});

test('grants: another origin under the id (clone --force, origin --reassign) revokes; the same app keeps them', async () => {
  const id = 'com.example.replaced';
  const origin = randomUUID();
  await lifecycle.sync({ appId: id, originId: origin, scope: 'user', source: SRC });
  await grantApp(id);
  await lifecycle.sync({ appId: id, originId: origin, scope: 'user', source: { ...SRC, ref: 'reg.example/apps/notes:1.1.0' } });
  assert.deepEqual(await grantsOf(id), ['notifications.popup@user'], 'an update keeps them');
  await lifecycle.sync({ appId: id, originId: randomUUID(), scope: 'user', source: SRC });
  assert.deepEqual(await grantsOf(id), [], 'a new origin is another app');
});

test('grants: a failed revoke stops the replacement before a new installation exists', async () => {
  const id = 'com.example.failclosed';
  const life = new AppHostLifecycle(registry, null, { revokeAppGrants: async () => { throw new Error('kv down'); } });
  const first = await life.sync({ appId: id, originId: randomUUID(), scope: 'user', source: SRC });
  await assert.rejects(life.sync({ appId: id, originId: randomUUID(), scope: 'user', source: SRC }), /kv down/);
  assert.equal((await registry.findInstallation(id, 'user')).installationId, first.installation.installationId);
  await assert.rejects(life.retireApp(id, 'user'), /kv down/);
  assert.equal((await registry.findInstallation(id, 'user')).state, 'active', 'nothing retired');
});

test('lifecycle: restore check covers same app, moved source, other app, unrecorded data', async () => {
  const originId = randomUUID();
  const app = { appId: 'com.example.notes', originId, scope: 'user', source: SRC };
  assert.deepEqual(await lifecycle.checkRestore(app, false), { kind: 'none' });
  assert.equal((await lifecycle.checkRestore(app, true)).reason, 'unrecorded');

  const { installation, record } = await lifecycle.sync(app);
  assert.deepEqual(await lifecycle.checkRestore(app, true), { kind: 'none' }, 'an active install is an update');
  await lifecycle.reserveApp(app.appId, 'user');

  const same = await lifecycle.checkRestore({ ...app, source: { kind: 'oci', ref: 'reg.example/apps/notes:9.0.0' } }, true);
  assert.equal(same.kind, 'restore');
  const moved = await lifecycle.checkRestore({ ...app, source: { kind: 'oci', ref: 'other.example/notes:1' } }, true);
  assert.deepEqual([moved.kind, moved.reason], ['confirm', 'source-changed']);
  const foreign = { ...app, originId: randomUUID() };
  assert.equal((await lifecycle.checkRestore(foreign, true)).kind, 'deny');
  assert.equal((await lifecycle.checkRestore({ ...app, originId: null }, true)).kind, 'deny');

  await lifecycle.completeInstall(foreign, { kind: 'deny', installation }, []);
  const now = await registry.findInstallation(app.appId, 'user');
  assert.notEqual(now.installationId, installation.installationId);
  assert.equal((await registry.resolveLabel(record.baseName)).status, 'reserved', 'the owner keeps its label');
  assert.equal((await registry.getInstallation(installation.installationId)).state, 'reserved');
});

test('lifecycle: a watcher event during an install cannot decide the restore', async () => {
  const originId = randomUUID();
  const app = { appId: 'com.example.notes', originId, scope: 'user', source: SRC };
  const { installation } = await lifecycle.sync(app);
  await lifecycle.reserveApp(app.appId, 'user');
  const moved = { ...app, source: { kind: 'oci', ref: 'other.example/notes:1' } };
  const check = await lifecycle.checkRestore(moved, true);
  lifecycle.beginInstall(app.appId, 'user');
  await lifecycle.syncDiscovered(moved);
  assert.equal((await registry.findInstallation(app.appId, 'user')).installationId, installation.installationId);
  await lifecycle.completeInstall(moved, check, []);
  lifecycle.endInstall(app.appId, 'user');
  const now = await registry.findInstallation(app.appId, 'user');
  assert.deepEqual([now.installationId, now.state], [installation.installationId, 'active']);
});

test('lifecycle: purge retires every installation in that scope only', async () => {
  const originId = randomUUID();
  const glob = await lifecycle.sync({ appId: 'com.example.notes', originId, scope: 'global', source: SRC });
  const user = await lifecycle.sync({ appId: 'com.example.notes', originId, scope: 'user', source: SRC });
  await lifecycle.retireApp('com.example.notes', 'user');
  assert.equal((await registry.resolveLabel(user.record.baseName)).status, 'retired');
  assert.equal((await registry.resolveLabel(glob.record.baseName)).status, 'active');
  const again = await lifecycle.sync({ appId: 'com.example.notes', originId, scope: 'user', source: SRC });
  assert.notEqual(again.installation.installationId, user.installation.installationId);
  assert.notEqual(again.record.baseName, user.record.baseName);
});

// ── host guard ───────────────────────────────────────────────────────────────

test('guard: drops taken and protected names, keeps accepted ones', () => {
  const guard = new ManifestHostGuard();
  const m = (id, names, scopeId = 'user') => ({ id, scopeId, hosts: names.map((name) => ({ name })) });
  const holder = m('com.a.holder', ['shared']);
  const names = (x) => x.map((h) => h.name);

  // Before the migration records claims, protected names are not judged.
  assert.deepEqual(names(guard.filter(m('com.a.old', ['terminal']), [])), ['terminal']);
  guard.setKnown(new Set([manifestHostClaim('com.a.old', 'terminal')]));
  assert.deepEqual(names(guard.filter(m('com.a.old', ['terminal']), [])), ['terminal']);
  assert.deepEqual(names(guard.filter(m('com.a.new', ['terminal', 'mine']), [])), ['mine']);
  assert.deepEqual(names(guard.filter(m('com.a.clone', ['shared', 'mine']), [holder])), ['mine']);
  assert.deepEqual(names(guard.filter(m('com.a.holder', ['shared']), [holder])), ['shared'], 'itself is no conflict');
  assert.deepEqual(names(guard.filter(m('com.aura.terminal', ['terminal'], 'system'), [])), ['terminal']);
  guard.block('com.a.new', 'mine');
  assert.deepEqual(names(guard.filter(m('com.a.new', ['mine']), [])), []);
});

// ── deletion ─────────────────────────────────────────────────────────────────

function installerWorld() {
  const root = mkdtempSync(join(ROOT, 'del-'));
  const dataDir = join(root, 'data');
  const appsDir = join(dataDir, 'apps');
  mkdirSync(appsDir, { recursive: true });
  return { root, dataDir, appsDir, installer: new Installer({ appsDir, dataDir, scope: 'user' }) };
}
const write = (p, text = 'x') => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, text); };

test('purge: deletes the app, its data and its trash copies, nothing else', async () => {
  const w = installerWorld();
  const id = 'com.example.notes';
  const trash = join(w.dataDir, 'nexus', 'trash');
  write(join(w.appsDir, id, 'app.manifest.json'));
  write(join(w.appsDir, id, id, 'secret.db'));
  write(join(trash, `${id}-1700000000000`, id, 'old.db'));
  write(join(trash, `${id}-1700000000001`, 'index.js'));
  write(join(w.dataDir, 'nexus', 'retained', id, randomUUID(), id, 'kept.db'));
  write(join(w.dataDir, 'nexus', 'installed', `${id}.json`), '{}');
  // Neighbours whose names start the same way.
  const neighbours = [
    join(trash, `${id}x-1700000000000`, 'keep'),
    join(trash, `${id}.copy-1700000000000`, 'keep'),
    join(trash, `${id}-beta`, 'keep'),
    join(w.appsDir, `${id}.copy`, 'keep'),
    join(w.dataDir, 'nexus', 'retained', `${id}.copy`, 'keep'),
    join(w.dataDir, 'nexus', 'installed', `${id}.copy.json`),
  ];
  for (const n of neighbours) write(n);

  await w.installer.uninstall(id, { purge: true });

  assert.equal(existsSync(join(w.appsDir, id)), false);
  assert.deepEqual(readdirSync(trash).filter((n) => /^com\.example\.notes-\d+$/.test(n)), []);
  assert.equal(existsSync(join(w.dataDir, 'nexus', 'retained', id)), false);
  assert.equal(existsSync(join(w.dataDir, 'nexus', 'installed', `${id}.json`)), false);
  for (const n of neighbours) assert.ok(existsSync(n), n);
});

test('purge: traversal in the app id is refused and deletes nothing', async () => {
  const w = installerWorld();
  const outside = join(w.root, 'outside', 'file');
  write(outside);
  write(join(w.dataDir, 'nexus', 'trash', 'keep-1', 'f'));
  for (const bad of ['../outside', '..', '.', '', 'a/b', '/etc', 'com.a.b/../../outside', 'com.a.b\0x', '..\\outside']) {
    await assert.rejects(w.installer.uninstall(bad, { purge: true }), /invalid app id/, JSON.stringify(bad));
  }
  assert.ok(existsSync(outside));
  assert.ok(existsSync(join(w.dataDir, 'nexus', 'trash', 'keep-1', 'f')));
});

test('removeContained: only a direct child, and a symlink is never followed', () => {
  const w = installerWorld();
  const victim = join(w.root, 'victim', 'file');
  write(victim);
  for (const bad of ['..', '.', '', '../victim', 'a/b', '/abs', 'a\\b', 'a\0b']) {
    assert.throws(() => removeContained(w.appsDir, bad), /unsafe/, JSON.stringify(bad));
  }
  symlinkSync(join(w.root, 'victim'), join(w.appsDir, 'com.example.link'));
  assert.equal(removeContained(w.appsDir, 'com.example.link'), true);
  assert.equal(existsSync(join(w.appsDir, 'com.example.link')), false);
  assert.ok(existsSync(victim), 'the link target survives');
  assert.equal(removeContained(w.appsDir, 'com.example.absent'), false);
  assert.equal(removeContained(join(w.root, 'no-such-root'), 'x'), false);
});

test('purge: a symlinked app dir or trash entry removes the link, not its target', async () => {
  const w = installerWorld();
  const id = 'com.example.notes';
  const victim = join(w.root, 'victim', 'file');
  write(victim);
  symlinkSync(join(w.root, 'victim'), join(w.appsDir, id));
  mkdirSync(join(w.dataDir, 'nexus', 'trash'), { recursive: true });
  symlinkSync(join(w.root, 'victim'), join(w.dataDir, 'nexus', 'trash', `${id}-1700000000000`));
  await w.installer.uninstall(id, { purge: true });
  assert.ok(existsSync(victim));
  assert.deepEqual(readdirSync(join(w.dataDir, 'nexus', 'trash')), []);
});

test('isTrashEntryOf: the exact <id>-<digits> shape only', () => {
  assert.ok(isTrashEntryOf('com.a.b-123', 'com.a.b'));
  for (const n of ['com.a.b', 'com.a.b-', 'com.a.b-12x', 'com.a.bc-123', 'com.a.b.c-123', 'x.com.a.b-123']) {
    assert.ok(!isTrashEntryOf(n, 'com.a.b'), n);
  }
});

test('retained data: set aside for its installation, then restored', () => {
  const w = installerWorld();
  const id = 'com.example.notes';
  const inst = randomUUID();
  write(join(w.appsDir, id, id, 'notes.db'), 'mine');
  assert.ok(w.installer.hasRetainedData(id));
  w.installer.setAsideRetainedData(id, inst);
  assert.equal(w.installer.hasRetainedData(id), false);
  assert.equal(readFileSync(join(w.dataDir, 'nexus', 'retained', id, inst, id, 'notes.db'), 'utf8'), 'mine');
  w.installer.restoreRetainedData(id, inst);
  assert.equal(readFileSync(join(w.appsDir, id, id, 'notes.db'), 'utf8'), 'mine');
  assert.equal(existsSync(join(w.dataDir, 'nexus', 'retained', id, inst)), false);
  assert.throws(() => w.installer.restoreRetainedData(id, '../../evil'), /invalid/);
});

// ── the Nexus flow ───────────────────────────────────────────────────────────

function nexusWorld() {
  const defs = scopes();
  const nexus = new NexusManager({ scopes: defs, rootDataDir: join(defs[2].dataDir, '..'), hostLifecycle: lifecycle });
  const srcRoot = mkdtempSync(join(ROOT, 'src-'));
  const source = (name, manifest) => {
    const dir = join(srcRoot, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'app.manifest.json'), JSON.stringify({
      name: 'Notes', version: '1.0.0', entry: 'src/index.ts', ...manifest,
    }));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'index.ts'), 'export {};\n');
    return dir;
  };
  const run = async (opts) => {
    const gen = nexus.install({ scope: 'user', approval: async () => true, ...opts });
    const events = [];
    try {
      for (;;) {
        const n = await gen.next();
        if (n.done) return { record: n.value, events };
        events.push(n.value);
        if (n.value.type === 'identity.choice') {
          const end = await gen.next().catch((e) => e);
          return { choice: n.value.conflict, error: end, events };
        }
      }
    } catch (error) { return { error, events }; }
  };
  return { defs, user: defs[2], nexus, source, run };
}

test('nexus: keep-data reinstall from the same source restores; purge gets a fresh host', async () => {
  const w = nexusWorld();
  const id = 'com.example.notes';
  const originId = randomUUID();
  const src = w.source('a', { id, originId });
  const first = await w.run({ ref: src });
  assert.ok(first.record, String(first.error));
  const inst = await registry.findInstallation(id, 'user');
  const [{ baseName }] = await registry.listForApp(id);
  const dataFile = join(w.user.appsDir, id, id, 'notes.db');
  write(dataFile, 'mine');

  await w.nexus.uninstall(id);
  assert.equal((await registry.resolveLabel(baseName)).status, 'reserved');
  assert.equal(readFileSync(dataFile, 'utf8'), 'mine');

  const back = await w.run({ ref: src });
  assert.ok(back.record, String(back.error));
  assert.equal(readFileSync(dataFile, 'utf8'), 'mine');
  assert.equal((await registry.findInstallation(id, 'user')).installationId, inst.installationId);
  assert.equal((await registry.resolveLabel(baseName)).status, 'active');

  await w.nexus.uninstall(id, { purge: true });
  assert.equal(existsSync(join(w.user.appsDir, id)), false);
  assert.deepEqual(readdirSync(join(w.user.dataDir, 'nexus', 'trash')).filter((n) => n.startsWith(id)), []);
  assert.equal((await registry.resolveLabel(baseName)).status, 'retired');
  const fresh = await w.run({ ref: src });
  assert.ok(fresh.record, String(fresh.error));
  const [rec] = (await registry.listForApp(id)).filter((r) => r.state === 'active');
  assert.notEqual(rec.baseName, baseName);
  assert.equal(existsSync(dataFile), false);
});

test('nexus: another app under the id cannot reach retained data', async () => {
  const w = nexusWorld();
  const id = 'com.example.notes';
  const first = await w.run({ ref: w.source('a', { id, originId: randomUUID() }) });
  assert.ok(first.record, String(first.error));
  const owner = await registry.findInstallation(id, 'user');
  const dataFile = join(w.user.appsDir, id, id, 'notes.db');
  write(dataFile, 'mine');
  await w.nexus.uninstall(id);

  const other = await w.run({ ref: w.source('b', { id, originId: randomUUID() }) });
  assert.ok(other.record, String(other.error));
  assert.equal(existsSync(dataFile), false, 'the new app starts without it');
  const kept = join(w.user.dataDir, 'nexus', 'retained', id, owner.installationId, id, 'notes.db');
  assert.equal(readFileSync(kept, 'utf8'), 'mine');
  assert.notEqual((await registry.findInstallation(id, 'user')).installationId, owner.installationId);
});

test('nexus: keep-data reinstall of the same app keeps its grants; another app under the id gets none (S1 deny path)', async () => {
  const w = nexusWorld();
  const id = 'com.example.notes';
  const src = w.source('a', { id, originId: randomUUID() });
  assert.ok((await w.run({ ref: src })).record);
  await grantApp(id);
  await w.nexus.uninstall(id);
  assert.ok((await w.run({ ref: src })).record);
  assert.deepEqual(await grantsOf(id), ['notifications.popup@user'], 'restored: the same app');
  await w.nexus.uninstall(id);
  const other = await w.run({ ref: w.source('b', { id, originId: randomUUID() }) });
  assert.ok(other.record, String(other.error));
  assert.deepEqual(await grantsOf(id), [], 'denied: another app');
});

test('nexus: a built-in system app is never deleted (D1): refused before anything changes', async () => {
  const w = nexusWorld();
  const [system] = w.defs;
  const id = 'com.aura.docs';
  putApp(system, id);
  await lifecycle.sync({ appId: id, originId: randomUUID(), scope: 'system', source: { kind: 'system', ref: id } });
  await assert.rejects(w.nexus.removeFromScope(id, 'system'), (e) => e instanceof SystemAppRemovalError && /built-in system app/.test(e.message));
  assert.ok(existsSync(join(system.appsDir, id, 'app.manifest.json')), 'its code stays');
  assert.equal((await registry.findInstallation(id, 'system')).state, 'active', 'its installation too');
});

test('nexus: setAsideForOverwrite revokes grants, trashes the tree, drops the record, sets kept data aside (B2/S2)', async () => {
  const w = nexusWorld();
  const id = 'com.example.notes';
  assert.ok((await w.run({ ref: w.source('a', { id, originId: randomUUID() }) })).record);
  const owner = await registry.findInstallation(id, 'user');
  write(join(w.user.appsDir, id, id, 'notes.db'), 'mine');
  await grantApp(id);
  await w.nexus.uninstall(id); // keep data: the dir holds only its runtime data now
  const aside = await w.nexus.setAsideForOverwrite(id, 'user');
  assert.equal(aside.retained, true);
  assert.equal(readFileSync(join(w.user.dataDir, 'nexus', 'retained', id, owner.installationId, id, 'notes.db'), 'utf8'), 'mine',
    'kept for the installation it belongs to, not handed to the new app');
  assert.equal(existsSync(join(w.user.appsDir, id)), false);
  assert.deepEqual(await grantsOf(id), []);

  // Over a live app: the whole tree to trash, the record gone.
  assert.ok((await w.run({ ref: w.source('c', { id, originId: randomUUID() }) })).record);
  const record = join(w.user.dataDir, 'nexus', 'installed', `${id}.json`);
  assert.ok(existsSync(record));
  const again = await w.nexus.setAsideForOverwrite(id, 'user');
  assert.ok(again.trash && existsSync(join(again.trash, 'app.manifest.json')), 'moved, not deleted');
  assert.equal(existsSync(record), false);
  assert.equal(existsSync(join(w.user.appsDir, id)), false);
});

test('nexus: a changed source asks first, and confirming restores', async () => {
  const w = nexusWorld();
  const id = 'com.example.notes';
  const originId = randomUUID();
  const first = await w.run({ ref: w.source('a', { id, originId }) });
  assert.ok(first.record, String(first.error));
  const owner = await registry.findInstallation(id, 'user');
  const dataFile = join(w.user.appsDir, id, id, 'notes.db');
  write(dataFile, 'mine');
  await w.nexus.uninstall(id);

  const moved = w.source('moved', { id, originId });
  const asked = await w.run({ ref: moved });
  assert.ok(asked.choice, 'needs a decision');
  assert.deepEqual(asked.choice.choices, ['update-existing', 'install-copy']);
  assert.equal(existsSync(join(w.user.appsDir, id, 'app.manifest.json')), false, 'nothing installed yet');
  assert.equal((await registry.getInstallation(owner.installationId)).state, 'reserved');

  const ok = await w.run({ ref: moved, identity: { action: 'update-existing' } });
  assert.ok(ok.record, String(ok.error));
  assert.equal(readFileSync(dataFile, 'utf8'), 'mine');
  assert.equal((await registry.findInstallation(id, 'user')).installationId, owner.installationId);
});

test('nexus: host conflicts and protected names cannot be bypassed', async () => {
  const w = nexusWorld();
  const hosts = [{ name: 'marklayer' }];
  const first = await w.run({ ref: w.source('a', { id: 'com.example.notes', originId: randomUUID(), hosts }) });
  assert.ok(first.record, String(first.error));

  const clash = await w.run({ ref: w.source('b', { id: 'com.other.app', originId: randomUUID(), hosts }) });
  assert.match(clash.error?.message ?? clash.error?.errors?.join(' ') ?? String(clash.error), /validation|marklayer/i);
  assert.equal(existsSync(join(w.user.appsDir, 'com.other.app')), false);

  const reserved = await w.run({ ref: w.source('d', { id: 'com.evil.term', originId: randomUUID(), hosts: [{ name: 'terminal' }] }) });
  assert.ok(reserved.error, 'a system app name is refused');
  assert.equal(existsSync(join(w.user.appsDir, 'com.evil.term')), false);

  const [{ baseName }] = await registry.listForApp('com.example.notes');
  const spoof = await w.run({ ref: w.source('e', { id: 'com.evil.spoof', originId: randomUUID(), hosts: [{ name: baseName }] }) });
  assert.ok(spoof.error, 'an allocated label is refused');
});

test('nexus: a copy installs without the hosts it may not claim, and keeps its own', async () => {
  const w = nexusWorld();
  const hostsOf = (id) => JSON.parse(readFileSync(join(w.user.appsDir, id, 'app.manifest.json'), 'utf8')).hosts ?? [];
  const id = 'com.example.hosted';
  const hosts = [{ name: 'hostedapp' }];
  const originId = randomUUID();
  const first = await w.run({ ref: w.source('a', { id, originId, hosts }) });
  assert.ok(first.record, String(first.error));

  const asCopy = await w.run({
    ref: w.source('b', { id, originId: randomUUID(), hosts: [...hosts, { name: 'hostedextra' }] }),
    identity: { action: 'install-as', appId: 'com.example.hostedcopy' },
  });
  assert.ok(asCopy.record, String(asCopy.error));
  assert.deepEqual(hostsOf('com.example.hostedcopy').map((h) => h.name), ['hostedextra'], 'only the free name stays');
  assert.deepEqual(hostsOf(id).map((h) => h.name), ['hostedapp'], 'the original keeps its host');

  const independent = await w.run({
    ref: w.source('c', { id, originId, hosts: [{ name: 'terminal' }, ...hosts] }),
    identity: { action: 'install-copy', appId: 'com.example.hostedcopy2' },
  });
  assert.ok(independent.record, String(independent.error));
  assert.deepEqual(hostsOf('com.example.hostedcopy2'), [], 'a protected or taken name is left out');

  const foreign = await w.run({ ref: w.source('d', { id: 'com.other.claimer', originId: randomUUID(), hosts }) });
  assert.ok(foreign.error, 'a different app claiming a taken host is still refused');
  assert.equal(existsSync(join(w.user.appsDir, 'com.other.claimer')), false);
});

// ── Built-in apps stay read-only; a same-id copy is a normal app (Q6, D68) ──

test('built-in: a patch activation of a built-in app is refused before anyone is asked', async () => {
  const w = nexusWorld();
  const id = 'com.aura.settings';
  const originId = randomUUID();
  putApp(w.defs[0], id, { originId, entry: 'src/index.ts' });
  await lifecycle.sync({ appId: id, originId, scope: 'system', source: { kind: 'system', ref: id } });

  const refused = await w.run({ ref: w.source('ws1', { id, originId }), action: 'app.patch.activate' });
  assert.match(String(refused.error?.message), /^system-app-later: Built-in apps are patched by system patches \(Phase 7\) or in Developer Mode$/);
  assert.equal(refused.events.some((e) => e.type === 'permission.needed' || e.type === 'install.start'), false);
  assert.equal(await registry.findInstallation(id, 'user'), null);
  assert.equal(existsSync(join(w.user.appsDir, id)), false);
});

test('built-in: a normal app with a built-in id (a store copy in user scope) is patched like any app', async () => {
  const w = nexusWorld();
  const id = 'com.aura.settings';
  const originId = randomUUID();
  putApp(w.defs[0], id, { originId, entry: 'src/index.ts' });
  await lifecycle.sync({ appId: id, originId, scope: 'system', source: { kind: 'system', ref: id } });
  const store = await w.run({ ref: w.source('store', { id, originId }) });
  assert.ok(store.record, String(store.error));
  const patched = await w.run({ ref: w.source('ws', { id, originId, version: '1.0.1' }), action: 'app.patch.activate' });
  assert.ok(patched.record, String(patched.error));
  assert.equal(patched.record.version, '1.0.1');
  assert.equal((await registry.findInstallation(id, 'user')).scope, 'user');
});

test('built-in: a same-id user copy never counts as the trusted system app (AppManager isTrustedSystemCopy)', () => {
  const trusted = (scopeId) => AppManager.prototype.isTrustedSystemCopy.call(
    { registry: { getById: (appId) => (appId === 'com.aura.terminal' && scopeId ? { id: appId, scopeId } : undefined) } },
    'com.aura.terminal',
  );
  assert.equal(trusted('system'), true, 'the active system copy');
  assert.equal(trusted('user'), false, 'a same-id user copy that shadows it');
  assert.equal(trusted('global'), false, 'a same-id global copy');
  assert.equal(trusted(null), false, 'no copy');
});
