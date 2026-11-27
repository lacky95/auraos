// D108 P2: the desired-configuration records (sealed, CAS, per installation
// and per user), the operational state machine over the installation summary,
// and the retire/keep/clone behaviour, against a REAL valkey-server (KvServer
// on a tmp dataDir).
//
//   node tools/run-tests.mjs --only=packages/core
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KvServer, createRedis, isValidNamespace } from '@aura/kv-store';
import { createAppHostRegistry } from '../dist/app-hosts/AppHostRegistry.js';
import { AppHostLifecycle } from '../dist/app-hosts/lifecycle.js';
import {
  CredentialVault, OPERATIONAL_STATES, OPERATIONAL_TRANSITIONS, SETUP_AUDIT_ACTIONS, configRecordKey,
  SetupConfigStore, SetupStateMachine, SetupStateError, SetupStoreError, canTransition, deriveSetupState,
  parseDesiredConfig, tamperAuditInput, vaultHandleRevoker,
} from '../dist/index.js';

const ROOT = mkdtempSync(join(tmpdir(), 'aura-setup-store-'));
const KEY_FILE = join(ROOT, 'identity.key');
const server = new KvServer();
let redis;
let registry;
let tampered;
let store;
let machine;

const SRC = { kind: 'oci', ref: 'reg.example/apps/mailer:1.0.0' };
const SETUP_MANIFEST = { setup: { version: 1, fields: {} } };
const SIMPLE_MANIFEST = { id: 'com.example.simple' };
const D1 = `sha256:${'a'.repeat(64)}`;
const G1 = `sha256:${'b'.repeat(64)}`;
const D2 = `sha256:${'c'.repeat(64)}`;

// The vault on an in-memory Context KV (as credential-vault.test.mjs does).
function memoryKv() {
  const m = new Map();
  return {
    m,
    kv: () => ({
      async get(ns, key) { return m.get(`${ns}|${key}`) ?? null; },
      async set(ns, key, value) { assert.ok(isValidNamespace(ns), ns); const e = { value: JSON.parse(JSON.stringify(value)), updatedAt: 1 }; m.set(`${ns}|${key}`, e); return e; },
      async del(ns, key) { return m.delete(`${ns}|${key}`); },
      async list(ns) { return [...m.keys()].filter((k) => k.startsWith(`${ns}|`)).map((k) => k.slice(ns.length + 1)); },
    }),
  };
}

const desired = (over = {}) => ({
  v: 1, setupVersion: 1, profile: null, values: { smtpHost: 'mail.example', smtpPort: 587 }, secrets: {},
  overrides: {}, updatedAt: new Date(1000).toISOString(), updatedBy: 'user:default', ...over,
});
const newInstall = (appId = 'com.example.mailer', over = {}) => registry.createInstallation({ appId, originId: randomUUID(), scope: 'user', source: SRC, ...over });

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
  tampered = [];
  store = new SetupConfigStore({ identityKeyFile: KEY_FILE, redis: () => redis, onTampered: (ref) => tampered.push(ref) });
  machine = new SetupStateMachine({ registry, store });
});

// ── key layout ──────────────────────────────────────────────────────────────

test('app:config:* cannot be reached through any KvClient namespace', () => {
  for (const ns of ['app', 'app:config', 'app:config:x']) assert.equal(isValidNamespace(ns), false, ns);
  // A per-app bucket key is `app/<id>:<key>` (slash), a context key `context:…`, an os key `os:<key>` (no colon in <key>).
  assert.equal(configRecordKey('i1'), 'app:config:i1');
  assert.equal(configRecordKey('i1', 'default'), 'app:config:i1:u:default');
  assert.ok(!configRecordKey('i1').startsWith('app/') && !configRecordKey('i1').startsWith('apphost:'));
});

// ── seal, verify, tamper ────────────────────────────────────────────────────

test('a record is sealed: read back verified; tampering reads as absent, reported once', async () => {
  const id = randomUUID();
  assert.equal(await store.compareAndSet({ installationId: id }, null, desired()), true);
  const r = await store.read({ installationId: id });
  assert.deepEqual(r.value, desired());
  assert.equal(r.tampered, false);

  const raw = JSON.parse(await redis.get(configRecordKey(id)));
  raw.values.values.smtpHost = 'evil.example';
  await redis.set(configRecordKey(id), JSON.stringify(raw));
  for (let i = 0; i < 3; i++) {
    const t = await store.read({ installationId: id });
    assert.equal(t.value, null);
    assert.equal(t.tampered, true);
  }
  assert.deepEqual(tampered, [{ installationId: id }], 'reported once per stored record');
  await redis.set(configRecordKey(id), 'not json');
  await store.read({ installationId: id });
  assert.equal(tampered.length, 2, 'new bad bytes are reported again');
});

test('a record copied to another installation or user, or sealed with another key, does not verify', async () => {
  const a = randomUUID();
  const b = randomUUID();
  await store.compareAndSet({ installationId: a }, null, desired());
  await redis.set(configRecordKey(b), await redis.get(configRecordKey(a)));
  assert.equal((await store.read({ installationId: b })).tampered, true);
  await store.compareAndSet({ installationId: a, userId: 'default' }, null, desired({ values: { theme: 'dark' } }));
  await redis.set(configRecordKey(a, 'other'), await redis.get(configRecordKey(a, 'default')));
  assert.equal((await store.read({ installationId: a, userId: 'other' })).tampered, true);
  const foreign = new SetupConfigStore({ identityKeyFile: join(mkdtempSync(join(ROOT, 'k-')), 'identity.key'), redis: () => redis });
  assert.equal((await foreign.read({ installationId: a })).tampered, true);
});

// ── compare-and-set ─────────────────────────────────────────────────────────

test('writes are compare-and-set: a stale writer loses, never overwrites', async () => {
  const ref = { installationId: randomUUID() };
  assert.equal(await store.compareAndSet(ref, null, desired()), true);
  assert.equal(await store.compareAndSet(ref, null, desired({ setupVersion: 2 })), false, 'create only if absent');
  const { stored } = await store.read(ref);
  assert.equal(await store.compareAndSet(ref, stored, desired({ values: { smtpHost: 'b' } })), true);
  assert.equal(await store.compareAndSet(ref, stored, desired({ values: { smtpHost: 'c' } })), false, 'stale bytes');
  assert.deepEqual((await store.get(ref)).values, { smtpHost: 'b' });

  // update(): a write, a no-op, and a conflict when the record changes after update() read it.
  const res = await store.update(ref, (cur) => ({ ...cur, values: { smtpHost: 'd' } }));
  assert.deepEqual([res.ok, res.changed], [true, true]);
  const same = await store.update(ref, (cur) => cur);
  assert.deepEqual([same.ok, same.changed], [true, false]);
  // Force a conflict: change the record after update() has read it.
  const orig = store.read.bind(store);
  store.read = async (r) => { const out = await orig(r); await redis.set(configRecordKey(r.installationId), (await redis.get(configRecordKey(r.installationId))) + ' '); return out; };
  assert.deepEqual(await store.update(ref, (cur) => ({ ...cur, values: { smtpHost: 'g' } })), { ok: false, reason: 'conflict' });
});

test('a tampered record can be replaced by passing its stored bytes', async () => {
  const ref = { installationId: randomUUID() };
  await redis.set(configRecordKey(ref.installationId), '{"v":1}');
  const r = await store.read(ref);
  assert.equal(r.tampered, true);
  assert.equal(await store.compareAndSet(ref, r.stored, desired()), true);
  assert.deepEqual(await store.get(ref), desired());
});

test('installation vs user records: separate keys; a user record has no profile and no overrides', async () => {
  const id = randomUUID();
  await store.compareAndSet({ installationId: id }, null, desired({ profile: 'personal', overrides: { homeEnvironment: 'private' } }));
  await store.compareAndSet({ installationId: id, userId: 'default' }, null, desired({ values: { theme: 'dark' } }));
  assert.equal((await store.get({ installationId: id })).profile, 'personal');
  assert.deepEqual((await store.get({ installationId: id, userId: 'default' })).values, { theme: 'dark' });
  assert.deepEqual(await store.userIds(id), ['default']);
  await assert.rejects(store.compareAndSet({ installationId: id, userId: 'x' }, null, desired({ profile: 'personal' })), (e) => e.code === 'invalid-record');
  await assert.rejects(store.compareAndSet({ installationId: id, userId: 'x' }, null, desired({ overrides: { sandbox: 'container' } })), (e) => e.code === 'invalid-record');
  await assert.rejects(store.read({ installationId: 'a:u:b' }), (e) => e instanceof SetupStoreError && e.code === 'invalid-id');
  await assert.rejects(store.read({ installationId: 'a*' }), (e) => e.code === 'invalid-id');
  await assert.rejects(store.read({ installationId: id, userId: 'a:b' }), (e) => e.code === 'invalid-id');
});

// ── secrets ─────────────────────────────────────────────────────────────────

test('secrets are vault handles only: no value is ever stored', async () => {
  const kv = memoryKv();
  const vault = new CredentialVault({ kv: kv.kv, key: randomBytes(32) });
  const VALUE = 'smtp-' + randomBytes(16).toString('hex');
  const { handle } = await vault.store('default', 'SMTP_PASSWORD', VALUE, { consumer: 'com.example.mailer' });
  const id = randomUUID();
  await store.compareAndSet({ installationId: id }, null, desired({ secrets: { password: handle } }));
  const bytes = await redis.get(configRecordKey(id));
  assert.ok(!bytes.includes(VALUE), 'the stored bytes never hold the value');
  assert.ok(bytes.includes(handle));

  for (const bad of [{ password: VALUE }, { password: 'cred_short' }, { password: 42 }]) {
    await assert.rejects(store.compareAndSet({ installationId: randomUUID() }, null, desired({ secrets: bad })), (e) => e.code === 'invalid-record');
  }
  // A secret field is never also a plain value.
  await assert.rejects(store.compareAndSet({ installationId: randomUUID() }, null, desired({ values: { password: 'x' }, secrets: { password: handle } })), (e) => e.code === 'invalid-record');
  assert.equal(parseDesiredConfig(desired({ secrets: { password: VALUE } })), null);
});

test('the tamper audit entry names the record, never a value or a handle', () => {
  const e = tamperAuditInput({ installationId: 'i1', userId: 'default' });
  assert.equal(e.action, SETUP_AUDIT_ACTIONS.recordTampered);
  assert.equal(e.target, 'installation:i1');
  assert.deepEqual(e.detail, { record: 'user', userId: 'default' });
});

// ── state machine ───────────────────────────────────────────────────────────

test('the transition table: every listed transition is legal, nothing else; nothing enters `ready` but markReady', () => {
  for (const from of OPERATIONAL_STATES) {
    for (const to of OPERATIONAL_STATES) assert.equal(canTransition(from, to), OPERATIONAL_TRANSITIONS[from].includes(to), `${from}→${to}`);
  }
  assert.equal(canTransition(null, 'setup-required'), true);
  assert.equal(canTransition(null, 'ready'), false);
});

test('a simple app: derived ready, no summary, no record, ever', async () => {
  const i = await newInstall('com.example.simple');
  assert.deepEqual(await machine.state(i.installationId, SIMPLE_MANIFEST), { declares: false, state: 'ready', summary: null });
  assert.deepEqual(deriveSetupState(i, {}), { declares: false, state: 'ready', summary: null });
  await assert.rejects(machine.begin(i.installationId, SIMPLE_MANIFEST), (e) => e instanceof SetupStateError && e.code === 'not-declared');
  assert.equal((await registry.getInstallation(i.installationId)).setup, undefined);
  assert.deepEqual(await redis.keys('app:config:*'), []);
  // An empty profiles array is no declaration either.
  assert.equal((await machine.state(i.installationId, { profiles: [] })).declares, false);
});

test('a configured app: setup-required until begun; illegal transitions refused with a code', async () => {
  const i = await newInstall();
  const id = i.installationId;
  assert.deepEqual(await machine.state(id, SETUP_MANIFEST), { declares: true, state: 'setup-required', summary: null });
  const s0 = await machine.begin(id, SETUP_MANIFEST);
  assert.equal(s0.state, 'setup-required');
  assert.deepEqual(await machine.begin(id, SETUP_MANIFEST), s0, 'begin is idempotent');

  await assert.rejects(machine.transition(id, s0, 'initializing'), (e) => e.code === 'illegal-transition');
  await assert.rejects(machine.transition(id, s0, 'ready'), (e) => e.code === 'digest-required');
  const s1 = await machine.transition(id, s0, 'configuring', { step: 'values' });
  assert.equal(s1.state, 'configuring');
  await assert.rejects(machine.transition(id, s0, 'configuring'), (e) => e.code === 'conflict', 'a stale expect is a conflict');
  await assert.rejects(machine.markReady(id, s1, { configDigest: D1, grantDigest: G1, profile: null }), (e) => e.code === 'illegal-transition');
});

test('resumption: step, attempt and approvalId persist; approvalId only while awaiting approval', async () => {
  const id = (await newInstall()).installationId;
  let s = await machine.begin(id, SETUP_MANIFEST);
  s = await machine.transition(id, s, 'configuring', { step: 'profile', profile: 'personal' });
  s = await machine.progress(id, s, { step: 'review' });
  s = await machine.transition(id, s, 'awaiting-approval', { step: 'approval', approvalId: 'appr-123' });
  const reread = (await registry.getInstallation(id)).setup;
  assert.deepEqual(reread, s, 'what a resume reads after a restart');
  assert.deepEqual([reread.state, reread.step, reread.approvalId, reread.profile], ['awaiting-approval', 'approval', 'appr-123', 'personal']);
  s = await machine.transition(id, s, 'initializing', { step: 'init', attempt: 1 });
  assert.equal(s.approvalId, undefined);
  s = await machine.progress(id, s, { attempt: 2 });
  assert.equal(s.attempt, 2);
});

test('ready only via markReady with the validated digests (CAS); a failed reconfiguration keeps the old ready digest', async () => {
  const id = (await newInstall()).installationId;
  let s = await machine.begin(id, SETUP_MANIFEST);
  s = await machine.transition(id, s, 'configuring');
  s = await machine.transition(id, s, 'initializing', { step: 'init', attempt: 1 });
  for (const bad of [{ configDigest: '', grantDigest: G1 }, { configDigest: 'a'.repeat(64), grantDigest: G1 }, { configDigest: D1, grantDigest: null }]) {
    await assert.rejects(machine.markReady(id, s, { ...bad, profile: null }), (e) => e.code === 'digest-required');
  }
  // The registry itself refuses a `ready` summary without digests.
  await assert.rejects(registry.setSetup(id, s, { ...s, state: 'ready' }), /invalid setup summary/);
  const r = await machine.markReady(id, s, { configDigest: D1, grantDigest: G1, profile: null });
  assert.deepEqual([r.state, r.configDigest, r.grantDigest, r.step], ['ready', D1, G1, 'done']);
  await assert.rejects(machine.markReady(id, s, { configDigest: D1, grantDigest: G1, profile: null }), (e) => e.code === 'conflict' || e.code === 'illegal-transition');
  await assert.rejects(machine.progress(id, r, { step: 'values' }), (e) => e.code === 'illegal-transition');

  // Reconfigure, then fail: the stored digest is still the old ready one, never D2.
  s = await machine.transition(id, r, 'configuring');
  s = await machine.transition(id, s, 'initializing');
  s = await machine.transition(id, s, 'setup-failed', { error: { error: 'hook-failed', category: 'needs-setup', message: 'onSetup failed' } });
  assert.deepEqual([s.state, s.configDigest], ['setup-failed', D1]);
  assert.equal(s.error.error, 'hook-failed');
  // blocked → ready (reauthorized) needs the digest too.
  s = await machine.transition(id, s, 'blocked');
  await assert.rejects(machine.transition(id, s, 'ready'), (e) => e.code === 'digest-required');
  const back = await machine.markReady(id, s, { configDigest: D1, grantDigest: G1, profile: null });
  assert.equal(back.state, 'ready');
  assert.equal(back.error, undefined);
});

test('a concurrent change between read and CAS is a conflict, never overwritten', async () => {
  const id = (await newInstall()).installationId;
  const s0 = await machine.begin(id, SETUP_MANIFEST);
  const a = await machine.transition(id, s0, 'configuring');
  await assert.rejects(machine.transition(id, s0, 'blocked'), (e) => e.code === 'conflict');
  assert.deepEqual((await registry.getInstallation(id)).setup, a);
});

test('tamper: the desired record reads as absent and the state becomes setup-required once', async () => {
  const id = (await newInstall()).installationId;
  let s = await machine.begin(id, SETUP_MANIFEST);
  s = await machine.transition(id, s, 'configuring');
  s = await machine.transition(id, s, 'initializing');
  s = await machine.markReady(id, s, { configDigest: D1, grantDigest: G1, profile: null });
  await store.compareAndSet({ installationId: id }, null, desired());
  await redis.set(configRecordKey(id), (await redis.get(configRecordKey(id))).replace('mail.example', 'evil.example'));

  const r = await machine.desired({ installationId: id });
  assert.equal(r.value, null);
  const after = (await registry.getInstallation(id)).setup;
  assert.deepEqual([after.state, after.configDigest, after.grantDigest, after.profile], ['setup-required', null, null, null]);
  assert.equal(after.error.error, 'setup-required');
  const stamp = await redis.get(`apphost:install:${id}`);
  await machine.desired({ installationId: id });
  await machine.desired({ installationId: id });
  assert.equal(await redis.get(`apphost:install:${id}`), stamp, 'the reset happens once');
  assert.equal(tampered.length, 1, 'reported once');

  // From a state the transition table cannot leave for setup-required (an integrity reset, not a step).
  const id2 = (await newInstall('com.example.other')).installationId;
  let t = await machine.begin(id2, SETUP_MANIFEST);
  t = await machine.transition(id2, t, 'configuring');
  t = await machine.transition(id2, t, 'awaiting-approval', { approvalId: 'appr-1' });
  await store.compareAndSet({ installationId: id2, userId: 'default' }, null, desired({ values: { theme: 'x' } }));
  await redis.set(configRecordKey(id2, 'default'), 'garbage');
  await machine.desired({ installationId: id2, userId: 'default' });
  const t2 = (await registry.getInstallation(id2)).setup;
  assert.equal(t2.state, 'setup-required');
  assert.equal(t2.approvalId, undefined);
});

test('setSetup: shape-checked, only on an active installation, preserved by other record writes', async () => {
  const i = await newInstall();
  const id = i.installationId;
  await assert.rejects(registry.setSetup(id, null, { state: 'nope' }), /invalid setup summary/);
  await assert.rejects(registry.setSetup(id, null, { state: 'setup-required', profile: null, configDigest: null, grantDigest: null, step: null, attempt: 0, updatedAt: 'x' }), /invalid/);
  await assert.rejects(registry.setSetup(id, null, { state: 'setup-required', profile: null, configDigest: null, grantDigest: null, step: null, attempt: 0, updatedAt: new Date().toISOString(), extra: 1 }), /invalid/);
  const s = await machine.begin(id, SETUP_MANIFEST);
  await registry.updateInstallation(id, { source: { kind: 'oci', ref: 'reg.example/apps/mailer:1.1.0' } });
  await registry.setRunAs(id, 'app');
  assert.deepEqual((await registry.getInstallation(id)).setup, s, 'kept by updateInstallation and setRunAs');
  assert.deepEqual(await registry.setSetup('missing', null, s), { ok: false, installation: null });
  await registry.reserve(id);
  assert.equal((await registry.setSetup(id, s, { ...s, attempt: 1 })).ok, false, 'a reserved installation is not written');
  assert.deepEqual((await registry.getInstallation(id)).setup, s, 'kept with the reserved installation');
});

// ── lifecycle: new, clone, keep data, delete data ───────────────────────────

test('lifecycle: a new or cloned installation holds no configuration; keep-data keeps it; delete-app-data deletes it and revokes the handles', async () => {
  const kv = memoryKv();
  const vault = new CredentialVault({ kv: kv.kv, key: randomBytes(32) });
  const forgetting = new SetupConfigStore({ identityKeyFile: KEY_FILE, redis: () => redis, revokeHandle: vaultHandleRevoker(vault) });
  const lifecycle = new AppHostLifecycle(registry, null, { forgetSetup: (id, userId) => forgetting.forgetInstallation(id, userId) });
  const app = { appId: 'com.example.mailer', originId: randomUUID(), scope: 'user', source: SRC };

  const { installation: first } = await lifecycle.sync(app);
  const { handle } = await vault.store('default', 'SMTP_PASSWORD', 'v-' + randomBytes(8).toString('hex'), { consumer: app.appId });
  await store.compareAndSet({ installationId: first.installationId }, null, desired({ secrets: { password: handle } }));
  await store.compareAndSet({ installationId: first.installationId, userId: 'default' }, null, desired({ values: { theme: 'dark' } }));
  let s = await machine.begin(first.installationId, SETUP_MANIFEST);

  // Keep data: reserved, records and summary kept; the same app restores them.
  await lifecycle.reserveApp(app.appId, 'user');
  assert.ok(await store.get({ installationId: first.installationId }));
  const { installation: restored } = await lifecycle.sync(app);
  assert.equal(restored.installationId, first.installationId);
  assert.deepEqual(restored.setup, s);

  // Another origin under the same id (a clone, another publisher): a new installation, no configuration.
  const { installation: other } = await lifecycle.sync({ ...app, originId: randomUUID() });
  assert.notEqual(other.installationId, first.installationId);
  assert.equal(other.setup, undefined);
  assert.equal(await store.get({ installationId: other.installationId }), null);
  assert.deepEqual(await store.userIds(other.installationId), []);
  assert.ok(await store.get({ installationId: first.installationId }), 'the reserved installation keeps its records');

  // Delete app data: every installation's records go, the handle is revoked in the vault.
  assert.ok(await vault.resolve('default', handle));
  await lifecycle.retireApp(app.appId, 'user');
  assert.deepEqual(await redis.keys('app:config:*'), []);
  assert.equal(await vault.resolve('default', handle), null, 'the handle no longer resolves');
  assert.equal(await vault.handleOf('default', 'SMTP_PASSWORD', app.appId), null);
});

test('delete-app-data fails closed: no vault port, or a failing revocation, keeps the records and the installation', async () => {
  const id = (await newInstall()).installationId;
  await store.compareAndSet({ installationId: id }, null, desired({ secrets: { password: 'cred_' + 'A'.repeat(22) } }));
  await assert.rejects(store.forgetInstallation(id, 'default'), (e) => e.code === 'invalid-record');
  const failing = new SetupConfigStore({ identityKeyFile: KEY_FILE, redis: () => redis, revokeHandle: async () => { throw new Error('vault down'); } });
  const lifecycle = new AppHostLifecycle(registry, null, { forgetSetup: (i, u) => failing.forgetInstallation(i, u) });
  await assert.rejects(lifecycle.retireApp('com.example.mailer', 'user'), /vault down/);
  assert.ok(await store.get({ installationId: id }), 'records kept for a repeat');
  assert.equal((await registry.getInstallation(id)).state, 'active', 'not retired');

  // A tampered record's handles are not trusted (not revoked) but the record is deleted.
  const revoked = [];
  const ok = new SetupConfigStore({ identityKeyFile: KEY_FILE, redis: () => redis, revokeHandle: async (u, h) => { revoked.push(h); } });
  await redis.set(configRecordKey(id, 'default'), JSON.stringify({ v: 1, values: { secrets: { x: 'cred_' + 'B'.repeat(22) } }, mac: 'x' }));
  assert.deepEqual(await ok.forgetInstallation(id, 'default'), { records: 2, revoked: 1 });
  assert.deepEqual(revoked, ['cred_' + 'A'.repeat(22)]);
  assert.deepEqual(await redis.keys('app:config:*'), []);
});
