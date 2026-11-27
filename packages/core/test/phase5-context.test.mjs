// Phase 5 stream C (Q7, D56): only declared AND granted Context keys reach an
// app; personal keys from its user's vault first; the Phase 5 migration.
// GrantStore runs against a real valkey-server; the system Context and the
// vault are in-memory fakes (no values ever leave the test).
import { test, after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { kvServer, createRedis } from '@aura/kv-store';
import {
  GrantStore, GrantError, CONTEXT_READ_PERMISSION_RE, contextReadPermission, credentialReadPermission, userScope,
  isPrivilegedPermission, grantedContextEnv, grantedContextValue, appGrantCounts, liveGrantedContextDeps,
  computePermissionDiff,
} from '../dist/index.js';
import { migratePhase5Context, PHASE5_CONTEXT_MIGRATION } from '../dist/context/migratePhase5.js';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'aura-p5c-'));
let redis;
let grants;
before(async () => {
  const uri = await kvServer.start({ dataDir: join(DATA_DIR, 'kv') });
  redis = createRedis(uri);
});
beforeEach(async () => {
  await redis.flushall();
  grants = new GrantStore(() => redis);
});
after(async () => {
  redis?.disconnect();
  await kvServer.stop();
});

const by = { kind: 'system' };
const APP = 'io.test.reader';
const OTHER = 'io.test.counter';

/** System Context fake: key → { value, inject }. */
function systemStore(entries) {
  return {
    entries,
    async resolveEnv(keys) {
      const out = {};
      for (const k of keys) if (entries[k]?.inject.includes('env')) out[k] = entries[k].value;
      return out;
    },
    async get(key) { return entries[key]?.value ?? null; },
    async list() {
      return Object.entries(entries).map(([key, e]) => ({ key, kind: e.kind ?? 'secret', inject: [...e.inject], updatedAt: 1, value: null }));
    },
    async set(key, value, kind, inject) { entries[key] = { value, kind, inject: [...inject] }; },
  };
}
/** Vault fake: userId → name → value. */
function vaultFake(data = {}) {
  const reveals = [];
  return {
    data, reveals,
    async reveal(userId, name, appId) { reveals.push([userId, name, appId]); return data[userId]?.[name] ?? null; },
    async describe(userId, name) { return data[userId]?.[name] !== undefined ? { name } : null; },
    async store(userId, name, value, opts) { (data[userId] ??= {})[name] = value; return { handle: 'cred_x', created: true, consumer: opts.consumer }; },
  };
}
function deps({ system = {}, vault = vaultFake(), scopes = { [APP]: 'global', [OTHER]: 'system', 'com.aura.terminal': 'system' } } = {}) {
  const audits = [];
  const store = systemStore(system);
  return {
    audits, store, vault,
    d: liveGrantedContextDeps({ grants, appBinding: async (a) => ({ scope: scopes[a], installationId: scopes[a] ? 'inst-1' : null }), store, vault, audit: async (e) => { audits.push(e); } }),
  };
}

test('context.read:<KEY> is a privileged, app-only, OS-wide permission', async () => {
  assert.ok(CONTEXT_READ_PERMISSION_RE.test('context.read:GEMINI_API_KEY'));
  assert.ok(!CONTEXT_READ_PERMISSION_RE.test('context.read:lower'));
  assert.ok(isPrivilegedPermission(contextReadPermission('X')));
  await grants.grant({ kind: 'app', id: APP }, contextReadPermission('X'), { by, appScope: 'global', installationId: 'inst-1' });
  await assert.rejects(grants.grant({ kind: 'apiKey', id: 'k1' }, contextReadPermission('X'), { by }), GrantError);
  await assert.rejects(grants.grant({ kind: 'app', id: APP }, contextReadPermission('X'), { by, scope: userScope('default') }), GrantError);
});

test('an app without a grant sees no key; undeclared keys never reach it', async () => {
  const { d } = deps({ system: { A_KEY: { value: 'a', inject: ['env'] }, B_KEY: { value: 'b', inject: ['env', 'file'] } } });
  // Nothing declared (Counter): nothing, whatever is granted.
  await grants.grant({ kind: 'app', id: OTHER }, contextReadPermission('A_KEY'), { by, appScope: 'system', installationId: 'inst-1' });
  assert.deepEqual((await grantedContextEnv({ appId: OTHER, declared: [] }, d)).env, {});
  // Declared, not granted: nothing.
  assert.deepEqual((await grantedContextEnv({ appId: APP, declared: ['A_KEY', 'B_KEY'] }, d)).env, {});
  // Declared and granted: exactly that key.
  await grants.grant({ kind: 'app', id: APP }, contextReadPermission('A_KEY'), { by, appScope: 'global', installationId: 'inst-1' });
  const r = await grantedContextEnv({ appId: APP, declared: ['A_KEY', 'B_KEY'] }, d);
  assert.deepEqual(r.env, { A_KEY: 'a' });
  assert.deepEqual(r.sources, { A_KEY: 'system' });
});

test('a granted key not injected as env stays out of the env; context.get still answers', async () => {
  const { d } = deps({ system: { OS_ONLY: { value: 'o', inject: [] }, FILE_ONLY: { value: 'f', inject: ['file'] } } });
  for (const k of ['OS_ONLY', 'FILE_ONLY']) await grants.grant({ kind: 'app', id: APP }, contextReadPermission(k), { by, appScope: 'global', installationId: 'inst-1' });
  assert.deepEqual((await grantedContextEnv({ appId: APP, declared: ['OS_ONLY', 'FILE_ONLY'] }, d)).env, {});
  assert.deepEqual(await grantedContextValue({ appId: APP, declared: ['OS_ONLY'], key: 'OS_ONLY' }, d), { value: 'o', source: 'system' });
});

test('context.get refusals: undeclared, not granted, not set', async () => {
  const { d } = deps({ system: { A_KEY: { value: 'a', inject: ['env'] } } });
  assert.deepEqual(await grantedContextValue({ appId: APP, declared: [], key: 'A_KEY' }, d), { refused: 'undeclared' });
  assert.deepEqual(await grantedContextValue({ appId: APP, declared: ['A_KEY'], key: 'A_KEY' }, d), { refused: 'not-granted' });
  await grants.grant({ kind: 'app', id: APP }, contextReadPermission('MISSING'), { by, appScope: 'global', installationId: 'inst-1' });
  assert.deepEqual(await grantedContextValue({ appId: APP, declared: ['MISSING'], key: 'MISSING' }, d), { refused: 'not-set' });
});

test('a grant counts only for the install scope it was given for', async () => {
  const { d } = deps({ system: { A_KEY: { value: 'a', inject: ['env'] } }, scopes: { [APP]: 'user' } });
  await grants.grant({ kind: 'app', id: APP }, contextReadPermission('A_KEY'), { by, appScope: 'global', installationId: 'inst-1' });
  assert.deepEqual((await grantedContextEnv({ appId: APP, declared: ['A_KEY'] }, d)).env, {}, 'a user-scope copy shadowing the global app');
  assert.equal(appGrantCounts({ appScope: 'global', installationId: 'inst-1' }, { scope: 'global', installationId: 'inst-1' }), true);
  assert.equal(appGrantCounts(null, { scope: 'global', installationId: 'inst-1' }), false);
});

test('personal keys: the user\'s vault first (audited), then the system Context; per user', async () => {
  const vault = vaultFake({ default: { REG_PASS: 'owner-v' }, bob: {} });
  const { d, audits } = deps({ system: { REG_PASS: { value: 'sys-v', inject: ['env'] } }, vault });
  await grants.grant({ kind: 'app', id: 'com.aura.terminal' }, credentialReadPermission('REG_PASS'), { by, scope: userScope('default'), appScope: 'system', installationId: 'inst-1' });
  const owner = await grantedContextEnv({ appId: 'com.aura.terminal', declared: ['REG_PASS'], userId: 'default', instanceId: 'com.aura.terminal-1' }, d);
  assert.deepEqual(owner.env, { REG_PASS: 'owner-v' });
  assert.deepEqual(owner.sources, { REG_PASS: 'vault' });
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'vault.read');
  assert.deepEqual(audits[0].detail, { name: 'REG_PASS', app: 'com.aura.terminal', instance: 'com.aura.terminal-1', user: 'default', via: 'spawn-env' });
  assert.ok(!JSON.stringify(audits).includes('owner-v'), 'no value in the audit');
  // Another user (no raw-read grant in their vault, no system grant): nothing.
  assert.deepEqual((await grantedContextEnv({ appId: 'com.aura.terminal', declared: ['REG_PASS'], userId: 'bob' }, d)).env, {});
  // No user (a pool member warmed for nobody): the vault is not asked.
  assert.deepEqual((await grantedContextEnv({ appId: 'com.aura.terminal', declared: ['REG_PASS'] }, d)).env, {});
  // An undeclared vault key is never read, grant or not.
  assert.deepEqual((await grantedContextValue({ appId: 'com.aura.terminal', declared: [], userId: 'default', key: 'REG_PASS' }, d)), { refused: 'undeclared' });
});

test('install and update diffs name the Context keys', () => {
  const base = { id: APP, name: 'R', version: '1', tools: [], permissions: [] };
  const diff = computePermissionDiff({ ...base, context: ['A_KEY', 'OLD'] }, { ...base, version: '2', context: ['A_KEY', 'NEW_KEY'] });
  assert.deepEqual(diff.contextAdded, ['NEW_KEY']);
  assert.deepEqual(diff.contextRemoved, ['OLD']);
  assert.deepEqual(computePermissionDiff(null, { ...base, context: ['A_KEY'] }).contextAdded, ['A_KEY']);
});

// ── the migration ──────────────────────────────────────────────────────────

function migrationFixture(over = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'aura-p5c-mig-'));
  const system = {
    GEMINI_API_KEY: { value: 'g', kind: 'secret', inject: ['env', 'file'] },
    LAKNERIO_REGISTRY_USER: { value: 'u', kind: 'variable', inject: ['env'] },
    LAKNERIO_REGISTRY_PASSWORD: { value: 'p', kind: 'secret', inject: ['env'] },
    HELLO: { value: 'h', kind: 'variable', inject: ['env'] },
    NEXUS_SRC_LAKNER_IO_PASSWORD: { value: 'n', kind: 'secret', inject: [] },
    GITHUB_TOKEN: { value: 't', kind: 'secret', inject: ['env'] },
  };
  const store = systemStore(system);
  const vault = vaultFake();
  const audits = [];
  const rawKv = {
    async list(ns) { return ns === 'context:system' ? Object.keys(system) : []; },
    async get(ns, key) { return ns === 'context:system' ? { value: { kind: 'secret', sealed: `sealed(${key})`, inject: system[key].inject } } : null; },
    async set() {}, async del() { return false; },
  };
  const apps = [
    { appId: 'io.lakner.callgemini', scope: 'global', dir: '/x', installationId: 'inst-1', context: ['GEMINI_API_KEY'] },
    { appId: 'io.lakner.callgemini.copy', scope: 'global', dir: '/y', installationId: 'inst-1', context: ['GEMINI_API_KEY'] },
    { appId: 'com.aura.terminal', scope: 'system', dir: '/t', installationId: 'inst-1', context: ['LAKNERIO_REGISTRY_USER', 'LAKNERIO_REGISTRY_PASSWORD'] },
    { appId: 'com.aura.counter', scope: 'system', dir: '/c', installationId: 'inst-1', context: [] },
    { appId: 'io.lakner.gh', scope: 'global', dir: '/g', installationId: 'inst-1', context: [] },
  ];
  const d = {
    dataDir, kv: () => rawKv, store, vault, grants, apps: () => apps,
    scan: (app) => (app.appId === 'io.lakner.gh'
      ? [{ file: 'a.ts', line: 1, severity: 'warn', code: 'context-raw', message: 'reads the Context key GITHUB_TOKEN from the env without declaring it: …' }]
      : []),
    audit: async (e) => { audits.push(e); },
    now: () => new Date('2026-11-26T12:00:00Z'),
    ...over,
  };
  return { d, system, vault, audits, dataDir };
}

test('migration: continuity grants, owner keys to the vault, test keys injected nowhere, a report, no value lost', async () => {
  const { d, system, vault, audits, dataDir } = migrationFixture();
  const r = await migratePhase5Context(d);
  assert.equal(r.ran, true);
  // 1. CallGemini and its copy keep GEMINI_API_KEY.
  for (const id of ['io.lakner.callgemini', 'io.lakner.callgemini.copy']) {
    const g = await grants.get({ kind: 'app', id }, contextReadPermission('GEMINI_API_KEY'));
    assert.equal(g.appScope, 'global');
  }
  // 2. LAKNERIO_* in the owner's vault, the Terminal's raw-read grant, the system copy kept but injected nowhere.
  assert.deepEqual(vault.data.default, { LAKNERIO_REGISTRY_USER: 'u', LAKNERIO_REGISTRY_PASSWORD: 'p' });
  for (const k of ['LAKNERIO_REGISTRY_USER', 'LAKNERIO_REGISTRY_PASSWORD']) {
    assert.ok(await grants.get({ kind: 'app', id: 'com.aura.terminal' }, credentialReadPermission(k), userScope('default')));
    assert.deepEqual(system[k].inject, []);
    assert.equal(system[k].value, k.endsWith('USER') ? 'u' : 'p', 'the system copy stays for one release');
  }
  // 3. / 4.
  assert.deepEqual(system.HELLO.inject, []);
  assert.deepEqual(system.NEXUS_SRC_LAKNER_IO_PASSWORD.inject, []);
  assert.deepEqual(system.GEMINI_API_KEY.inject, ['env', 'file'], 'untouched');
  // Who gets what now, and who loses something.
  const row = (k) => r.rows.find((x) => x.key === k);
  assert.deepEqual(row('GEMINI_API_KEY').reachesAfter, ['io.lakner.callgemini', 'io.lakner.callgemini.copy']);
  assert.deepEqual(row('LAKNERIO_REGISTRY_PASSWORD').reachesAfter, ['com.aura.terminal']);
  assert.deepEqual(row('GITHUB_TOKEN').reachesAfter, []);
  assert.equal(row('GITHUB_TOKEN').reachedBefore, 'every app');
  assert.deepEqual(r.losers, [{ appId: 'io.lakner.gh', keys: ['GITHUB_TOKEN'], findings: 1 }]);
  // Backup first, 0600 in a 0700 dir, sealed rows only; the report holds no value.
  const dir = join(dataDir, 'aura', 'context-migration');
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  const report = readFileSync(r.reportFile, 'utf-8');
  assert.equal(statSync(r.reportFile).mode & 0o777, 0o600);
  const backupFile = JSON.parse(report).backup;
  assert.ok(existsSync(backupFile));
  assert.equal(statSync(backupFile).mode & 0o777, 0o600);
  assert.match(readFileSync(backupFile, 'utf-8'), /sealed\(LAKNERIO_REGISTRY_PASSWORD\)/);
  for (const v of ['"u"', '"p"', '"g"', '"t"']) {
    assert.ok(!report.includes(`: ${v}`), `no plaintext ${v} in the report`);
    assert.ok(!readFileSync(backupFile, 'utf-8').includes(`: ${v}`), `no plaintext ${v} in the backup`);
  }
  assert.ok(audits.some((a) => a.action === 'context.migration-recorded'));
  assert.ok(audits.some((a) => a.action === 'vault.read-granted' && a.detail.app === 'com.aura.terminal'));
  // Idempotent: a second run changes nothing.
  const again = await migratePhase5Context(d);
  assert.equal(again.ran, false);
});

test('migration: an owner vault entry that exists is kept; missing apps and keys are skipped', async () => {
  const { d, vault } = migrationFixture();
  vault.data.default = { LAKNERIO_REGISTRY_USER: 'already' };
  const r = await migratePhase5Context({ ...d, apps: () => [{ appId: 'com.aura.terminal', scope: 'system', dir: '/t', installationId: 'inst-1', context: ['LAKNERIO_REGISTRY_USER'] }] });
  assert.equal(vault.data.default.LAKNERIO_REGISTRY_USER, 'already');
  assert.match(r.rows.find((x) => x.key === 'LAKNERIO_REGISTRY_USER').detail, /already holds it/);
  assert.equal(await grants.get({ kind: 'app', id: 'io.lakner.callgemini' }, contextReadPermission('GEMINI_API_KEY')), null);
  assert.ok(PHASE5_CONTEXT_MIGRATION.continuity.length > 0);
});

test("5-main (D97): the kernel gets the migration's source scanner from the composition point; without one the migration waits", async () => {
  const { AppManager } = await import("../dist/app-manager/AppManager.js");
  // No scanner: nothing is read or recorded (the report would miss source readers for good).
  const fake = { contractScan: null, dataDir: "/nonexistent", registry: { getAll() { throw new Error("must not run"); } } };
  await AppManager.prototype.migrateContext.call(fake);
  // The composition root (bootSystem, Phase 6 K) hands it in; core's app-manager never imports the contract module,
  // only its leaf contract file (contract/types.ts: the contract majors, Phase 6 G; it imports nothing).
  const root = readFileSync(new URL("../src/system/bootstrap.ts", import.meta.url), "utf8");
  assert.match(root, /contractScan: scanContractSources/);
  const am = readFileSync(new URL("../src/app-manager/AppManager.ts", import.meta.url), "utf8");
  assert.doesNotMatch(am, /from '\.\.\/contract\/(?!types\.js')/);
  assert.ok(existsSync(new URL("../dist/capabilities/tool-allowlist.js", import.meta.url)), "tool-allowlist lives in capabilities");
});
