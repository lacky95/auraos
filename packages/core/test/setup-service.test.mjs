// D108 P3: the setup engine (SetupService) against a REAL valkey-server: P2's sealed
// store and state machine, the App Host registry, D102 approvals (ValkeyApprovalStore),
// the vault on an in-memory Context KV; resolver ports, grants, home and the
// maintenance start are fakes.
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
  setupApprovalItems, askSecretName,
} from '../dist/index.js';

const ROOT = mkdtempSync(join(tmpdir(), 'aura-setup-service-'));
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

// ── simple apps: unchanged ──────────────────────────────────────────────────

test('binding: an app without setup/profiles reads nothing, writes nothing, passes the gate', async () => {
  const w = await world(simple());
  let reads = 0;
  w.deps.installation = async () => { reads++; return { installationId: w.installationId }; };
  const gate = await w.svc.check(w.appId, w.manifest, { installationId: w.installationId });
  assert.deepEqual(gate, { ok: true, effective: null });
  assert.equal(reads, 0, 'the gate reads nothing for a simple app');
  assert.equal((await w.svc.apply(w.appId, {}, OWNER)).status, 'unchanged');
  const st = await w.svc.state(w.appId);
  assert.deepEqual([st.declares, st.state], [false, 'ready']);
  assert.equal(await w.summary(), null, 'no summary');
  assert.equal(await w.record(), null, 'no record');
  assert.deepEqual((await w.svc.plan(w.appId)).steps.filter((s) => s.status !== 'skipped').map((s) => s.step), ['done']);
});

// ── setup-only flow ─────────────────────────────────────────────────────────

test('setup-only: refused proposals write nothing; a valid one generates its secret and reaches ready (no approval, no hooks)', async () => {
  const w = await world(mailer());
  const before = await w.gate();
  assert.equal(before.ok, false);
  assert.deepEqual([before.block.error, before.block.category, before.block.details.state, before.block.state], ['setup-required', 'needs-setup', 'setup-required', 'setup-required']);

  const plan = await w.svc.plan(w.appId);
  assert.deepEqual(plan.fields.map((f) => f.name).sort(), ['password', 'sessionKey', 'smtpHost', 'smtpPort']);
  assert.equal(plan.approval, null, 'a setup-only app adds no privilege');
  assert.equal(plan.steps.find((s) => s.step === 'profile').status, 'skipped');
  assert.equal(plan.steps.find((s) => s.step === 'init').status, 'skipped');

  const bad = await w.svc.apply(w.appId, { values: { smtpPort: 99999 } }, OWNER);
  assert.equal(bad.status, 'refused');
  assert.equal(bad.error.error, 'config-invalid');
  assert.ok(bad.error.fieldErrors.smtpPort && bad.error.fieldErrors.smtpHost && bad.error.fieldErrors.password);
  assert.equal(await w.summary(), null, 'a refused proposal writes no summary');
  assert.equal(await w.record(), null, 'and no record');

  const handle = await w.handle('SMTP_PASSWORD');
  const ok = await w.svc.apply(w.appId, { values: { smtpHost: 'mail.example' }, secrets: { password: handle } }, OWNER);
  assert.equal(ok.status, 'ready', JSON.stringify(ok.error));
  const rec = await w.record();
  assert.match(rec.secrets.sessionKey, /^cred_/, 'the generated secret is a handle');
  assert.equal(rec.secrets.password, handle);
  assert.equal(rec.updatedBy, 'kernel', 'generated secrets are stored by the kernel');
  const s = await w.summary();
  assert.equal(s.state, 'ready');
  const gate = await w.gate();
  assert.equal(gate.ok, true);
  assert.equal(gate.effective.configDigest, s.configDigest);
  assert.deepEqual(gate.effective.values, { smtpHost: 'mail.example', smtpPort: 587 });
  // The app's own view: handles only.
  const self = await w.svc.selfConfig({ appId: w.appId, instanceId: `${w.appId}-1` });
  assert.deepEqual(Object.keys(self.secrets).sort(), ['password', 'sessionKey']);
  // The second open: nothing to do.
  assert.equal((await w.svc.apply(w.appId, {}, OWNER)).status, 'unchanged');
  assert.deepEqual(w.events.map((e) => e.state), ['configuring', 'initializing', 'ready']);
});

test('secrets appear nowhere: not in records, summaries, digests, outcomes, events or audit', async () => {
  const w = await world(mailer());
  const typed = `typed-${randomUUID()}`;
  const handle = await w.handle('SMTP_PASSWORD', typed);
  const out = await w.svc.apply(w.appId, { values: { smtpHost: 'h' }, secrets: { password: handle } }, OWNER);
  const rec = await w.record();
  const generated = await w.vault.reveal('default', (await w.vault.resolve('default', rec.secrets.sessionKey)).name, w.appId);
  assert.ok(generated && generated.length === 32);
  const dump = [];
  for (const k of await redis.keys('*')) {
    const t = await redis.type(k);
    if (t === 'string') dump.push(await redis.get(k));
    else if (t === 'hash') dump.push(JSON.stringify(await redis.hgetall(k)));
  }
  const all = JSON.stringify([dump, out, w.events, w.audits, await w.svc.values(w.appId), await w.svc.plan(w.appId), await w.svc.state(w.appId)]);
  for (const secret of [typed, generated]) assert.equal(all.includes(secret), false, 'a secret value leaked');
});

test('setValues: plain values need no approval; a change of the privilege-bearing part is refused there', async () => {
  const w = await world(profiled([
    { id: 'plain', title: 'Plain', overlay: {} },
    { id: 'more', title: 'More', overlay: { permissions: ['priv.extra'] } },
  ], { setup: { version: 1, fields: { greeting: { type: 'string', title: 'Greeting', default: 'hi' } } } }));
  assert.equal((await w.svc.apply(w.appId, { profile: 'plain' }, OWNER)).status, 'ready');
  const digest = (await w.summary()).configDigest;
  const v = await w.svc.setValues(w.appId, { values: { greeting: 'hello' } }, OWNER);
  assert.equal(v.status, 'ready');
  assert.notEqual((await w.summary()).configDigest, digest);
  const p = await w.svc.setValues(w.appId, { profile: 'more' }, OWNER);
  assert.deepEqual([p.status, p.error.error], ['refused', 'setup-blocked']);
  assert.equal((await w.summary()).state, 'ready', 'nothing changed');
});

// ── decision 3: profile selection ───────────────────────────────────────────

test('decision 3: exactly one feasible input-free profile is selected; otherwise profile-required, never a pick', async () => {
  const one = await world(profiled([
    { id: 'isolated', title: 'Isolated', overlay: { services: {} }, setup: { requirements: [{ feature: 'network.isolation', level: 'required' }] } },
    { id: 'plain', title: 'Plain', overlay: {} },
  ]), { features: { 'network.isolation': 'unsupported' } });
  const a = await one.svc.apply(one.appId, {}, OWNER);
  assert.equal(a.status, 'ready');
  assert.equal((await one.record()).profile, 'plain', 'the only feasible input-free profile');

  const two = await world(profiled([
    { id: 'a', title: 'A', overlay: {}, recommended: true },
    { id: 'b', title: 'B', overlay: {} },
  ], { id: 'com.example.two' }));
  const r = await two.svc.apply(two.appId, {}, TERMINAL);
  assert.deepEqual([r.status, r.error.error], ['refused', 'profile-required']);
  assert.equal(await two.record(), null, 'nothing picked, nothing written (not even the recommended one)');
});

// ── approvals ───────────────────────────────────────────────────────────────

const toolsProfiles = () => profiled([
  { id: 'power', title: 'Power', overlay: { permissions: ['priv.mount', 'plain.read'], tools: ['git'], context: ['API_KEY'] } },
]);

test('app.setup.apply: requested by the Terminal, on hold, never duplicated, grants only after approval, then ready', async () => {
  const w = await world(toolsProfiles());
  const r = await w.svc.apply(w.appId, { profile: 'power' }, TERMINAL);
  assert.equal(r.status, 'on-hold', JSON.stringify(r.error));
  const rec = await approvals.get(r.approvalId);
  assert.deepEqual(rec.requester, { kind: 'instance', appId: 'com.aura.terminal', instanceId: TERMINAL.instanceId, userId: 'default' });
  assert.equal(rec.action, 'app.setup.apply');
  assert.equal(rec.class, 'deferrable');
  assert.deepEqual(rec.payload.adds, { permissions: ['plain.read', 'priv.mount'], tools: ['git'], context: ['API_KEY'], homePrivate: false, homePrivateSidecars: [] });
  assert.equal(rec.payloadHash, payloadHash(rec.payload));
  assert.equal(rec.payload.configDigest, (await w.svc.plan(w.appId)).configDigest, 'bound to the digests');
  assert.ok(rec.display.title.includes('Mailer'));
  assert.deepEqual(w.granted, [], 'requests never grant before the approval');
  assert.equal((await w.summary()).state, 'awaiting-approval');
  assert.equal((await w.gate()).block.error, 'setup-required');

  // Resume while pending (and after a restart): the same request, no duplicate.
  assert.equal((await w.svc.resume(w.appId, TERMINAL)).approvalId, r.approvalId);
  assert.equal((await w.restart().resume(w.appId, TERMINAL)).approvalId, r.approvalId);
  assert.equal((await approvals.listPending()).length, 1);

  assert.equal((await approvals.approve(r.approvalId, OPERATOR)).ok, true);
  const done = await w.svc.resume(w.appId, TERMINAL);
  assert.equal(done.status, 'ready', JSON.stringify(done.error));
  assert.deepEqual(w.granted.map((g) => g.slice(0, 2)), [['permission', 'priv.mount'], ['context', 'API_KEY']], 'grantable parts become ordinary grants');
  assert.equal((await approvals.get(r.approvalId)).state, 'consumed');
  assert.equal((await w.gate()).ok, true);
  // After a restart the approved digest still authorizes the non-grantable requests (plain permission, tool).
  assert.equal((await w.restart().check(w.appId, w.manifest, { installationId: w.installationId })).ok, true);
});

test('denial → setup-failed (approval-denied), never ready', async () => {
  const w = await world(toolsProfiles());
  const r = await w.svc.apply(w.appId, { profile: 'power' }, OWNER);
  await approvals.deny(r.approvalId, OPERATOR, 'not now');
  const out = await w.svc.resume(w.appId, OWNER);
  assert.deepEqual([out.status, out.error.error, out.error.category], ['refused', 'approval-denied', 'needs-approval']);
  assert.match(out.error.message, /The owner says: "not now"/);
  assert.equal((await w.summary()).state, 'setup-failed');
  assert.equal((await w.gate()).ok, false);
  assert.deepEqual(w.granted, []);
});

test('revalidation: an approval for another configuration is not used; a new one is asked', async () => {
  const w = await world(profiled([
    { id: 'p1', title: 'One', overlay: { permissions: ['priv.mount'] } },
    { id: 'p2', title: 'Two', overlay: { permissions: ['priv.port'] } },
  ]));
  const r1 = await w.svc.apply(w.appId, { profile: 'p1' }, OWNER);
  await approvals.approve(r1.approvalId, OPERATOR);
  // The desired record changes behind the run (another client): the approved payload no longer matches.
  await store.update({ installationId: w.installationId }, (c) => ({ ...c, profile: 'p2', updatedAt: new Date().toISOString() }));
  const r2 = await w.svc.resume(w.appId, OWNER);
  assert.equal(r2.status, 'on-hold');
  assert.notEqual(r2.approvalId, r1.approvalId);
  assert.equal((await approvals.get(r1.approvalId)).state, 'cancelled');
  assert.deepEqual(w.granted, [], 'the stale approval granted nothing');
});

test('a Private Home: forced, password; granted through the home port; without the port it fails closed', async () => {
  const home = {
    granted: [],
    async homePrivateAuthorized(q) { return this.granted.some((g) => g.sidecar === (q.sidecar ?? '')); },
    async grantHomePrivate(g) { this.granted.push({ sidecar: '' }); for (const s of g.sidecars) this.granted.push({ sidecar: s }); },
    async privateHomeTeardown(t) { this.teardown = t; },
  };
  const m = profiled([{ id: 'private', title: 'Private', overlay: { homeEnvironment: 'private' } }], { homeEnvironments: { supported: ['app', 'private'] } });
  const w = await world(m, { home });
  // isAuthorized for home-private goes through the fake's grants via `held`
  w.deps.resolverPorts = ((orig) => async (q) => { const p = await orig(q); return { ...p, isAuthorized: (r) => (r.kind === 'home-private' ? home.granted.length > 0 : p.isAuthorized(r)) }; })(w.deps.resolverPorts);
  const r = await w.svc.apply(w.appId, { profile: 'private' }, OWNER);
  assert.equal(r.status, 'on-hold', JSON.stringify(r.error));
  const rec = await approvals.get(r.approvalId);
  assert.deepEqual([rec.class, rec.level, rec.payload.adds.homePrivate], ['forced', 'fresh', true]);
  assert.equal(rec.display.highRisk[0].item, 'Private Home');
  await approvals.approve(r.approvalId, OPERATOR);
  assert.equal((await w.svc.resume(w.appId, OWNER)).status, 'ready');
  assert.equal(home.granted.length, 1);

  // Revocation: blocked, stopped, the desired home stays private; re-authorization: ready, no values asked.
  const digest = (await w.summary()).configDigest;
  home.granted = [];
  await w.svc.recheck(w.appId);
  assert.equal((await w.summary()).state, 'blocked');
  assert.deepEqual(w.stopped, [w.appId]);
  assert.equal(home.teardown?.appId, w.appId, 'the private sessions are torn down (P9)');
  assert.equal((await w.record()).profile, 'private', 'desired unchanged: never the App Home');
  const g = await w.gate();
  assert.deepEqual([g.ok, g.block.error, g.block.category], [false, 'setup-blocked', 'needs-setup']);
  home.granted = [{ sidecar: '' }];
  await w.svc.recheck(w.appId);
  const s = await w.summary();
  assert.deepEqual([s.state, s.configDigest], ['ready', digest]);

  const noPort = await world(AppManifestSchema.parse({ ...m, id: 'com.example.noport' }));
  const n = await noPort.svc.apply(noPort.appId, { profile: 'private' }, OWNER);
  assert.equal(n.status, 'on-hold');
  await approvals.approve(n.approvalId, OPERATOR);
  const nr = await noPort.svc.resume(noPort.appId, OWNER);
  assert.equal(nr.status, 'refused');
  assert.notEqual((await noPort.summary()).state, 'ready');
});

// ── blocked by a revoked grant, a policy, a lost feature ────────────────────

test('blocked: a revoked grant, a D64 policy off, a lost feature; re-authorized → ready without new values', async () => {
  const m = profiled([{ id: 'p', title: 'P', overlay: { permissions: ['priv.mount'] }, setup: { requirements: [{ feature: 'resources.limits', level: 'required' }] } }]);
  const w = await world(m, { grants: ['permission:priv.mount'] });
  assert.equal((await w.svc.apply(w.appId, { profile: 'p' }, OWNER)).status, 'ready');
  const digest = (await w.summary()).configDigest;
  for (const [lose, restore] of [
    [() => w.held.delete('permission:priv.mount'), () => w.held.add('permission:priv.mount')],
    [() => { w.features['resources.limits'] = 'unsupported'; }, () => { w.features['resources.limits'] = 'supported'; }],
  ]) {
    w.stopped.length = 0;
    lose();
    await w.svc.recheck(w.appId);
    assert.equal((await w.summary()).state, 'blocked');
    assert.deepEqual(w.stopped, [w.appId], 'workloads stopped');
    assert.equal((await w.gate()).ok, false);
    restore();
    await w.svc.recheck(w.appId);
    const s = await w.summary();
    assert.deepEqual([s.state, s.configDigest], ['ready', digest]);
  }
  assert.ok(w.audits.some((a) => a.action === 'app.setup.blocked'));
});

test('blockingDecision: only lost authorizations, policies or features block; a plain config error is a repair', () => {
  const summary = { state: 'ready', configDigest: 'd', grantDigest: 'g' };
  const r = (blocking, effective = null) => ({ blocking, effective, requested: { homeEnvironment: 'app' }, configDigest: 'd', grantDigest: 'g' });
  assert.equal(blockingDecision(summary, r([{ error: 'config-invalid', message: 'x' }])).kind, 'none');
  const b = blockingDecision(summary, r([{ error: 'policy-refused', message: 'off', policy: 'app-private-home' }]));
  assert.deepEqual([b.kind, b.error.error, b.error.policy], ['block', 'setup-blocked', 'app-private-home']);
  assert.equal(blockingDecision({ ...summary, state: 'blocked' }, r([], { configDigest: 'd' })).kind, 'unblock');
  assert.equal(blockingDecision({ ...summary, state: 'blocked', configDigest: 'other' }, r([], {})).kind, 'none');
});

// ── hooks and init ──────────────────────────────────────────────────────────

const hooked = (over = {}) => mailer({ init: { hook: true, idempotent: true, timeoutSec: 5 }, readiness: { hook: true }, ...over });

test('a hook-bearing app without the maintenance start fails closed (setup-failed, never ready)', async () => {
  const w = await world(hooked());
  const h = await w.handle('SMTP_PASSWORD');
  const r = await w.svc.apply(w.appId, { values: { smtpHost: 'h' }, secrets: { password: h } }, OWNER);
  assert.equal(r.status, 'initializing');
  await w.svc.settled();
  const s = await w.summary();
  assert.deepEqual([s.state, s.error.error, s.error.hint], ['setup-failed', 'setup-failed', NO_MAINTENANCE_HINT]);
  assert.equal((await w.gate()).ok, false);
});

test('onSetup + onValidate in a setup maintenance start → ready; the gate lets only that start through while initializing', async () => {
  let seen = null;
  let release;
  const held = new Promise((r) => { release = r; });
  const starter = fakeStarter({ onSetup: async (b) => { seen = b; await held; return { ok: true }; }, onValidate: () => ({ ok: true }) });
  const w = await world(hooked(), { starter });
  const h = await w.handle('SMTP_PASSWORD');
  const r = await w.svc.apply(w.appId, { values: { smtpHost: 'h' }, secrets: { password: h } }, OWNER);
  assert.equal(r.status, 'initializing');
  // While initializing: a normal start is refused, the engine's own maintenance start passes.
  const normal = await w.gate();
  const maint = await w.svc.check(w.appId, w.manifest, { installationId: w.installationId, maintenance: 'setup' });
  release();
  await w.svc.settled();
  assert.equal(normal.ok, false);
  assert.equal(maint.ok, true);
  assert.deepEqual(starter.calls.map((c) => c[0]), ['start', 'onSetup', 'onValidate', 'finish']);
  assert.deepEqual([seen.reason, seen.attempt, seen.previousDigest], ['setup', 1, null]);
  assert.equal(seen.configDigest, (await w.summary()).configDigest);
  assert.equal((await w.summary()).state, 'ready');
});

test('a failing hook or validation: setup-failed with the app\'s words; a failed reconfiguration keeps the old ready digest', async () => {
  let fail = false;
  const starter = fakeStarter({
    onSetup: () => (fail ? { ok: false, message: 'cannot reach\nthe SMTP server' } : { ok: true }),
    onValidate: () => ({ ok: true }),
  });
  const w = await world(hooked(), { starter });
  const h = await w.handle('SMTP_PASSWORD');
  await w.svc.apply(w.appId, { values: { smtpHost: 'h' }, secrets: { password: h } }, OWNER);
  await w.svc.settled();
  const old = await w.summary();
  assert.equal(old.state, 'ready');
  fail = true;
  await w.svc.reconfigure(w.appId, { values: { smtpHost: 'other' } }, OWNER);
  await w.svc.settled();
  const s = await w.summary();
  assert.deepEqual([s.state, s.error.error], ['setup-failed', 'hook-failed']);
  assert.match(s.error.message, /The app says: "cannot reach the SMTP server"/);
  assert.equal(s.configDigest, old.configDigest, 'the summary keeps the last ready digest, never the new one');
  assert.equal((await w.gate()).ok, false);

  const v = await world(hooked({}), { starter: fakeStarter({ onSetup: () => ({ ok: true }), onValidate: () => ({ ok: false, fieldErrors: { smtpHost: 'unknown host' } }) }) });
  v.manifest = AppManifestSchema.parse({ ...v.manifest });
  const vh = await v.handle('SMTP_PASSWORD');
  await v.svc.apply(v.appId, { values: { smtpHost: 'h' }, secrets: { password: vh } }, OWNER);
  await v.svc.settled();
  const vs = await v.summary();
  assert.deepEqual([vs.state, vs.error.fieldErrors], ['setup-failed', { smtpHost: 'unknown host' }]);
});

test('kernel restart during initializing: retried idempotently with the next attempt, then setup-failed after the limit', async () => {
  const seen = [];
  const starter = fakeStarter({ onSetup: (b) => { seen.push(b); return { ok: true }; }, onValidate: () => ({ ok: true }) });
  const w = await world(hooked(), { starter: null });
  const h = await w.handle('SMTP_PASSWORD');
  // The run reaches initializing, then the kernel dies (no maintenance start yet in this world).
  await w.svc.apply(w.appId, { values: { smtpHost: 'h' }, secrets: { password: h } }, OWNER);
  await w.svc.settled();
  // Put it back to initializing as a killed kernel leaves it.
  let s = await w.summary();
  s = await machine.transition(w.installationId, s, 'configuring');
  s = await machine.transition(w.installationId, s, 'initializing', { attempt: 1, step: 'init' });
  w.starter = starter;
  const svc = w.restart();
  await svc.recover();
  await svc.settled();
  assert.equal((await w.summary()).state, 'ready');
  assert.deepEqual(seen.map((b) => b.attempt), [2], 'one retry, the next attempt, same digest');

  s = await w.summary();
  s = await machine.transition(w.installationId, s, 'configuring');
  s = await machine.transition(w.installationId, s, 'initializing', { attempt: MAX_INIT_ATTEMPTS, step: 'init' });
  const again = w.restart();
  await again.recover();
  await again.settled();
  assert.equal((await w.summary()).state, 'setup-failed');
});

test('resume at configuring continues the recorded run', async () => {
  const w = await world(mailer());
  const h = await w.handle('SMTP_PASSWORD');
  let s = await machine.begin(w.installationId, w.manifest);
  s = await machine.transition(w.installationId, s, 'configuring', { step: 'values' });
  await store.update({ installationId: w.installationId }, () => ({
    v: 1, setupVersion: 1, profile: null, values: { smtpHost: 'h' }, secrets: { password: h }, overrides: {}, updatedAt: new Date().toISOString(), updatedBy: 'user:default',
  }));
  const r = await w.restart().resume(w.appId, OWNER);
  assert.equal(r.status, 'ready', JSON.stringify(r.error));
});

test('the gate refuses a ready app whose resolved digest changed (repair-required), and every non-ready state', async () => {
  const w = await world(mailer());
  const h = await w.handle('SMTP_PASSWORD');
  await w.svc.apply(w.appId, { values: { smtpHost: 'h' }, secrets: { password: h } }, OWNER);
  assert.equal((await w.gate()).ok, true);
  w.manifest = mailer({ fields: { ...w.manifest.setup.fields, extra: { type: 'string', title: 'Extra', default: 'x' } } });
  const g = await w.gate();
  assert.deepEqual([g.ok, g.block.error, g.block.category], [false, 'repair-required', 'needs-setup']);
  assert.equal(w.svc.knownBlock(w.appId).error, 'repair-required', 'the supervisor skip knows it');
});

// ── secrets (D56) ───────────────────────────────────────────────────────────

test('askSecret: a credential.store request for the app, never a value; only a secret field', async () => {
  const w = await world(mailer());
  const { approvalId } = await w.svc.askSecret(w.appId, 'password', TERMINAL);
  const rec = await approvals.get(approvalId);
  assert.equal(rec.action, 'credential.store');
  assert.deepEqual(rec.payload, { name: askSecretName(w.appId, 'password'), for: w.appId });
  await assert.rejects(w.svc.askSecret(w.appId, 'smtpHost', TERMINAL), (e) => e.code === 'config-invalid');
  // The owner stored it under that name (the shell's dialog): the engine binds the handle.
  await w.vault.store('default', askSecretName(w.appId, 'password'), 'typed', { consumer: w.appId });
  const m = mailer({ fields: { ...mailer().setup.fields, password: { type: 'secret', title: 'SMTP password', required: true, secret: { source: 'ask' } } } });
  w.manifest = m;
  const r = await w.svc.apply(w.appId, { values: { smtpHost: 'h' } }, OWNER);
  assert.equal(r.status, 'ready', JSON.stringify(r.error));
  assert.match((await w.record()).secrets.password, /^cred_/);
  const handles = await w.svc.secretHandles(w.appId, OWNER);
  assert.ok(handles.every((x) => /^cred_/.test(x.handle)) && handles.length === 1, 'generated secrets are not offered');
});

test('approval wording: one item per added privilege, high-risk first', () => {
  const items = setupApprovalItems({ adds: { permissions: ['apps.mount', 'plain'], tools: ['docker'], context: ['K'], homePrivate: true, homePrivateSidecars: ['terminal'] } });
  assert.deepEqual(items.filter((i) => i.highRisk).map((i) => i.key), ['home:private', 'home-sidecar:terminal', 'tool:docker', 'permission:apps.mount', 'context:K']);
  assert.deepEqual(items.filter((i) => !i.highRisk).map((i) => i.key), ['permission:plain']);
});
