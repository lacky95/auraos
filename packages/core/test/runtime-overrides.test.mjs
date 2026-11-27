// Phase 5b stream M: the owner override (ARI-3) and the D75 migration report.
//   - an override is capability-checked when set (`capability-missing` with
//     `suggest`, never auto-picked) and at every start (no bypass, D75);
//     compare-and-set on what the owner saw; an open D75 decision is decided
//     first; the record stays readable by the 5-main parser (rollback);
//   - the report is read-only and stable (no record, file or audit write);
//   - no existing installation changes runtime without a recorded decision.
// Run via: node tools/run-tests.mjs --only=core

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  RuntimeRegistry, RuntimeSettingsStore, checkOverride, parseRuntimeRecord, runtimeSettingsRevision,
  migrateLegacyRuntimes, decideMigration, migrationReport, resolutionOf, legacyRuntime,
} from '../dist/index.js';
import { containerRuntime } from '../dist/runtimes/builtins/container.js';
import { prootRuntime } from '../dist/runtimes/builtins/proot.js';
import { AppManifestSchema } from '../dist/types/manifest.js';
import { ContainerRunner } from '../dist/app-manager/ContainerRunner.js';
import { ProotRunner } from '../dist/app-manager/ProotRunner.js';

const TMP = mkdtempSync(join(tmpdir(), 'aura-rt-overrides-'));
const ROOTFS = join(TMP, 'rootfs');
mkdirSync(ROOTFS);
const CONTAINER_CAPS = ContainerRunner.prototype.capabilities.call({});
const PROOT_CAPS = ProotRunner.prototype.capabilities.call({});

function registry(env = { AURA_USE_PROOT: 'true' }) {
  const r = new RuntimeRegistry();
  r.register(containerRuntime({ id: 'c', capabilities: () => CONTAINER_CAPS }));
  r.register(prootRuntime({ id: 'p', capabilities: () => PROOT_CAPS }, { baseRootfs: ROOTFS, env }));
  return r;
}
function store(reg) {
  const data = new Map();
  const redis = {
    get: async (k) => data.get(k) ?? null,
    set: async (k, v, nx) => { if (nx === 'NX' && data.has(k)) return null; data.set(k, v); return 'OK'; },
    eval: async (_s, _n, k, expected, next) => { if (data.get(k) !== expected) return 0; data.set(k, next); return 1; },
  };
  return new RuntimeSettingsStore({ identityKeyFile: join(mkdtempSync(join(TMP, 'key-')), 'identity.key'), redis: () => redis, registry: reg });
}
const manifest = (id, extra = {}) => AppManifestSchema.parse({ id, name: 'R', version: '1.0.0', ...extra });
const mApp = (appId, extra = {}, sourceMode = 'open') => ({ appId, manifest: manifest(appId, extra), installationId: `i-${appId}`, sourceMode });
const target = (a) => ({ installationId: a.installationId, appId: a.appId, manifest: a.manifest, sourceMode: a.sourceMode });
const legacyEnv = { useProotEnv: 'true', rootfsPresent: true };
const start = (reg, a, record) => reg.resolve({ manifest: a.manifest, installationId: a.installationId, sourceMode: a.sourceMode, record });

test('override set: wins over the manifest and the default, source override; same choice again changes nothing', async () => {
  const reg = registry();
  const s = store(reg);
  const a = mApp('o.open', { sandbox: 'container' });
  const r = await s.setOverride(target(a), 'proot', { now: () => new Date('2026-11-27T10:00:00Z') });
  assert.deepEqual([r.ok, r.changed, r.result.previous], [true, true, null]);
  const rec = await s.get();
  assert.deepEqual(rec.overrides['i-o.open'], { runtime: 'proot', source: 'override', recordedAt: '2026-11-27T10:00:00.000Z', appId: 'o.open' });
  assert.deepEqual([start(reg, a, rec).runtime, start(reg, a, rec).source], ['proot', 'override']);
  const again = await s.setOverride(target(a), 'proot');
  assert.equal(again.changed, false, 'no new timestamp, nothing to audit');
  // Rollback-safe: the record is the 5-main shape (the same parser, `source: 'override'` already known).
  assert.ok(parseRuntimeRecord(JSON.parse(JSON.stringify(rec))));
});

test('override set: capability-checked with suggest; unknown, disabled, bad settings and an open decision refused', async () => {
  const reg = registry();
  const s = store(reg);
  const closed = mApp('o.closed', {}, 'closed');
  await assert.rejects(s.setOverride(target(closed), 'proot'), (e) =>
    e.code === 'capability-missing' && e.missing.includes('readOnlyBinds') && e.suggest.join() === 'container'
    && /ARI-4/.test(e.message) && /it could run on: container/.test(e.message));
  const sidecars = mApp('o.side', { services: [{ name: 'db', image: 'postgres:16' }] });
  await assert.rejects(s.setOverride(target(sidecars), 'proot'), (e) => e.code === 'capability-missing' && e.missing.includes('sidecars'));
  await assert.rejects(s.setOverride(target(closed), 'gvisor'), (e) => e.code === 'unknown-runtime');
  await assert.rejects(s.setOverride(target(mApp('o.x')), 'proot', { settings: { placement: 'moon' } }), (e) => e.code === 'invalid-settings');
  await assert.rejects(s.setOverride(target(mApp('o.x')), 'proot', { settings: { nope: 1 } }), (e) => e.code === 'invalid-settings');
  await s.setEnabled('proot', false);
  await assert.rejects(s.setOverride(target(mApp('o.x')), 'proot'), (e) => e.code === 'not-enabled');
  assert.deepEqual((await s.get()).overrides, {}, 'nothing written by a refusal');
  // An open D75 decision is decided by `aura runtime migrate`, never by an override.
  await s.setEnabled('proot', true);
  const direct = mApp('o.direct', { useProot: false });
  await migrateLegacyRuntimes([direct], { store: s, env: legacyEnv, dataDir: mkdtempSync(join(TMP, 'd-')) });
  await assert.rejects(s.setOverride(target(direct), 'container'), (e) => e.code === 'decision-open' && /aura runtime migrate/.test(e.message));
  // The dry run is the same check, with no store.
  assert.throws(() => checkOverride(reg, emptyRecord(), target(closed), "proot"), (e) => e.code === "capability-missing");
});
function emptyRecord() { return { v: 1, default: 'container', enabled: ['container', 'proot'], settings: {}, overrides: {} }; }

test('override set: compare-and-set on the override the owner saw', async () => {
  const reg = registry();
  const s = store(reg);
  const a = mApp('o.cas');
  await assert.rejects(s.setOverride(target(a), 'proot', { expected: 'container' }), (e) => e.code === 'conflict');
  await s.setOverride(target(a), 'proot', { expected: null });
  await assert.rejects(s.setOverride(target(a), 'container', { expected: null }), (e) => e.code === 'conflict', 'someone set it meanwhile');
  const r = await s.setOverride(target(a), 'container', { expected: 'proot' });
  assert.equal(r.result.previous.runtime, 'proot');
});

test('an override never bypasses a capability: refused at every start too, and a manifest update does not lift it', async () => {
  const reg = registry();
  const s = store(reg);
  const a = mApp('o.later');
  await s.setOverride(target(a), 'proot');
  const rec = await s.get();
  // The installation is closed now (e.g. reinstalled from a store): the start fails closed with suggest.
  const closedNow = { ...a, sourceMode: 'closed' };
  assert.throws(() => start(reg, closedNow, rec), (e) => e.code === 'capability-missing' && e.missing.includes('readOnlyBinds') && e.suggest.join() === 'container');
  // A manifest that now names container still loses to the owner's override, and is still checked.
  const updated = { ...closedNow, manifest: manifest('o.later', { sandbox: 'container', services: [{ name: 'db', image: 'x:1' }] }) };
  assert.throws(() => start(reg, updated, rec), (e) => e.code === 'capability-missing' && e.missing.includes('sidecars'));
  // A tampered record that names proot for a closed app: still refused at the start.
  const forged = { ...rec, overrides: { 'i-o.later': { runtime: 'proot', source: 'override', recordedAt: 'x' } } };
  assert.throws(() => start(reg, closedNow, forged), (e) => e.code === 'capability-missing');
});

test('override settings apply to the start and change the settings revision', async () => {
  const reg = registry();
  const s = store(reg);
  const a = mApp('o.set');
  await s.setOverride(target(a), 'proot', { settings: { placement: 'master' } });
  const rec = await s.get();
  assert.deepEqual(rec.overrides['i-o.set'].settings, { placement: 'master' });
  const r = resolutionOf(reg, a, rec);
  assert.deepEqual([r.runtime, r.source, r.settingsRev], ['proot', 'override', runtimeSettingsRevision({ placement: 'master' })]);
  assert.equal(runtimeSettingsRevision({ a: 1, b: 2 }), runtimeSettingsRevision({ b: 2, a: 1 }), 'key order never changes it');
  assert.notEqual(runtimeSettingsRevision({ a: 1 }), runtimeSettingsRevision({ a: 2 }));
});

test('D75 decision refusals name the runtimes that could run it (suggest)', async () => {
  const reg = registry();
  const s = store(reg);
  const cl = mApp('o.cl', {}, 'closed');
  await migrateLegacyRuntimes([cl], { store: s, env: legacyEnv, dataDir: mkdtempSync(join(TMP, 'd-')) });
  await assert.rejects(decideMigration(s, reg, cl, { keep: 'proot' }), (e) =>
    e.code === 'invalid-decision' && e.suggest.join() === 'container' && /it could run on: container/.test(e.message));
});

test('migrate --report: a dry run of the classification, the recorded state and the current resolution; read-only and stable', async () => {
  const reg = registry();
  const s = store(reg);
  const dataDir = mkdtempSync(join(TMP, 'data-'));
  const apps = [mApp('r.c', { sandbox: 'container' }), mApp('r.o'), mApp('r.cl', {}, 'closed'), mApp('r.d', { useProot: false })];
  await migrateLegacyRuntimes(apps, { store: s, env: legacyEnv, dataDir, now: () => new Date('2026-11-26T12:00:00Z') });
  const stored = (await s.read()).stored;
  const files = readdirSync(join(dataDir, 'aura', 'runtime-migration'));
  const report = () => s.get().then((record) => migrationReport(apps, { registry: reg, record, env: legacyEnv, dataDir }));
  const one = await report();
  const two = await report();
  assert.deepEqual(one, two, 'stable across two runs');
  assert.equal((await s.read()).stored, stored, 'no record write');
  assert.deepEqual(readdirSync(join(dataDir, 'aura', 'runtime-migration')), files, 'no report file written');
  assert.equal(one.d75, '2026-11-26T12:00:00.000Z');
  assert.deepEqual(one.reports.map((r) => [r.recordedAt, r.installations, r.counts]),
    [['2026-11-26T12:00:00.000Z', 4, { unchanged: 1, override: 1, incompatible: 2 }]]);
  const by = Object.fromEntries(one.installations.map((r) => [r.appId, r]));
  assert.deepEqual([by['r.c'].decision, by['r.c'].current.runtime, by['r.c'].current.source], ['unchanged', 'container', 'manifest']);
  assert.deepEqual([by['r.o'].decision, by['r.o'].override.source, by['r.o'].current.runtime], ['override', 'migration', 'proot']);
  assert.deepEqual([by['r.d'].pending.reason, by['r.d'].current.error.code], ['master-direct', 'runtime-decision-needed']);
  assert.equal(by['r.cl'].pending.reason, 'closed-on-proot');
  // Before the migration ran: the dry run still classifies, nothing is recorded.
  const fresh = migrationReport(apps, { registry: reg, record: null, env: legacyEnv, dataDir: mkdtempSync(join(TMP, 'none-')) });
  assert.deepEqual([fresh.d75, fresh.reports, fresh.installations.find((r) => r.appId === 'r.o').decision], [null, [], 'override']);
});

test('no existing installation changes runtime without a recorded decision (D75, every legacy case)', async () => {
  // Every manifest shape × source mode × legacy environment the release met.
  const shapes = [{}, { sandbox: 'container' }, { sandbox: 'proot' }, { useProot: false }, { sandbox: 'proot', useProot: false }];
  const envs = [legacyEnv, { useProotEnv: undefined, rootfsPresent: true }, { useProotEnv: 'true', rootfsPresent: false }];
  const legacyId = { container: 'container', 'proot-master': 'proot', 'master-direct': null };
  for (const env of envs) {
    const reg = registry();
    const s = store(reg);
    const apps = [];
    for (const [i, shape] of shapes.entries()) for (const mode of ['open', 'closed']) apps.push(mApp(`n.a${i}.${mode}`, shape, mode));
    await migrateLegacyRuntimes(apps, { store: s, env, dataDir: mkdtempSync(join(TMP, 'n-')) });
    const rec = await s.get();
    for (const a of apps) {
      const before = legacyId[legacyRuntime(a.manifest, env)];
      const now = resolutionOf(reg, a, rec);
      const recorded = Boolean(rec.overrides[a.installationId] || rec.pending?.[a.installationId]);
      const where = `${a.appId} env=${JSON.stringify(env)}`;
      if (now.runtime === before && !now.error) continue; // unchanged and starting
      // Otherwise there must be a recorded decision: an open one (it does not start), or the
      // manifest names the runtime itself (the app's own choice, refused when insecure).
      if (rec.pending?.[a.installationId]) { assert.equal(now.error?.code, 'runtime-decision-needed', where); continue; }
      assert.ok(recorded || a.manifest.sandbox, `${where}: changed from ${before} to ${now.runtime} without a recorded decision`);
      if (!recorded) assert.ok(now.error || now.source === 'manifest', where);
    }
    // Changing the default afterwards moves none of them: they are recorded or name their runtime.
    await s.setDefault('proot');
    const moved = await s.get();
    for (const a of apps) {
      const was = resolutionOf(reg, a, rec);
      const is = resolutionOf(reg, a, moved);
      if (!was.error) assert.equal(is.runtime, was.runtime, `${a.appId}: the default change moved an existing installation`);
    }
  }
});
