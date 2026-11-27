// D108 P8: configuration and change management (setup/change.ts + the engine's change path):
// the grantDigest diff, §5.5 compatibility, data that stays behind, setup.version migration,
// repair-required after an update, the last applied configuration (decision 13), the user's
// own Private Home revocation. Same harness as setup-service.test.mjs (real valkey, fakes around).
//
//   node tools/run-tests.mjs --only=packages/core
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KvServer, createRedis } from '@aura/kv-store';
import { createAppHostRegistry } from '../dist/app-hosts/AppHostRegistry.js';
import { ValkeyApprovalStore } from '../dist/approvals/ValkeyApprovalStore.js';
import { payloadHash } from '../dist/approvals/state.js';
import { AppManifestSchema } from '../dist/types/manifest.js';
import { RUNTIME_FEATURE_IDS } from '../dist/runtimes/ari.js';
import {
  CredentialVault, SetupConfigStore, SetupStateMachine, SetupService, MAX_INIT_ATTEMPTS, NO_MAINTENANCE_HINT, blockingDecision,
  setupApprovalItems, askSecretName, grantDiff, grantItems, compatibilityIssues, dataStaysBehind, migrateDesired, parseAppliedSnapshot,
  RESTORE_NOTICE, DATA_STAYS_NOTE,
} from '../dist/index.js';

const ROOT = mkdtempSync(join(tmpdir(), 'aura-setup-change-'));
const KEY_FILE = join(ROOT, 'identity.key');
const server = new KvServer();
const SRC = { kind: 'oci', ref: 'reg.example/apps/mailer:1.0.0' };
const OPERATOR = { kind: 'operator' };
const OWNER = { kind: 'user', userId: 'default' };
const TERMINAL = { kind: 'terminal', userId: 'default', instanceId: 'com.aura.terminal-1' };
const ALL = Object.fromEntries(RUNTIME_FEATURE_IDS.map((id) => [id, 'supported']));
let redis;
let registry;
let store;
let machine;
let approvals;

function memoryKv() {
  const m = new Map();
  return {
    m,
    kv: () => ({
      async get(ns, key) { return m.get(`${ns}|${key}`) ?? null; },
      async set(ns, key, value) { const e = { value: JSON.parse(JSON.stringify(value)), updatedAt: 1 }; m.set(`${ns}|${key}`, e); return e; },
      async del(ns, key) { return m.delete(`${ns}|${key}`); },
      async list(ns) { return [...m.keys()].filter((k) => k.startsWith(`${ns}|`)).map((k) => k.slice(ns.length + 1)); },
    }),
  };
}

const authKey = (r) => ({
  permission: () => `permission:${r.permission}`, tool: () => `tool:${r.tool}`, context: () => `context:${r.key}`,
  grant: () => r.grant, 'home-private': () => 'home.private', 'home-private-sidecar': () => `home.private.sidecar:${r.sidecar}`,
})[r.kind]();

const BASE = { name: 'Mailer', version: '1.0.0', auraContract: 1 };
const mailer = (setup = {}, over = {}) => AppManifestSchema.parse({
  id: 'com.example.mailer', ...BASE,
  setup: {
    version: 1,
    fields: {
      smtpHost: { type: 'string', title: 'SMTP host', required: true },
      smtpPort: { type: 'integer', title: 'Port', default: 587, minimum: 1, maximum: 65535 },
      password: { type: 'secret', title: 'SMTP password', required: true, secret: { source: 'vault' } },
      sessionKey: { type: 'secret', title: 'Session key', required: true, secret: { source: 'generate', length: 32 } },
    },
    ...setup,
  },
  ...over,
});
const profiled = (profiles, over = {}) => AppManifestSchema.parse({ id: 'com.example.tools', ...BASE, profiles, ...over });
const simple = () => AppManifestSchema.parse({ id: 'com.example.simple', ...BASE });

/** A maintenance starter fake: records hook calls; `hooks` answers them. */
function fakeStarter(hooks = {}) {
  const calls = [];
  const starter = {
    calls,
    async startMaintenance(appId, opts) {
      calls.push(['start', appId, opts.reason]);
      return {
        ok: true,
        session: {
          instanceId: `${appId}-m`, appId, reason: opts.reason, startedAt: 0,
          async callHook(hook, body) { calls.push([hook, body]); return hooks[hook] ? hooks[hook](body) : null; },
          async finish(o) { calls.push(['finish', o]); },
        },
      };
    },
  };
  return starter;
}

/** One app's world: the engine with fakes around the real records. */
async function world(manifest, o = {}) {
  const appId = manifest.id;
  const inst = await registry.createInstallation({ appId, originId: randomUUID(), scope: 'user', source: SRC });
  const held = new Set(o.grants ?? []);
  const features = { ...ALL, ...(o.features ?? {}) };
  const policy = { 'app-private-home': 'grant', ...(o.policy ?? {}) };
  const kv = memoryKv();
  const vault = new CredentialVault({ kv: kv.kv, key: randomBytes(32) });
  const w = {
    appId, installationId: inst.installationId, held, features, policy, vault, kv, manifest,
    events: [], audits: [], stopped: [], granted: [], starter: o.starter ?? null, home: o.home ?? null,
  };
  w.deps = {
    ownerId: 'default',
    manifest: (id) => (id === appId ? w.manifest : null),
    installation: async (id) => (id === appId ? { installationId: inst.installationId } : null),
    store, states: machine,
    resolverPorts: async (q) => ({
      runtimeFeatures: (id) => (id === 'container' ? w.features : null),
      defaultRuntime: () => 'container',
      isAuthorized: (r) => (r.kind === 'permission' && q.approved.permissions.includes(r.permission))
        || (r.kind === 'tool' && q.approved.tools.includes(r.tool)) || w.held.has(authKey(r)),
      capability: () => ({ installed: true, granted: false }),
      policy: (id) => (id in w.policy ? w.policy[id] : null),
    }),
    approvals: {
      create: (r) => approvals.create(r), get: (id) => approvals.get(id), consume: (id, c) => approvals.consume(id, c),
      cancel: (id, by) => approvals.cancel(id, by), hash: payloadHash,
    },
    requester: (a) => (a.kind === 'terminal' ? { kind: 'instance', appId: 'com.aura.terminal', instanceId: a.instanceId, userId: a.userId } : { kind: 'user', userId: a.userId ?? 'default' }),
    appName: () => 'Mailer',
    vault,
    grants: {
      grantPermission: async ({ permission, by }) => { w.granted.push(['permission', permission, by.kind]); w.held.add(`permission:${permission}`); w.held.add(permission); },
      grantContext: async ({ key }) => { w.granted.push(['context', key]); w.held.add(`context:${key}`); },
      grantable: (p) => p.startsWith('priv.'),
    },
    readGranted: async () => false,
    home: w.home,
    maintenance: () => w.starter,
    stopWorkloads: async (id) => { w.stopped.push(id); },
    audit: async (e) => { w.audits.push(e); },
    emit: (e) => { w.events.push(e); },
    appIds: () => [appId],
  };
  w.svc = new SetupService(w.deps);
  w.restart = () => { w.svc.stop(); w.svc = new SetupService(w.deps); return w.svc; };
  w.summary = async () => (await registry.getInstallation(inst.installationId)).setup ?? null;
  w.record = async () => (await store.read({ installationId: inst.installationId })).value;
  w.gate = () => w.svc.check(appId, w.manifest, { installationId: inst.installationId });
  w.handle = async (name, value = 'pw-from-the-owner') => (await vault.store('default', name, value, { consumer: appId })).handle;
  return w;
}

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
  store = new SetupConfigStore({ identityKeyFile: KEY_FILE, redis: () => redis });
  machine = new SetupStateMachine({ registry, store });
  approvals = new ValkeyApprovalStore({ redis: () => redis });
});

const PLAIN_AND_MORE = () => profiled([
  { id: 'plain', title: 'Plain', overlay: {} },
  { id: 'more', title: 'More', overlay: { permissions: ['priv.extra'] } },
], { setup: { version: 1, fields: { greeting: { type: 'string', title: 'Greeting', default: 'hi' } } } });

// ── the change plan: privileges, values ─────────────────────────────────────

test('a profile change with more privilege needs a new approval; a plain value change needs none', async () => {
  const w = await world(PLAIN_AND_MORE());
  assert.equal((await w.svc.apply(w.appId, { profile: 'plain' }, OWNER)).status, 'ready');

  const vplan = await w.svc.changePlan(w.appId, { values: { greeting: 'hello' } });
  assert.deepEqual([vplan.approval, vplan.valuesOnly, vplan.grantDiff.changed, vplan.unchanged], [null, true, false, false]);
  assert.deepEqual(vplan.dataStaysBehind, []);
  assert.equal((await w.svc.setValues(w.appId, { values: { greeting: 'hello' } }, OWNER)).status, 'ready');
  assert.equal((await approvals.listPending()).length, 0, 'no approval for a plain value');

  const plan = await w.svc.changePlan(w.appId, { profile: 'more' });
  assert.deepEqual(plan.grantDiff.added, ['permission:priv.extra']);
  assert.deepEqual(plan.grantDiff.removed, []);
  assert.deepEqual(plan.approval.adds.permissions, ['priv.extra']);
  assert.equal(plan.valuesOnly, false);
  assert.equal(plan.from.profile, 'plain');
  assert.equal(plan.to.profile, 'more');
  assert.equal(plan.note, DATA_STAYS_NOTE);

  const r = await w.svc.reconfigure(w.appId, { profile: 'more' }, OWNER);
  assert.equal(r.status, 'on-hold', JSON.stringify(r.error));
  const rec = await approvals.get(r.approvalId);
  assert.deepEqual([rec.action, rec.payload.adds.permissions], ['app.setup.apply', ['priv.extra']]);
  assert.equal(rec.payload.grantDigest, plan.to.grantDigest, 'the approval binds the planned privilege-bearing part');
  assert.deepEqual(w.granted, [], 'requests never grant before the approval');
});

test('grantDiff/grantItems: added and removed privilege items, stable keys', () => {
  const base = { permissions: ['a'], tools: [], context: [], homeEnvironment: 'app', ownerEnvironmentSidecars: [], instanceScope: 'per-user', environmentScope: 'global', sandbox: null, networks: { web: 'shared' }, resources: null };
  const next = { ...base, permissions: ['b'], homeEnvironment: 'private', ownerEnvironmentSidecars: ['terminal'], networks: { web: 'instance' } };
  const d = grantDiff(base, next);
  assert.deepEqual(d.added, ['home-sidecar:terminal', 'home:private', 'network:web=instance', 'permission:b']);
  assert.deepEqual(d.removed, ['home:app', 'network:web=shared', 'permission:a']);
  assert.equal(grantDiff(base, base).changed, false);
  assert.ok(grantItems(base).includes('environment-scope:global'));
});

// ── data stays behind ───────────────────────────────────────────────────────

test('data stays behind: home and environment-scope changes are listed, never copied, ownership never changed silently', async () => {
  const pure = dataStaysBehind('X', { homeEnvironment: 'app', environmentScope: 'global' }, { homeEnvironment: 'private', environmentScope: 'user' });
  assert.deepEqual(pure.map((d) => d.kind), ['app-home', 'instance-data', 'environment']);
  assert.deepEqual(pure[1].ownership, { writtenAs: 'app', runsAs: 'user', migrated: false });
  const back = dataStaysBehind('X', { homeEnvironment: 'private', environmentScope: 'user' }, { homeEnvironment: 'app', environmentScope: 'user' });
  assert.deepEqual(back.map((d) => d.kind), ['private-home', 'instance-data']);
  assert.deepEqual(back[1].ownership, { writtenAs: 'user', runsAs: 'app', migrated: false });
  assert.deepEqual(dataStaysBehind('X', { homeEnvironment: 'app', environmentScope: 'global' }, { homeEnvironment: 'app', environmentScope: 'global' }), []);
  assert.deepEqual(dataStaysBehind('X', null, { homeEnvironment: 'private', environmentScope: 'user' }), [], 'a first setup leaves nothing behind');

  const w = await world(profiled([
    { id: 'g', title: 'Global', overlay: { environmentScope: 'global' } },
    { id: 'u', title: 'User', overlay: { environmentScope: 'user' } },
  ]));
  assert.equal((await w.svc.apply(w.appId, { profile: 'g' }, OWNER)).status, 'ready');
  const plan = await w.svc.changePlan(w.appId, { profile: 'u' });
  assert.deepEqual(plan.dataStaysBehind.map((d) => d.kind), ['environment']);
  assert.ok(plan.grantDiff.added.includes('environment-scope:user') && plan.grantDiff.removed.includes('environment-scope:global'));
  assert.equal((await w.svc.reconfigure(w.appId, { profile: 'u' }, OWNER)).status, 'ready');
});

// ── setup.version and other updates (§3.5) ──────────────────────────────────

const renamer = (setup) => AppManifestSchema.parse({ id: 'com.example.renamer', ...BASE, setup });

test('update: setup.version renames migrate the stored values; the new digest is validated to ready', async () => {
  const w = await world(renamer({ version: 1, fields: { host: { type: 'string', title: 'Host', required: true } } }));
  assert.equal((await w.svc.apply(w.appId, { values: { host: 'mail.example' } }, OWNER)).status, 'ready');
  const old = await w.summary();
  w.manifest = renamer({ version: 2, fields: { smtpHost: { type: 'string', title: 'SMTP host', required: true } }, renames: [{ since: 2, from: 'host', to: 'smtpHost' }] });
  assert.equal((await w.gate()).ok, false, 'the stale values never start');
  const o = await w.svc.onManifestChanged(w.appId);
  assert.equal(o.status, 'migrated', JSON.stringify(o.error));
  assert.deepEqual(o.renamed, [{ from: 'host', to: 'smtpHost' }]);
  const rec = await w.record();
  assert.deepEqual([rec.setupVersion, rec.values, rec.updatedBy], [2, { smtpHost: 'mail.example' }, 'kernel']);
  const s = await w.summary();
  assert.equal(s.state, 'ready');
  assert.notEqual(s.configDigest, old.configDigest);
  assert.equal((await w.gate()).ok, true);
  // Unchanged manifest: nothing to do.
  assert.equal((await w.svc.onManifestChanged(w.appId)).status, 'unchanged');
  // migrateDesired (pure): only renames in (stored, new]; never across records.
  const m = migrateDesired({ v: 1, setupVersion: 1, profile: null, values: { a: 1, b: 2 }, secrets: {}, overrides: {}, updatedAt: 'x', updatedBy: 'kernel' },
    { version: 3, renames: [{ since: 3, from: 'b', to: 'c' }, { since: 2, from: 'a', to: 'b' }] }, new Date(0).toISOString());
  assert.deepEqual(m.desired.values, { c: 2 }, 'in since order: a→b (b already held: kept, a dropped and named), then b→c');
  assert.deepEqual(m.conflicts, ['a→b']);
});

test('update: a new required field gives repair-required (stopped, gate refuses); the repair with the value → ready', async () => {
  const w = await world(renamer({ version: 1, fields: { host: { type: 'string', title: 'Host', required: true } } }));
  assert.equal((await w.svc.apply(w.appId, { values: { host: 'h' } }, OWNER)).status, 'ready');
  w.manifest = renamer({ version: 1, fields: { host: { type: 'string', title: 'Host', required: true }, port: { type: 'integer', title: 'Port', required: true } } });
  const o = await w.svc.onManifestChanged(w.appId);
  assert.deepEqual([o.status, o.error.error, o.error.fieldErrors], ['repair-required', 'config-invalid', { port: 'required' }]);
  assert.equal((await w.summary()).state, 'repair-required');
  assert.deepEqual(w.stopped, [w.appId]);
  const g = await w.gate();
  assert.deepEqual([g.ok, g.block.error], [false, 'repair-required']);
  const r = await w.svc.repair(w.appId, { values: { port: 25 } }, OWNER);
  assert.equal(r.status, 'ready', JSON.stringify(r.error));
  assert.equal((await w.gate()).ok, true);
});

test('update: a dropped profile gives repair-required "select a profile" (desired unchanged, never another profile picked)', async () => {
  const w = await world(profiled([{ id: 'a', title: 'A', overlay: {} }, { id: 'b', title: 'B', overlay: {} }]));
  assert.equal((await w.svc.apply(w.appId, { profile: 'a' }, OWNER)).status, 'ready');
  w.manifest = profiled([{ id: 'b', title: 'B', overlay: {} }]);
  const o = await w.svc.onManifestChanged(w.appId);
  assert.deepEqual([o.status, o.error.error, o.error.suggest], ['repair-required', 'profile-required', ['b']]);
  assert.match(o.error.message, /select a profile/);
  assert.equal((await w.record()).profile, 'a', 'nothing picked for the owner');
  assert.equal((await w.gate()).ok, false);
  assert.equal((await w.svc.reconfigure(w.appId, { profile: 'b' }, OWNER)).status, 'ready');
});

test('never ready with a new digest after a failed change: a version change that needs the app\'s migration hook fails closed', async () => {
  const hooked = (version) => mailer({ version, init: { hook: true, idempotent: true, timeoutSec: 5 } });
  const w = await world(hooked(1), { starter: fakeStarter({ onSetup: () => ({ ok: true }) }) });
  const h = await w.handle('SMTP_PASSWORD');
  await w.svc.apply(w.appId, { values: { smtpHost: 'h' }, secrets: { password: h } }, OWNER);
  await w.svc.settled();
  const old = await w.summary();
  assert.equal(old.state, 'ready');
  w.manifest = hooked(2);
  const o = await w.svc.onManifestChanged(w.appId);
  assert.deepEqual([o.status, o.error.error], ['repair-required', 'repair-required']);
  const s = await w.summary();
  assert.deepEqual([s.state, s.configDigest], ['repair-required', old.configDigest], 'the old digest stays; never ready with a new one');
  assert.equal((await w.record()).setupVersion, 1, 'nothing migrated without the hook');
  assert.equal((await w.gate()).ok, false);
});

// ── §5.5: user-scope values ─────────────────────────────────────────────────

test('user-scope values never become installation values (proposal, manifest scope change); shared refuses per-user secrets', async () => {
  const pure = compatibilityIssues({ to: { instanceScope: 'per-user' }, desired: { values: { nick: 'x' }, secrets: {} }, userDesired: null, scopes: { nick: 'user' } });
  assert.deepEqual([pure[0].error, pure[0].fieldErrors], ['config-invalid', { nick: 'a per-user value: never an installation value' }]);
  const shared = compatibilityIssues({ to: { instanceScope: 'shared' }, desired: null, userDesired: { values: {}, secrets: { token: 'cred_x' } }, scopes: { token: 'user' } });
  assert.deepEqual([shared[0].error, shared[0].missing], ['profile-unavailable', ['user-secret:token']]);
  assert.deepEqual(compatibilityIssues({ to: { instanceScope: 'per-user' }, desired: null, userDesired: { values: {}, secrets: { token: 'cred_x' } }, scopes: { token: 'user' } }), []);

  const nick = (scope) => AppManifestSchema.parse({ id: 'com.example.nick', ...BASE, setup: { version: 1, fields: { nick: { type: 'string', title: 'Nick', scope } } } });
  const w = await world(nick('user'));
  assert.equal((await w.svc.apply(w.appId, { values: { nick: 'me' } }, OWNER)).status, 'ready');
  assert.equal((await w.record()).values.nick, undefined, 'the user value is in the user record only');
  const user = async () => (await store.read({ installationId: w.installationId, userId: 'default' })).value;
  assert.equal((await user()).values.nick, 'me');
  w.manifest = nick('installation');
  const o = await w.svc.onManifestChanged(w.appId);
  assert.equal(o.status, 'repair-required');
  assert.equal((await w.record()).values.nick, undefined, 'never copied into the installation record');
  assert.equal((await user()).values.nick, 'me');
});

// ── decision 13: the last applied configuration ─────────────────────────────

test('restore-last: the last applied configuration is kept at ready and restored explicitly after a failed reconfiguration', async () => {
  let fail = false;
  const starter = fakeStarter({ onSetup: () => (fail ? { ok: false, message: 'broken' } : { ok: true }) });
  const w = await world(mailer({ init: { hook: true, idempotent: true, timeoutSec: 5 } }), { starter });
  const h = await w.handle('SMTP_PASSWORD');
  await w.svc.apply(w.appId, { values: { smtpHost: 'one' }, secrets: { password: h } }, OWNER);
  await w.svc.settled();
  const old = await w.summary();
  const last = await w.svc.lastApplied(w.appId);
  assert.deepEqual([last.current, last.values.smtpHost, last.configDigest, last.notice], [true, 'one', old.configDigest, RESTORE_NOTICE]);
  assert.deepEqual(last.secretFields, ['password', 'sessionKey'], 'secret names only');
  assert.ok(!JSON.stringify(last).includes('pw-from-the-owner'));

  fail = true;
  await w.svc.reconfigure(w.appId, { values: { smtpHost: 'two' } }, OWNER);
  await w.svc.settled();
  assert.equal((await w.summary()).state, 'setup-failed', 'no automatic restore');
  assert.equal((await w.svc.lastApplied(w.appId)).values.smtpHost, 'one', 'the failed run did not replace it');

  fail = false;
  const r = await w.svc.restoreLast(w.appId, OWNER);
  assert.equal(r.notice, RESTORE_NOTICE);
  await w.svc.settled();
  const s = await w.summary();
  assert.deepEqual([s.state, s.configDigest], ['ready', old.configDigest]);
  assert.equal((await w.record()).values.smtpHost, 'one');
  assert.equal((await w.svc.restoreLast(w.appId, OWNER)).status, 'unchanged');
});

test('restore-last revalidates: a revoked grant asks for approval again, never ready; nothing to restore → refused', async () => {
  const m = profiled([{ id: 'p', title: 'P', overlay: { permissions: ['priv.mount'] } }]);
  const w = await world(m, { grants: ['permission:priv.mount'] });
  const none = await w.svc.restoreLast(w.appId, OWNER);
  assert.deepEqual([none.status, none.error.error], ['refused', 'setup-required']);
  assert.equal((await w.svc.apply(w.appId, { profile: 'p' }, OWNER)).status, 'ready');
  w.held.delete('permission:priv.mount');
  await w.svc.recheck(w.appId);
  assert.equal((await w.summary()).state, 'blocked');
  const r = await w.svc.restoreLast(w.appId, OWNER);
  assert.equal(r.status, 'on-hold', JSON.stringify(r.error));
  assert.notEqual((await w.summary()).state, 'ready');
  assert.equal((await w.gate()).ok, false);
});

test('the applied snapshot is sealed, handles only, deleted with the installation', async () => {
  const d = { v: 1, setupVersion: 1, profile: null, values: {}, secrets: { pw: 'plaintext' }, overrides: {}, updatedAt: new Date(0).toISOString(), updatedBy: 'kernel' };
  const digest = `sha256:${'0'.repeat(64)}`;
  assert.equal(parseAppliedSnapshot({ v: 1, desired: d, userDesired: null, userId: 'default', profile: null, configDigest: digest, grantDigest: digest, appliedAt: new Date(0).toISOString() }), null);
  const w = await world(AppManifestSchema.parse({ id: 'com.example.plainset', ...BASE, setup: { version: 1, fields: { g: { type: 'string', title: 'G', default: 'x' } } } }));
  assert.equal((await w.svc.apply(w.appId, {}, OWNER)).status, 'ready');
  assert.ok(await store.readApplied(w.installationId));
  await redis.set(`app:config:${w.installationId}:applied`, JSON.stringify({ forged: true }));
  assert.equal(await store.readApplied(w.installationId), null, 'a forged snapshot is never restored');
  assert.equal((await w.svc.apply(w.appId, { values: { g: 'y' } }, OWNER)).status, 'ready');
  assert.ok(await store.readApplied(w.installationId));
  await store.forgetInstallation(w.installationId, 'default');
  assert.equal(await redis.get(`app:config:${w.installationId}:applied`), null);
});

// ── the user's own Private Home revocation ──────────────────────────────────

test('revokeHomePrivate: the user revokes their own Private Home grant → blocked (stopped, torn down), desired stays private', async () => {
  const home = {
    granted: [],
    async homePrivateAuthorized(q) { return this.granted.some((g) => g.sidecar === (q.sidecar ?? '')); },
    async grantHomePrivate(g) { this.granted.push({ sidecar: '' }); for (const s of g.sidecars) this.granted.push({ sidecar: s }); },
    async privateHomeTeardown(t) { this.teardown = t; },
  };
  const m = profiled([{ id: 'private', title: 'Private', overlay: { homeEnvironment: 'private' } }], { homeEnvironments: { supported: ['app', 'private'] } });
  const w = await world(m, { home });
  w.deps.resolverPorts = ((orig) => async (q) => { const p = await orig(q); return { ...p, isAuthorized: (r) => (r.kind === 'home-private' ? home.granted.length > 0 : p.isAuthorized(r)) }; })(w.deps.resolverPorts);
  const perm = (g) => (g.sidecar ? `home.private.sidecar:${g.sidecar}` : 'home.private');
  const calls = [];
  w.deps.grants.homePrivateHeld = async ({ userId }) => (userId === 'default' ? home.granted.map(perm) : []);
  w.deps.grants.revokeHomePrivate = async ({ userId, permission }) => {
    calls.push([userId, permission]);
    const i = home.granted.findIndex((g) => perm(g) === permission);
    if (userId !== 'default' || i < 0) return false;
    home.granted.splice(i, 1);
    return true;
  };
  const r = await w.svc.apply(w.appId, { profile: 'private' }, OWNER);
  await approvals.approve(r.approvalId, OPERATOR);
  assert.equal((await w.svc.resume(w.appId, OWNER)).status, 'ready');
  assert.deepEqual(await w.svc.homePrivateGrants(w.appId, OWNER), [{ permission: 'home.private' }]);
  assert.deepEqual(await w.svc.homePrivateGrants(w.appId, { kind: 'user', userId: 'someone' }), [], 'only the acting user\'s own grants');

  const out = await w.svc.revokeHomePrivate(w.appId, TERMINAL);
  assert.deepEqual(out.revoked, ['home.private']);
  assert.deepEqual(calls, [['default', 'home.private']], 'in the acting user\'s own scope');
  assert.equal(out.state.state, 'blocked');
  assert.deepEqual(w.stopped, [w.appId]);
  assert.equal(home.teardown?.appId, w.appId);
  assert.equal((await w.record()).profile, 'private', 'never switched to the App Home');
  assert.ok(w.audits.some((a) => a.action === 'home.private.revoked' && a.detail.cause === 'user'));
  assert.deepEqual((await w.svc.revokeHomePrivate(w.appId, OWNER)).revoked, [], 'idempotent');

  delete w.deps.grants.revokeHomePrivate;
  await assert.rejects(w.svc.revokeHomePrivate(w.appId, OWNER), (e) => e.code === 'setup-blocked');
  await assert.rejects(w.svc.revokeHomePrivate(w.appId, OWNER, { sidecar: 'Bad Name' }), (e) => e.code === 'setup-blocked' || e.code === 'config-invalid');
});
