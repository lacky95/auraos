// Phase 5b streams K and Q: the ARI contract and the one requirements
// derivation. The ARI refusal (version, id, descriptor), module registration
// in AppManager (refused modules are not loaded, never fatal), the settings
// migration (success, failure -> disabled with an error and reported once,
// never guessed values), `requirementsOf()` (one row per rule, JSON
// round-trip, A4 reasons, A6 notes), `requestNeeds()`, `suggest` (D73), the
// exhaustive capability list, and the mandatory workload token as a type.
// Run via: node tools/run-tests.mjs --only=core

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ARI_VERSION, ariRefusal, healthRefusal, HEALTHY, RuntimeRegistry, RuntimeSettingsStore, RuntimeModuleError, RuntimeCapabilityError,
  builtInRuntimeRecord, requirementsOf, requestNeeds, REQUEST_KINDS, homeRequirements, runtimeRefusal, suggestText,
  RUNTIME_CAPABILITY_KEYS, RUNTIME_BOOLEAN_CAPABILITIES, missingCapabilities, BUILTIN_RUNTIMES, RUNTIME_AUDIT_ACTIONS,
  securityOption,
} from '../dist/index.js';
import { containerRuntime } from '../dist/runtimes/container/index.js';
import { prootRuntime } from '../dist/runtimes/proot/index.js';
import { AppManifestSchema } from '../dist/types/manifest.js';
import { AppManager } from '../dist/app-manager/AppManager.js';
import { ContainerRunner } from '../dist/app-manager/ContainerRunner.js';
import { ProotRunner } from '../dist/app-manager/ProotRunner.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP = mkdtempSync(join(tmpdir(), 'aura-ari-'));
const ROOTFS = join(TMP, 'rootfs');
mkdirSync(ROOTFS);

const CONTAINER_CAPS = ContainerRunner.prototype.capabilities.call({});
const PROOT_CAPS = ProotRunner.prototype.capabilities.call({});
/** A test module with no capability groups declares none of their features (5b CR: groups ⇔ features). */
const NO_GROUP_CAPS = { ...CONTAINER_CAPS, survivesShellRestart: false, sessionExec: false, sidecars: false, usage: false, hostFilesystem: false, portExpose: false, mounts: false };
const runner = (caps) => ({ capabilities: () => caps, getHost: () => null, getPort: () => null });
const app = (extra = {}) => AppManifestSchema.parse({ id: 'org.k.app', name: 'K', version: '1.0.0', ...extra });

function registry(opts) {
  const r = new RuntimeRegistry(opts);
  r.register(containerRuntime(runner(CONTAINER_CAPS)));
  r.register(prootRuntime(runner(PROOT_CAPS), { baseRootfs: ROOTFS, env: { AURA_USE_PROOT: 'true' } }));
  return r;
}

/** A module whose settings schema is at version 2 (`slots` was `count` at version 1). */
function versioned(migrate = (from, raw) => { if (from !== 1) throw new Error(`unknown version ${from}`); return { slots: raw.count }; }) {
  return {
    descriptor: { id: 'vers', version: '2.0.0', ari: 1, title: 'V', description: 'v', builtIn: false, settingsVersion: 2,
      settingsSchema: { type: 'object', properties: { slots: { type: 'integer', title: 'Slots', minimum: 1, default: 1 } } } },
    runner: runner(NO_GROUP_CAPS), capabilities: () => NO_GROUP_CAPS, health: () => HEALTHY, endpoint: () => null,
    ...(migrate ? { migrateSettings: migrate } : {}),
  };
}

function memoryRedis() {
  const data = new Map();
  return {
    get: async (k) => data.get(k) ?? null,
    set: async (k, v, nx) => { if (nx === 'NX' && data.has(k)) return null; data.set(k, v); return 'OK'; },
    eval: async (_s, _n, k, expected, next) => { if (data.get(k) !== expected) return 0; data.set(k, next); return 1; },
  };
}

// ── descriptor and the ARI refusal ──────────────────────────────────────────

test('ARI refusal: a newer ARI, a bad id, a non-semver version or a missing settings version; codes, never loaded', () => {
  const ok = { id: 'good', version: '1.0.0', ari: ARI_VERSION, settingsVersion: 1 };
  assert.equal(ariRefusal(ok), null);
  const newer = ariRefusal({ ...ok, ari: ARI_VERSION + 1 });
  assert.ok(newer instanceof RuntimeModuleError);
  assert.equal(newer.code, 'ari-unsupported');
  assert.equal(newer.message, `runtime good needs ARI ${ARI_VERSION + 1} (this AuraOS implements ARI ${ARI_VERSION})`);
  assert.equal(ariRefusal({ ...ok, id: 'Bad_Id' })?.code, 'invalid-runtime-id');
  assert.equal(ariRefusal({ ...ok, version: 'latest' })?.code, 'invalid-descriptor');
  assert.equal(ariRefusal({ ...ok, settingsVersion: 0 })?.code, 'invalid-descriptor');
  assert.equal(ariRefusal({ ...ok, ari: 0 })?.code, 'invalid-descriptor');
  const reg = registry();
  assert.throws(() => reg.register(containerRuntime(runner(CONTAINER_CAPS))), (e) => e.code === 'runtime-duplicate' && /already registered/.test(e.message));
  assert.deepEqual(runtimeRefusal(newer), { code: 'ari-unsupported', category: 'unsupported-operation', message: newer.message, runtime: 'good' });
});

test('BUILTIN_RUNTIMES: container and proot, each with version, ari and settings version; AppManager registers exactly these', () => {
  assert.deepEqual(BUILTIN_RUNTIMES.map((b) => b.id), ['container', 'proot']);
  const dataDir = mkdtempSync(join(TMP, 'mgr-'));
  const future = { ...versioned(), descriptor: { ...versioned().descriptor, id: 'future', ari: ARI_VERSION + 1 } };
  const mgr = new AppManager({ appsDir: join(dataDir, 'apps'), dataDir, baseRootfs: ROOTFS, toolchainDir: join(dataDir, 'tc'), runtimes: [future] });
  assert.deepEqual(mgr.runtimes.list().map((m) => m.descriptor.id), ['container', 'proot'], 'a refused module is not loaded, and the kernel still starts');
  for (const m of mgr.runtimes.list()) assert.equal(ariRefusal(m.descriptor), null, m.descriptor.id);
  assert.throws(() => mgr.runtimes.require('future'), (e) => e.code === 'runtime-not-installed');
  assert.equal(RUNTIME_AUDIT_ACTIONS.moduleRefused, 'runtime.module-refused');
});

// ── capabilities ────────────────────────────────────────────────────────────

test('the capability set: one exhaustive key list; the built-ins declare every key; network informational', () => {
  assert.deepEqual([...RUNTIME_CAPABILITY_KEYS].sort(), Object.keys(CONTAINER_CAPS).sort());
  assert.deepEqual(Object.keys(PROOT_CAPS).sort(), Object.keys(CONTAINER_CAPS).sort());
  assert.ok(!RUNTIME_BOOLEAN_CAPABILITIES.includes('network') && !RUNTIME_BOOLEAN_CAPABILITIES.includes('identity'));
  // A4 and D80 as declared: every built-in binds host paths; no idmapped mounts before 5b G's probe; gpu reserved.
  for (const caps of [CONTAINER_CAPS, PROOT_CAPS, ProotRunner.prototype.capabilities.call({}, { placement: 'pool' })]) {
    assert.equal(caps.hostFilesystem, true);
    assert.equal(caps.idmappedMounts, false);
    assert.equal(caps.gpu, false);
  }
  assert.deepEqual([CONTAINER_CAPS.network, PROOT_CAPS.network, ProotRunner.prototype.capabilities.call({}, { placement: 'pool' }).network],
    ['bridge', 'shell-netns', 'bridge']);
  assert.deepEqual([CONTAINER_CAPS.usage, PROOT_CAPS.usage], [true, false]);
  assert.deepEqual(missingCapabilities(PROOT_CAPS, { network: 'remote' }), [], 'nothing fails on network in 5b');
});

// ── settings migration (ARI §4.3) ───────────────────────────────────────────

test('settings migration: an older version is migrated on read; a failure disables the runtime with an error, reported once', () => {
  const reported = [];
  const reg = new RuntimeRegistry({ onSettingsInvalid: (id, reason) => reported.push([id, reason]) });
  reg.register(versioned());
  const base = { v: 1, default: 'vers', enabled: ['vers'], overrides: {} };
  const ok = reg.settingsState('vers', { ...base, settings: { vers: { count: 3 } }, settingsVersions: { vers: 1 } });
  assert.deepEqual(ok, { ok: true, settings: { slots: 3 }, migratedFrom: 1 });
  assert.deepEqual(reg.settingsState('vers', { ...base, settings: { vers: { slots: 2 } }, settingsVersions: { vers: 2 } }), { ok: true, settings: { slots: 2 } });
  assert.deepEqual(reg.settingsState('vers', { ...base, settings: {} }), { ok: true, settings: { slots: 1 } }, 'nothing stored: the defaults');

  // Version 1 without `count`: the migration yields an invalid value. Never the defaults.
  const bad = { ...base, settings: { vers: { count: 0 } } };
  const state = reg.settingsState('vers', bad);
  assert.equal(state.ok, false);
  assert.match(state.reason, /settings failed to migrate/);
  assert.equal(reg.healthOf('vers', bad).status, 'unavailable');
  assert.match(healthRefusal(reg.healthOf('vers', bad)), /settings failed to migrate/);
  assert.throws(() => reg.resolve({ manifest: { id: 'org.k.app', sandbox: 'vers' }, installationId: 'i', sourceMode: 'open', record: bad }),
    (e) => e.code === 'runtime-disabled' && /runtime vers is disabled: its settings failed to migrate/.test(e.message));
  assert.throws(() => reg.settingsOf('vers', bad), (e) => e.code === 'runtime-disabled');
  assert.equal(reported.length, 1, 'reported once, however often it is read');
  assert.equal(reported[0][0], 'vers');

  // Settings written by a newer module (a rollback), and a module without a migration: disabled too.
  assert.equal(reg.settingsState('vers', { ...base, settings: { vers: { slots: 2 } }, settingsVersions: { vers: 3 } }).ok, false);
  const noMig = new RuntimeRegistry();
  noMig.register(versioned(null));
  assert.equal(noMig.settingsState('vers', { ...base, settings: { vers: { count: 1 } } }).ok, false);
});

test('settings migration: an owner write replaces failed settings and records the module\'s settings version', async () => {
  const reg = new RuntimeRegistry();
  reg.register(containerRuntime(runner(CONTAINER_CAPS)));
  reg.register(versioned());
  const dir = mkdtempSync(join(TMP, 'key-'));
  const kv = memoryRedis();
  const s = new RuntimeSettingsStore({ identityKeyFile: join(dir, 'identity.key'), redis: () => kv, registry: reg });
  const r = await s.update((cur) => ({ next: { ...cur, enabled: [...cur.enabled, 'vers'], settings: { ...cur.settings, vers: { count: 0 } }, settingsVersions: { vers: 1 } } }));
  assert.ok(r.ok);
  assert.equal(reg.settingsState('vers', await s.get()).ok, false);
  const w = await s.setSettings('vers', { slots: 4 });
  assert.ok(w.ok);
  assert.deepEqual(w.record.settings.vers, { slots: 4 });
  assert.equal(w.record.settingsVersions.vers, 2);
  assert.deepEqual(reg.settingsOf('vers', await s.get()), { slots: 4 });
});

// ── requirementsOf (A5), A4, A6 ─────────────────────────────────────────────

test('requirementsOf: the derivation table, one row per rule', () => {
  const rows = [
    [{}, undefined, []],
    [{ services: [{ name: 'db', image: 'redis:7' }] }, undefined, ['sidecars']],
    [{ ports: { exposes: [{ sourceApp: 'org.k.src', sourcePort: 80 }] } }, undefined, ['portExpose']],
    [{ warmPool: 2 }, undefined, ['warmPool']],
    [{ permissions: ['apps.mount'] }, undefined, ['hostFilesystem', 'mounts']],
    [{ tools: ['docker'] }, undefined, ['hostFilesystem']],
    [{ ports: { hostPublish: [{ port: 8080 }] } }, undefined, ['hostFilesystem']],
    [{ services: [{ name: 's', image: 'x', inheritDockerSocket: true }] }, undefined, ['hostFilesystem', 'sidecars']],
    [{ services: [{ name: 's', image: 'x', devices: ['/dev/fuse'] }] }, undefined, ['hostFilesystem', 'sidecars']],
    [{ services: [{ name: 's', image: 'x', privileged: true }] }, undefined, ['hostFilesystem', 'sidecars']],
    [{ services: [{ name: 's', image: 'x', publish: [{ host: 9000, container: 90 }] }] }, undefined, ['hostFilesystem', 'sidecars']],
    [{}, { sourceMode: 'closed' }, ['readOnlyBinds']],
    [{}, { sourceMode: 'open', runAs: 'app' }, []],
  ];
  for (const [extra, inst, want] of rows) {
    const r = requirementsOf(app(extra), inst);
    assert.deepEqual(r.capabilities, want, JSON.stringify(extra));
    for (const k of want) assert.ok(r.needs[k] === true, k);
    assert.equal(r.hostFilesystem.needed, want.includes('hostFilesystem'));
  }
  const r = requirementsOf(app({ tools: ['docker'], permissions: ['apps.mount'], ports: { hostPublish: [{ port: 80 }] },
    services: [{ name: 'db', image: 'x', inheritDockerSocket: true, privileged: true }] }));
  assert.deepEqual(r.hostFilesystem.because, ['tools: docker', 'permissions: apps.mount', 'ports.hostPublish', 'services[db].inheritDockerSocket', 'services[db].privileged']);
  assert.equal(r.installation, undefined);
  assert.deepEqual(requirementsOf(app(), { sourceMode: 'open' }).installation, { runAs: 'root', sourceMode: 'open' });
});

test('requirementsOf: plain, JSON-serializable data; ports, context, consumes and the A6 notes (informational)', () => {
  const m = app({
    services: [{ name: 'db', image: 'x', dns: ['1.1.1.1'], restart: 'always', publish: [{ host: 9000, container: 90 }] }],
    ports: { exposes: [{ sourceApp: 'org.k.src', sourcePort: 80 }], hostPublish: [{ port: 8080, hostPort: 18080 }] },
    context: ['API_KEY'], consumes: [{ name: 'notes', kind: 'mcp' }],
  });
  const r = requirementsOf(m, { sourceMode: 'closed', runAs: 'app' });
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
  assert.deepEqual(r.sidecars, ['db']);
  assert.deepEqual(r.ports, { exposes: ['org.k.src:80'], hostPublish: [8080] });
  assert.deepEqual(r.contextKeys, ['API_KEY']);
  assert.deepEqual(r.consumes, ['http/mcp:notes']);
  assert.deepEqual(r.notes.map((n) => n.field).sort(),
    ['ports.hostPublish[0].hostPort', 'services[db].dns', 'services[db].publish', 'services[db].restart'].sort());
  // The schema defaults (dns [], restart unless-stopped) are no note.
  assert.deepEqual(requirementsOf(app({ services: [{ name: 'db', image: 'x' }] })).notes, []);
});

test('requestNeeds: one table for request needs; the Home Resolver and the check API use it', () => {
  assert.deepEqual(requestNeeds('jump'), { sessionExec: true, privateHomeSession: true });
  assert.deepEqual(requestNeeds('jump', { jumpHomeMode: 'app' }), { sessionExec: true });
  assert.deepEqual(requestNeeds('home-ephemeral'), { sessionExec: true, privateHomeSession: true });
  assert.deepEqual(requestNeeds('home-app'), { sessionExec: true });
  assert.deepEqual(requestNeeds('terminal-session'), { isolation: 'namespace' });
  assert.deepEqual(requestNeeds('idmap-mount'), { mounts: true, idmappedMounts: true });
  assert.deepEqual(requestNeeds('host-filesystem'), { hostFilesystem: true });
  for (const k of REQUEST_KINDS) assert.equal(typeof requestNeeds(k), 'object', k);
  for (const mode of ['private', 'app', 'ephemeral']) {
    assert.deepEqual(homeRequirements({ executionContext: 'jump', jumpHomeMode: mode }).capabilities, requestNeeds('jump', { jumpHomeMode: mode }));
  }
  assert.deepEqual(homeRequirements({ executionContext: 'terminal-session' }).capabilities, { isolation: 'namespace' });
  assert.deepEqual(homeRequirements({ executionContext: 'application' }).capabilities, {});
});

// ── suggest (D73) ───────────────────────────────────────────────────────────

test('suggest: a sidecar app on PRoot names sidecars and suggests container; nothing is picked', () => {
  const reg = registry();
  const rec = builtInRuntimeRecord(reg);
  let err;
  try { reg.resolve({ manifest: app({ sandbox: 'proot', services: [{ name: 'db', image: 'redis:7' }] }), installationId: 'i', sourceMode: 'open', record: rec }); }
  catch (e) { err = e; }
  assert.ok(err instanceof RuntimeCapabilityError);
  assert.deepEqual(err.missing, ['sidecars']);
  assert.deepEqual(err.suggest, ['container']);
  assert.match(err.message, /it could run on: container$/);
  assert.deepEqual(runtimeRefusal(err), { code: 'capability-missing', category: 'unsupported-feature', message: err.message, runtime: 'proot', missing: ['sidecars'], suggest: ['container'] });
  // Nothing can: the message says so. A disabled runtime is never suggested.
  assert.deepEqual(reg.suggest({ gpu: true }, rec), []);
  assert.equal(suggestText([]), '; no installed runtime can run it');
  assert.deepEqual(reg.suggest({ readOnlyBinds: true }, { ...rec, enabled: [] }), ['container'], 'container is always enabled');
  assert.deepEqual(reg.suggest({ warmPool: true }, { ...rec, enabled: ['container'] }), ['container'], 'a disabled proot is not suggested');
});

// ── D64 ─────────────────────────────────────────────────────────────────────

test('D64: the runtime switches are in the registry (proot-host env, runtime-install reserved)', () => {
  assert.equal(securityOption('proot-host')?.env, 'AURA_USE_PROOT');
  assert.equal(securityOption('runtime-install')?.source, 'reserved');
  assert.equal(securityOption('runtimes')?.source, 'record');
});

// ── D89: the workload token is mandatory, as a type ─────────────────────────

test('D89: a spawn context or spec without instanceToken does not compile', () => {
  const dir = mkdtempSync(join(HERE, '..', '.ari-typetest-'));
  const file = join(dir, 'spec.ts');
  writeFileSync(file, [
    "import type { SpawnContext, SpawnSpec } from '../dist/index.js';",
    "export const ok: SpawnContext = { appDir: '/a', instanceDataDir: '/d', instanceToken: { token: 't', nonce: 'n' } };",
    "// @ts-expect-error instanceToken is mandatory (D89)",
    "export const noToken: SpawnContext = { appDir: '/a', instanceDataDir: '/d' };",
    "// @ts-expect-error instanceToken is mandatory (D89)",
    "export const spec: SpawnSpec = { ...({} as Omit<SpawnSpec, 'instanceToken'>) };",
  ].join('\n'));
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  try {
    const r = spawnSync(process.execPath, [tsc, '--noEmit', '--strict', '--skipLibCheck', '--module', 'ESNext', '--moduleResolution', 'bundler',
      '--target', 'ES2022', file], { encoding: 'utf-8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── D100 K addendum: features, error categories, operation results ──────────

test('D100 §12: featuresOf is one derived table over every feature id; overrides refine it', async () => {
  const { featuresOf, RUNTIME_FEATURE_IDS } = await import('../dist/index.js');
  const caps = ContainerRunner.prototype.capabilities.call({});
  const fs = featuresOf(caps);
  assert.equal(fs.length, RUNTIME_FEATURE_IDS.length);
  assert.equal(fs.find((f) => f.id === 'instance.adoption').support, 'supported');
  assert.equal(fs.find((f) => f.id === 'mount.live').applyMode, 'live');
  const prootFs = featuresOf(ProotRunner.prototype.capabilities.call({}, {}));
  assert.equal(prootFs.find((f) => f.id === 'instance.adoption').support, 'unsupported');
  assert.equal(prootFs.find((f) => f.id === 'workload.dynamic').support, 'unsupported');
  const advisory = featuresOf(caps, { 'tools.liveRevoke': { support: 'conditional', constraints: { enforcement: 'advisory' } } });
  assert.deepEqual(advisory.find((f) => f.id === 'tools.liveRevoke'), { id: 'tools.liveRevoke', support: 'conditional', applyMode: 'live', constraints: { enforcement: 'advisory' } });
});

test('D100 §17: every refusal code has exactly one category', async () => {
  const { CATEGORY_OF_CODE } = await import('../dist/index.js');
  const cats = new Set(['unsupported-operation', 'unsupported-feature', 'permission-denied', 'runtime-unavailable', 'instance-not-found',
    'resource-exhausted', 'restart-required', 'recreate-required', 'provisioning-failed', 'enforcement-failed', 'operation-timeout',
    'operation-cancelled', 'conflict']);
  for (const [code, cat] of Object.entries(CATEGORY_OF_CODE)) assert.ok(cats.has(cat), `${code} -> ${cat}`);
  assert.equal(CATEGORY_OF_CODE['runtime-disabled'], 'runtime-unavailable');
});

test('D100 §13: an operation result is plain data with a terminal state and a categorized error', async () => {
  const { operationResult } = await import('../dist/index.js');
  const a = operationResult('tools.liveGrant', { instanceId: 'i-1' }, 'applied', { detail: { mode: 'hardlink' } });
  const b = operationResult('tools.liveGrant', { instanceId: 'i-1' }, 'failed', { error: { code: 'provisioning-failed', message: 'x' } });
  assert.notEqual(a.opId, b.opId);
  assert.deepEqual(JSON.parse(JSON.stringify(b)), b);
  assert.equal(b.error.category, 'provisioning-failed');
});
