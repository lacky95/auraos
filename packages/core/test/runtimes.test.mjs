// Phase 5 stream R: the runtime registry and its one resolver (Q17 errors, no
// fallback, useProot ignored, the default for an omitted sandbox), the sealed
// Runtime Settings record (tamper, CAS, the enable/default rules), the schema
// validation, the D75 migration (idempotent, fail closed for the insecure
// cases) and a test-only runtime registered with no AppManager edit.
// Run via: node tools/run-tests.mjs --only=core

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  RuntimeRegistry, builtInRuntimeRecord, requirementsOf, validateSettings, settingsDefaults, RuntimeSettingsError,
  RuntimeSettingsStore, RuntimeChangeError, RUNTIME_POLICY_KEY, parseRuntimeRecord,
  migrateLegacyRuntimes, decideMigration, classify, legacyRuntime,
  RuntimeUnavailableError, RuntimeCapabilityError, RuntimeResolutionError,
  SecurityPolicyStore, SECURITY_POLICY_KEY, FRESH_AUTH_REQUIRE_HTTPS, deriveIdentitySubkey,
} from '../dist/index.js';
import { containerRuntime } from '../dist/runtimes/builtins/container.js';
import { prootRuntime } from '../dist/runtimes/builtins/proot.js';
import { AppManifestSchema } from '../dist/types/manifest.js';
import { AppManager } from '../dist/app-manager/AppManager.js';
import { ContainerRunner } from '../dist/app-manager/ContainerRunner.js';
import { ProotRunner } from '../dist/app-manager/ProotRunner.js';

const TMP = mkdtempSync(join(tmpdir(), 'aura-runtimes-'));
const ROOTFS = join(TMP, 'rootfs');
mkdirSync(ROOTFS);

const CONTAINER_CAPS = ContainerRunner.prototype.capabilities.call({});
const PROOT_CAPS = ProotRunner.prototype.capabilities.call({});
const runner = (caps, id) => ({ id, capabilities: () => caps });

function registry(env = { AURA_USE_PROOT: 'true' }, rootfs = ROOTFS) {
  const r = new RuntimeRegistry();
  r.register(containerRuntime(runner(CONTAINER_CAPS, 'c')));
  r.register(prootRuntime(runner(PROOT_CAPS, 'p'), { baseRootfs: rootfs, env }));
  return r;
}

const app = (extra = {}) => AppManifestSchema.parse({ id: 'org.r.app', name: 'R', version: '1.0.0', ...extra });

function memoryRedis() {
  const data = new Map();
  return {
    data,
    redis: {
      get: async (k) => data.get(k) ?? null,
      set: async (k, v, nx) => { if (nx === 'NX' && data.has(k)) return null; data.set(k, v); return 'OK'; },
      eval: async (_s, _n, k, expected, next) => { if (data.get(k) !== expected) return 0; data.set(k, next); return 1; },
    },
  };
}

function store(reg = registry(), extra = {}) {
  const kv = memoryRedis();
  const dir = mkdtempSync(join(TMP, 'key-'));
  let tampered = 0;
  const s = new RuntimeSettingsStore({
    identityKeyFile: join(dir, 'identity.key'), redis: () => kv.redis, registry: reg, onTampered: () => { tampered += 1; }, ...extra,
  });
  return { s, kv, tampered: () => tampered, keyFile: join(dir, 'identity.key') };
}

const resolve = (reg, manifest, record, more = {}) =>
  reg.resolve({ manifest, installationId: 'inst-1', sourceMode: 'open', record, ...more });

// ── registry and resolver ───────────────────────────────────────────────────

test('an omitted sandbox follows the default; the manifest names its runtime; an override wins', () => {
  const reg = registry();
  const rec = builtInRuntimeRecord(reg);
  assert.deepEqual([rec.default, rec.enabled, rec.settings.proot], ['container', ['container', 'proot'], { placement: 'master' }]);
  const a = resolve(reg, app(), rec);
  assert.deepEqual([a.runtime, a.source, a.module.runner.id], ['container', 'default', 'c']);
  const b = resolve(reg, app({ sandbox: 'proot' }), rec);
  assert.deepEqual([b.runtime, b.source, b.module.runner.id, b.settings], ['proot', 'manifest', 'p', { placement: 'master' }]);
  const withDefault = { ...rec, default: 'proot' };
  assert.equal(resolve(reg, app(), withDefault).runtime, 'proot', 'the default is the record\'s');
  const over = { ...rec, overrides: { 'inst-1': { runtime: 'proot', source: 'migration', recordedAt: 'x', settings: { placement: 'master' } } } };
  const c = resolve(reg, app(), over);
  assert.deepEqual([c.runtime, c.source], ['proot', 'migration']);
  assert.equal(resolve(reg, app(), over, { installationId: 'inst-2' }).source, 'default', 'overrides are per installation');
  // A migration override keeps what an omitted sandbox meant: once the manifest names a runtime (an app update), it lapses.
  assert.deepEqual(Object.values(resolve(reg, app({ sandbox: 'container' }), over)).slice(0, 2), ['container', 'manifest']);
  // The owner's own override wins over the manifest.
  const owner = { ...rec, overrides: { 'inst-1': { runtime: 'proot', source: 'override', recordedAt: 'x' } } };
  assert.deepEqual(Object.values(resolve(reg, app({ sandbox: 'container' }), owner)).slice(0, 2), ['proot', 'override']);
});

test('Q17: an unknown or disabled runtime is a clear error, never a fallback', () => {
  const reg = registry();
  const rec = builtInRuntimeRecord(reg);
  assert.throws(() => resolve(reg, app({ sandbox: 'gvisor' }), rec),
    (e) => e instanceof RuntimeUnavailableError && e.code === 'runtime-not-installed' && /runtime gvisor is not installed/.test(e.message));
  assert.throws(() => resolve(reg, app({ sandbox: 'proot' }), { ...rec, enabled: ['container'] }),
    (e) => e instanceof RuntimeUnavailableError && e.code === 'runtime-disabled' && e.runtime === 'proot');
  assert.throws(() => resolve(reg, app(), { ...rec, default: 'gvisor' }), (e) => e.code === 'runtime-not-installed');
  // container is always enabled, even if a record left it out.
  assert.equal(resolve(reg, app({ sandbox: 'container' }), { ...rec, enabled: [] }).runtime, 'container');
});

test('useProot is ignored, and PRoot never runs unwrapped: no AURA_USE_PROOT or no rootfs fails closed', () => {
  const reg = registry();
  const rec = builtInRuntimeRecord(reg);
  assert.equal(resolve(reg, app({ useProot: false }), rec).runtime, 'container', 'useProot:false is not a runtime choice');
  assert.equal(resolve(reg, app({ sandbox: 'proot', useProot: false }), rec).runtime, 'proot', 'nor does it opt out of PRoot');
  for (const r of [registry({}), registry({ AURA_USE_PROOT: 'false' }), registry({ AURA_USE_PROOT: 'true' }, join(TMP, 'missing'))]) {
    assert.throws(() => resolve(r, app({ sandbox: 'proot' }), builtInRuntimeRecord(r)),
      (e) => e instanceof RuntimeUnavailableError && /not available/.test(e.message));
  }
  assert.throws(() => resolve(reg, app({ sandbox: 'proot' }), { ...rec, settings: { proot: { placement: 'pool' } } }),
    /pool placement is not available/, 'the pool comes with R2');
});

test('capabilities from the manifest: a closed app, sidecars or port expose on PRoot fail closed (ARI-4)', () => {
  const reg = registry();
  const rec = builtInRuntimeRecord(reg);
  assert.throws(() => resolve(reg, app({ sandbox: 'proot' }), rec, { sourceMode: 'closed' }),
    (e) => e instanceof RuntimeCapabilityError && e.code === 'capability-missing' && e.missing.includes('readOnlyBinds') && /ARI-4/.test(e.message));
  assert.throws(() => resolve(reg, app({ sandbox: 'proot', services: [{ name: 'db', image: 'redis:7' }] }), rec),
    (e) => e instanceof RuntimeCapabilityError && e.missing.includes('sidecars'));
  assert.deepEqual(requirementsOf(app({ services: [{ name: 'db', image: 'redis:7' }] }), { sourceMode: 'closed' }).needs, { sidecars: true, readOnlyBinds: true });
  assert.equal(resolve(reg, app(), rec, { sourceMode: 'closed' }).runtime, 'container');
});

test('fail closed when the record or the installation cannot be read (only an explicit container is certain)', () => {
  const reg = registry();
  assert.equal(resolve(reg, app({ sandbox: 'container' }), null).runtime, 'container');
  assert.throws(() => resolve(reg, app(), null), (e) => e instanceof RuntimeResolutionError && e.code === 'runtime-unresolved');
  assert.throws(() => resolve(reg, app({ sandbox: 'proot' }), null), (e) => e.code === 'runtime-unresolved');
  assert.throws(() => resolve(reg, app(), builtInRuntimeRecord(reg), { installationId: null }), /not recorded yet/);
});

test('an open D75 decision stops the start with the decision commands', () => {
  const reg = registry();
  const rec = { ...builtInRuntimeRecord(reg), pending: { 'inst-1': { appId: 'org.r.app', legacy: 'master-direct', sandbox: 'omitted', reason: 'master-direct', recordedAt: 'x' } } };
  assert.throws(() => resolve(reg, app(), rec), (e) => e instanceof RuntimeResolutionError && e.code === 'runtime-decision-needed'
    && /aura runtime migrate --adopt-default org\.r\.app/.test(e.message) && /--keep org\.r\.app proot/.test(e.message));
  assert.throws(() => resolve(reg, app({ sandbox: 'proot' }), rec), (e) => e.code === 'runtime-decision-needed');
  assert.equal(resolve(reg, app({ sandbox: 'container' }), rec).source, 'manifest', 'an update that names container decides by itself');
});

test('a registry refuses a duplicate id', () => {
  const reg = registry();
  assert.throws(() => reg.register(containerRuntime(runner(CONTAINER_CAPS))), /already registered/);
});

// ── schema ──────────────────────────────────────────────────────────────────

test('settings schema: defaults, types and enums; unknown keys refused', () => {
  const schema = { type: 'object', properties: {
    placement: { type: 'string', title: 'P', enum: ['master', 'pool'], default: 'master' },
    gpu: { type: 'boolean', title: 'G', default: false },
    cpus: { type: 'integer', title: 'C', minimum: 1, maximum: 8 },
    groups: { type: 'array', items: { type: 'string' }, title: 'Gr', default: [] },
  } };
  assert.deepEqual(settingsDefaults(schema), { placement: 'master', gpu: false, groups: [] });
  assert.deepEqual(validateSettings(schema, { gpu: 'true', cpus: '4', groups: 'a, b' }), { placement: 'master', gpu: true, cpus: 4, groups: ['a', 'b'] });
  for (const bad of [{ placement: 'moon' }, { cpus: 9 }, { cpus: 'x' }, { gpu: 'maybe' }, { nope: 1 }]) {
    assert.throws(() => validateSettings(schema, bad), RuntimeSettingsError, JSON.stringify(bad));
  }
  assert.throws(() => validateSettings(schema, []), RuntimeSettingsError);
});

// ── the sealed record ───────────────────────────────────────────────────────

test('Runtime Settings: sealed; missing or tampered means the built-in defaults, reported once', async () => {
  const { s, kv, tampered } = store();
  assert.deepEqual((await s.read()).trusted, false);
  assert.equal((await s.get()).default, 'container');
  assert.ok((await s.setEnabled('proot', false)).ok);
  assert.deepEqual((await s.get()).enabled, ['container']);
  assert.equal((await s.read()).trusted, true);
  const raw = JSON.parse(kv.data.get(RUNTIME_POLICY_KEY));
  raw.values.enabled = ['container', 'proot', 'evil'];
  kv.data.set(RUNTIME_POLICY_KEY, JSON.stringify(raw));
  assert.deepEqual((await s.get()).enabled, ['container', 'proot'], 'tampered: the built-in defaults');
  await s.get();
  assert.equal(tampered(), 1, 'reported once');
  kv.data.set(RUNTIME_POLICY_KEY, '{not json');
  await s.get();
  assert.equal(tampered(), 2, 'a new bad record is reported again');
});

test('Runtime Settings: compare-and-set never overwrites a concurrent change', async () => {
  const { s, kv } = store();
  await s.setEnabled('proot', false); // first write: stored
  const result = await s.update((cur) => {
    // Someone else writes meanwhile.
    kv.data.set(RUNTIME_POLICY_KEY, kv.data.get(RUNTIME_POLICY_KEY).replace('"v":1', '"v":1 '));
    return { next: { ...cur, default: 'proot' } };
  });
  assert.deepEqual(result, { ok: false, reason: 'conflict' });
});

test('Runtime Settings rules: container and the default cannot be disabled; the default must be enabled; settings follow the schema', async () => {
  const { s } = store();
  await assert.rejects(s.setEnabled('container', false), (e) => e instanceof RuntimeChangeError && e.code === 'cannot-disable');
  await assert.rejects(s.setEnabled('gvisor', true), (e) => e.code === 'unknown-runtime');
  assert.ok((await s.setDefault('proot')).changed);
  await assert.rejects(s.setEnabled('proot', false), /is the default/);
  assert.ok((await s.setDefault('container')).changed);
  assert.ok((await s.setEnabled('proot', false)).changed);
  await assert.rejects(s.setDefault('proot'), (e) => e.code === 'not-enabled');
  const same = await s.setEnabled('proot', false);
  assert.deepEqual([same.ok, same.changed], [true, false], 'no change, no write');
  await assert.rejects(s.setSettings('proot', { placement: 'moon' }), (e) => e.code === 'invalid-settings');
  await assert.rejects(s.setSettings('proot', { placement: 'pool' }), /not available in this release/);
  await assert.rejects(s.setSettings('proot', { other: 1 }), /unknown setting/);
  await assert.rejects(s.setSettings('container', { x: 1 }), /unknown setting/, 'container has no settings');
});

test('the record parser refuses a malformed shape', () => {
  assert.equal(parseRuntimeRecord({ v: 2, default: 'container', enabled: [], settings: {}, overrides: {} }), null);
  assert.equal(parseRuntimeRecord({ v: 1, default: 'Bad Id', enabled: [], settings: {}, overrides: {} }), null);
  assert.equal(parseRuntimeRecord({ v: 1, default: 'container', enabled: [], settings: {}, overrides: { a: { runtime: 'proot', source: 'guess', recordedAt: 'x' } } }), null);
  assert.ok(parseRuntimeRecord({ v: 1, default: 'container', enabled: ['container'], settings: { proot: {} }, overrides: {} }));
});

test('the shared seal keeps the security options record byte-compatible', async () => {
  const kv = memoryRedis();
  const keyFile = join(mkdtempSync(join(TMP, 'sec-')), 'identity.key');
  const sec = new SecurityPolicyStore({ identityKeyFile: keyFile, redis: () => kv.redis });
  // A record sealed the way the pre-R store did (identity.key subkey, sorted entries).
  const values = { [FRESH_AUTH_REQUIRE_HTTPS]: true };
  const canonical = JSON.stringify([SECURITY_POLICY_KEY, 1, Object.entries(values).sort(([a], [b]) => a.localeCompare(b))]);
  const mac = createHmac('sha256', deriveIdentitySubkey(keyFile, 'security-policy')).update(canonical).digest('base64url');
  kv.data.set(SECURITY_POLICY_KEY, JSON.stringify({ v: 1, values, mac }));
  assert.deepEqual(await sec.get(), values);
  // The runtime record's MAC is bound to its own purpose: a copied security record does not pass.
  const { s, kv: rkv } = store(registry(), { identityKeyFile: keyFile });
  rkv.data.set(RUNTIME_POLICY_KEY, kv.data.get(SECURITY_POLICY_KEY));
  assert.equal((await s.read()).trusted, false);
});

// ── D75 migration ───────────────────────────────────────────────────────────

const legacyEnv = { useProotEnv: 'true', rootfsPresent: true };
const mApp = (appId, extra = {}, sourceMode = 'open', installationId = `i-${appId}`) =>
  ({ appId, manifest: app({ id: appId, ...extra }), installationId, sourceMode });

test('D75 classification: the plan\'s table', () => {
  assert.equal(legacyRuntime(app(), legacyEnv), 'proot-master', 'an omitted sandbox meant PRoot');
  assert.equal(legacyRuntime(app({ useProot: false }), legacyEnv), 'master-direct');
  assert.equal(legacyRuntime(app(), { useProotEnv: undefined, rootfsPresent: true }), 'master-direct');
  assert.equal(legacyRuntime(app(), { useProotEnv: 'true', rootfsPresent: false }), 'master-direct');
  assert.equal(legacyRuntime(app({ sandbox: 'container', useProot: false }), legacyEnv), 'container');
  const row = (a) => { const r = classify(a, legacyEnv); return [r.sandbox, r.legacy, r.decision]; };
  assert.deepEqual(row(mApp('a.c', { sandbox: 'container' })), ['explicit', 'container', 'unchanged']);
  assert.deepEqual(row(mApp('a.o')), ['omitted', 'proot-master', 'override']);
  assert.deepEqual(row(mApp('a.e', { sandbox: 'proot' })), ['explicit', 'proot-master', 'unchanged']);
  assert.deepEqual(row(mApp('a.cl', {}, 'closed')), ['omitted', 'proot-master', 'incompatible']);
  assert.deepEqual(row(mApp('a.ce', { sandbox: 'proot' }, 'closed')), ['explicit', 'proot-master', 'incompatible']);
  assert.deepEqual(row(mApp('a.d', { useProot: false })), ['omitted', 'master-direct', 'incompatible']);
  assert.deepEqual(row(mApp('a.u', { sandbox: 'gvisor' })), ['explicit', 'unknown', 'unchanged']);
});

test('D75 migration: overrides where secure, pending where not, a report and an audit row; idempotent', async () => {
  const reg = registry();
  const { s } = store(reg);
  const dataDir = mkdtempSync(join(TMP, 'data-'));
  const audits = [];
  const apps = [
    mApp('a.c', { sandbox: 'container' }), mApp('a.o'), mApp('a.e', { sandbox: 'proot' }),
    mApp('a.cl', {}, 'closed'), mApp('a.d', { useProot: false }),
  ];
  const deps = { store: s, env: legacyEnv, dataDir, now: () => new Date('2026-11-26T12:00:00Z'), audit: async (rows, file) => { audits.push({ rows, file }); } };
  const first = await migrateLegacyRuntimes(apps, deps);
  assert.equal(first.ran, true);
  const rec = await s.get();
  assert.deepEqual(Object.keys(rec.overrides), ['i-a.o']);
  assert.deepEqual(rec.overrides['i-a.o'], {
    runtime: 'proot', settings: { placement: 'master' }, source: 'migration', recordedAt: '2026-11-26T12:00:00.000Z', legacy: 'proot-master', appId: 'a.o',
  });
  assert.deepEqual(Object.keys(rec.pending).sort(), ['i-a.cl', 'i-a.d']);
  assert.equal(rec.pending['i-a.d'].reason, 'master-direct');
  assert.equal(rec.pending['i-a.cl'].reason, 'closed-on-proot');
  assert.equal(rec.migrations.d75, '2026-11-26T12:00:00.000Z');
  const report = JSON.parse(readFileSync(first.reportFile, 'utf8'));
  assert.equal(report.installations.length, 5);
  assert.deepEqual(Object.keys(report.installations[0]).sort(), ['appId', 'decision', 'installationId', 'legacy', 'reason', 'sandbox']);
  assert.equal(audits.length, 1);

  // The kept app resolves to PRoot through its migration override; the pending ones fail closed.
  assert.deepEqual([resolve(reg, apps[1].manifest, rec, { installationId: 'i-a.o' }).source], ['migration']);
  assert.throws(() => resolve(reg, apps[4].manifest, rec, { installationId: 'i-a.d' }), (e) => e.code === 'runtime-decision-needed');
  // A new app after the release follows the default (no override for it).
  assert.equal(resolve(reg, app({ id: 'a.new' }), rec, { installationId: 'i-a.new' }).runtime, 'container');

  // Idempotent: a second run changes nothing and writes no second report.
  const before = await s.read();
  const second = await migrateLegacyRuntimes([...apps, mApp('a.new')], deps);
  assert.equal(second.ran, false);
  assert.equal((await s.read()).stored, before.stored);
  assert.equal(readdirSync(join(dataDir, 'aura', 'runtime-migration')).length, 1);
  assert.equal(audits.length, 1);
});

test('D75 migration waits, writing nothing, while an installation is unknown', async () => {
  const { s } = store();
  const dataDir = mkdtempSync(join(TMP, 'data-'));
  const r = await migrateLegacyRuntimes([mApp('a.o'), mApp('a.x', {}, 'open', null)], { store: s, env: legacyEnv, dataDir });
  assert.deepEqual([r.ran, r.incomplete], [false, ['a.x']]);
  assert.equal((await s.read()).stored, null);
  assert.equal(existsSync(join(dataDir, 'aura', 'runtime-migration')), false);
});

test('D75 owner decision: adopt the default, or keep PRoot for an open app only; capability-checked', async () => {
  const reg = registry();
  const { s } = store(reg);
  const dataDir = mkdtempSync(join(TMP, 'data-'));
  const d = mApp('a.d', { useProot: false });
  const cl = mApp('a.cl', {}, 'closed');
  const ex = mApp('a.ex', { sandbox: 'proot', useProot: false });
  await migrateLegacyRuntimes([d, cl, ex], { store: s, env: legacyEnv, dataDir });
  await assert.rejects(decideMigration(s, reg, cl, { keep: 'proot' }), (e) => e.code === 'invalid-decision' && /ARI-4/.test(e.message));
  const kept = await decideMigration(s, reg, d, { keep: 'proot' });
  assert.equal(kept.result.runtime, 'proot');
  let rec = await s.get();
  assert.deepEqual([rec.overrides['i-a.d'].runtime, rec.overrides['i-a.d'].source, rec.overrides['i-a.d'].legacy], ['proot', 'migration', 'master-direct']);
  assert.equal(resolve(reg, d.manifest, rec, { installationId: 'i-a.d' }).runtime, 'proot');
  await decideMigration(s, reg, cl, { adoptDefault: true });
  rec = await s.get();
  assert.equal(rec.overrides['i-a.cl'], undefined, 'an omitted sandbox simply follows the default');
  assert.equal(resolve(reg, cl.manifest, rec, { installationId: 'i-a.cl', sourceMode: 'closed' }).runtime, 'container');
  await decideMigration(s, reg, ex, { adoptDefault: true });
  rec = await s.get();
  assert.deepEqual([rec.overrides['i-a.ex'].runtime, rec.overrides['i-a.ex'].source], ['container', 'override'], 'a manifest naming proot needs an override');
  assert.equal(rec.pending, undefined, 'every decision taken');
  await assert.rejects(decideMigration(s, reg, d, { adoptDefault: true }), (e) => e.code === 'not-found');
  // Removing the override: visible and removable (D75 step 6).
  const removed = await s.removeOverride('i-a.d');
  assert.equal(removed.result.runtime, 'proot');
  await assert.rejects(s.removeOverride('i-a.d'), (e) => e.code === 'not-found');
});

// ── the seam: a test-only runtime, no AppManager edit ───────────────────────

test('a fake runtime registers through the registry and resolves in AppManager with no edit to it', async () => {
  const dataDir = mkdtempSync(join(TMP, 'mgr-'));
  const fakeCaps = { ...CONTAINER_CAPS, isolation: 'vm' };
  const fake = { descriptor: { id: 'fake', version: '0.1.0', ari: 1, title: 'Fake', description: 'test', builtIn: false, settingsSchema: { type: 'object', properties: {} }, settingsVersion: 1 },
    runner: { capabilities: () => fakeCaps }, capabilities: () => fakeCaps, health: () => ({ status: 'ok', checks: [] }), endpoint: () => null };
  const mgr = new AppManager({ appsDir: join(dataDir, 'apps'), dataDir, baseRootfs: ROOTFS, toolchainDir: join(dataDir, 'tc'), runtimes: [fake] });
  assert.ok(mgr.runtimes.get('fake'));
  // The Valkey store, swapped for memory (the record knows the registry's runtimes).
  const { s } = store(mgr.runtimes);
  mgr.runtimeSettings = s;
  mgr.installationIdOf = async () => 'inst-f';
  // Installed but not enabled: Q17 runtime-disabled.
  await assert.rejects(mgr.resolveRuntime('org.r.app', app({ sandbox: 'fake' }), { sourceMode: 'closed' }), (e) => e.code === 'runtime-disabled');
  await s.setEnabled('fake', true);
  const r = await mgr.resolveRuntime('org.r.app', app({ sandbox: 'fake' }), { sourceMode: 'closed' });
  assert.deepEqual([r.runtime, r.source, r.installationId, r.capabilities.isolation], ['fake', 'manifest', 'inst-f', 'vm']);
  assert.equal((await mgr.resolveRuntime('org.r.app', app(), { sourceMode: 'closed' })).runtime, 'container');
});
