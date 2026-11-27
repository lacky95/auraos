// Owner decision 5-main item 3: apps may REQUEST root in their manifest
// (`execution: { runAs: 'root', reason }`); a request is never a grant. The
// manifest validation, the decision (approved / legacy / refused), the
// installation record and its compare-and-set, the Nexus binding and the
// approval it records, update re-approval, "denied -> no start", and that
// root implies no capability, no socket and no host access.
//
// Run via: node tools/run-tests.mjs --only=core

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KvServer, createRedis } from '@aura/kv-store';
import { AppManifestSchema } from '../dist/types/manifest.js';
import {
  executionApproved, executionBinding, executionConfigOf, executionDecision, executionDigest, RootExecutionError,
} from '../dist/identity/execution.js';
import { createAppHostRegistry } from '../dist/app-hosts/AppHostRegistry.js';
import { AppHostLifecycle } from '../dist/app-hosts/lifecycle.js';
import { containerIdentityArgs, sidecarIdentityArgs, requireProotIdentity } from '../dist/runtimes/spawn/identityArgs.js';
import { AppManager, adoptedIdentity } from '../dist/app-manager/AppManager.js';
import { NexusManager } from '../dist/nexus/NexusManager.js';
import { installExposure } from '../dist/nexus/PermissionDiff.js';
import { buildPrivilegeReview } from '../dist/identity/privilegeReview.js';
import { securityOption, securityPolicyValue } from '../dist/security/options.js';
import { exchangeHelper } from './rename-exchange-helper.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'aura-rootreq-'));
const server = new KvServer();
let redis;
const r = () => redis;
before(async () => { redis = createRedis(await server.start({ dataDir: join(TMP, 'kv') })); });
after(async () => { redis?.disconnect(); await server.stop(); rmSync(TMP, { recursive: true, force: true }); });
beforeEach(async () => { await redis.flushdb(); });

const BASE = { id: 'org.r.app', name: 'R', version: '1.0.0' };
const ORIGIN = '7d1e7a52-1c55-4a8e-9e43-6a0e0f1b2c3d';
const parse = (extra) => AppManifestSchema.safeParse({ ...BASE, ...extra });
const issues = (res) => res.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' | ');
const ROOT = { v: 1, runAs: 'root' };
const DIGEST = executionDigest(ROOT);
const SRC = { kind: 'oci', ref: 'reg.example/apps/r:1.0.0' };

// ── the manifest declaration ────────────────────────────────────────────────

test('manifest: execution is a root request with a reason; nothing else fits in it', () => {
  const ok = parse({ execution: { runAs: 'root', reason: 'binds port 80 inside its container' } });
  assert.equal(ok.success, true);
  assert.deepEqual(ok.data.execution, { runAs: 'root', reason: 'binds port 80 inside its container' });
  assert.equal(parse({}).data.execution, undefined, 'absent: no request');
  assert.match(issues(parse({ execution: { runAs: 'root' } })), /execution\.reason/);
  assert.match(issues(parse({ execution: { runAs: 'root', reason: '   ' } })), /say why/);
  assert.match(issues(parse({ execution: { runAs: 'app', reason: 'x' } })), /only 'root' can be requested/);
  for (const extra of [{ privileged: true }, { capabilities: ['SYS_ADMIN'] }, { dockerSocket: true }, { build: 'root' }]) {
    const res = parse({ execution: { runAs: 'root', reason: 'x', ...extra } });
    assert.equal(res.success, false, JSON.stringify(extra));
    assert.match(issues(res), /Root never implies privileged mode, capabilities, devices, the Docker socket or host access/);
  }
  // R2: PRoot runs apps only under their own app identity.
  assert.match(issues(parse({ sandbox: 'proot', execution: { runAs: 'root', reason: 'x' } })), /proot runtime/);
  assert.equal(parse({ sandbox: 'container', execution: { runAs: 'root', reason: 'x' } }).success, true);
});

test('the bound config: digest of the privilege-bearing part only; the reason is display text', () => {
  assert.equal(executionConfigOf({}), null);
  assert.deepEqual(executionConfigOf({ execution: { runAs: 'root', reason: 'a' } }), ROOT);
  assert.match(DIGEST, /^sha256:[0-9a-f]{64}$/);
  assert.equal(executionDigest({ v: 1, runAs: 'root' }), DIGEST, 'deterministic');
  const a = executionBinding({ execution: { runAs: 'root', reason: 'one' } }, null);
  const b = executionBinding({ execution: { runAs: 'root', reason: 'two' } }, null);
  assert.equal(a.digest, b.digest, 'another reason is the same request');
  assert.deepEqual([a.renew, a.reason], [true, 'one']);
  const approved = { runAs: 'root', execution: { runAs: 'root', digest: DIGEST, approvedAt: 1, via: 'nexus.install' } };
  assert.equal(executionBinding({ execution: { runAs: 'root', reason: 'x' } }, approved).renew, false, 'an update that keeps it keeps the approval');
  assert.equal(executionBinding({ execution: { runAs: 'root', reason: 'x' } }, { ...approved, execution: { ...approved.execution, digest: `sha256:${'0'.repeat(64)}` } }).renew, true, 'another config asks again');
  assert.equal(executionBinding({ execution: { runAs: 'root', reason: 'x' } }, { ...approved, runAs: 'app' }).renew, true, 'the owner flipped it to app: asks again');
  assert.equal(executionBinding({}, approved), null);
});

// ── the decision: approved / legacy / refused ───────────────────────────────

test('decision: no approval, a changed request or the policy refuse the start; legacy root stays a migration state', () => {
  const approval = { runAs: 'root', digest: DIGEST, approvedAt: 1, via: 'nexus.install' };
  const d = (config, inst, policy = 'approve') => executionDecision('org.r.app', config, inst, policy);
  assert.deepEqual(d(null, { runAs: 'app' }), { kind: 'app' });
  assert.deepEqual(d(null, { runAs: 'root' }), { kind: 'legacy-root' });
  assert.deepEqual(d(null, {}), { kind: 'legacy-root' }, 'a record from before 5-apps');
  assert.deepEqual(d(ROOT, { runAs: 'root', execution: approval }), { kind: 'approved-root', digest: DIGEST });
  for (const inst of [{ runAs: 'app' }, { runAs: 'root' }, {}, { runAs: 'app', execution: approval }]) {
    const x = d(ROOT, inst);
    assert.equal(x.kind, 'refused', JSON.stringify(inst));
    assert.equal(x.reason, 'not-approved');
    assert.match(x.message, /root execution not approved; not started/);
    assert.match(x.message, /aura admin apps run-as org\.r\.app root/);
  }
  const changed = d(ROOT, { runAs: 'root', execution: { ...approval, digest: `sha256:${'1'.repeat(64)}` } });
  assert.deepEqual([changed.kind, changed.reason], ['refused', 'changed']);
  assert.match(changed.message, /changed since you approved it/);
  const refused = d(ROOT, { runAs: 'root', execution: approval }, 'refuse');
  assert.deepEqual([refused.kind, refused.reason], ['refused', 'policy']);
  assert.match(refused.message, /app-root-execution = refuse/);
  assert.equal(d(null, { runAs: 'root', execution: approval }, 'refuse').kind, 'refused', 'an approved root without a request (owner flip) too');
  assert.equal(d(null, { runAs: 'root' }, 'refuse').kind, 'legacy-root', 'legacy root is the migration, untouched by the switch');
  assert.equal(executionApproved(ROOT, { runAs: 'root', execution: approval }), true);
  const err = new RootExecutionError('org.r.app', 'not-approved', 'm');
  assert.deepEqual([err.code, err.name], ['root-execution-not-approved', 'RootExecutionError']);
});

// ── the installation record ─────────────────────────────────────────────────

test('record: setRunAs records the approved config with root, removes it with app or a legacy rollback, compare-and-set', async () => {
  const reg = createAppHostRegistry(r);
  const inst = await reg.createInstallation({ appId: 'org.r.app', originId: null, scope: 'global', source: SRC, runAs: 'app' });
  const approval = { runAs: 'root', digest: DIGEST, approvedAt: 5, via: 'admin.run-as' };
  await assert.rejects(reg.setRunAs(inst.installationId, 'app', undefined, approval), /invalid execution approval/);
  await assert.rejects(reg.setRunAs(inst.installationId, 'root', undefined, { ...approval, digest: 'nope' }), /invalid execution approval/);
  assert.equal((await reg.setRunAs(inst.installationId, 'root', 'root', approval)).ok, false, 'a stale decision is refused');
  const up = await reg.setRunAs(inst.installationId, 'root', 'app', approval);
  assert.equal(up.ok, true);
  assert.deepEqual((await reg.getInstallation(inst.installationId)).execution, approval);
  const again = await reg.setRunAs(inst.installationId, 'root', 'root', approval);
  assert.equal(again.installation.execution.approvedAt, 5, 'the same approval: unchanged');
  await reg.setRunAs(inst.installationId, 'root', 'root');
  assert.equal((await reg.getInstallation(inst.installationId)).execution, undefined, 'root without an approval: legacy rollback');
  await reg.setRunAs(inst.installationId, 'root', 'root', approval);
  await reg.setRunAs(inst.installationId, 'app', 'root');
  const flipped = await reg.getInstallation(inst.installationId);
  assert.deepEqual([flipped.runAs, flipped.execution], ['app', undefined], 'app removes the approval');
});

test('lifecycle: approveExecution records exactly the approved digest on the active installation, keeps an equal one', async () => {
  const reg = createAppHostRegistry(r);
  const life = new AppHostLifecycle(reg);
  const app = { appId: 'org.r.app', originId: null, scope: 'user', source: SRC };
  await life.sync(app);
  assert.equal((await life.installationOf('org.r.app', 'user')).runAs, 'app', 'a new installation starts as app');
  const rec = await life.approveExecution('org.r.app', 'user', { runAs: 'root', digest: DIGEST, approvedAt: 7, via: 'nexus.install' }, { newRecord: true });
  assert.deepEqual([rec.runAs, rec.execution.digest, rec.execution.via], ['root', DIGEST, 'nexus.install']);
  const kept = await life.approveExecution('org.r.app', 'user', { runAs: 'root', digest: DIGEST, approvedAt: 99, via: 'nexus.update' });
  assert.equal(kept.execution.approvedAt, 7, 'an update that keeps the config keeps the approval');
  await assert.rejects(life.approveExecution('org.r.none', 'user', { runAs: 'root', digest: DIGEST, approvedAt: 1, via: 'nexus.install' }), /no active installation/);
});

// ── Nexus: the binding, the recorded approval, update re-approval ───────────

function nexusFixture() {
  const root = mkdtempSync(join(TMP, 'nexus-'));
  const scope = (id, priority, immutable) => ({ id, appsDir: join(root, id, 'apps'), dataDir: join(root, id, 'data'), immutable, priority });
  const scopes = [scope('system', 0, true), scope('global', 1, false), scope('user', 2, false)];
  const reg = createAppHostRegistry(r);
  const life = new AppHostLifecycle(reg);
  const mgr = new NexusManager({ exchangeHelper: exchangeHelper(), scopes, rootDataDir: join(root, 'root'), hostLifecycle: life });
  const src = (version, execution, extra = {}) => {
    const dir = join(root, 'src', `${version}-${Math.random().toString(36).slice(2)}`, 'org.r.app');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'app.manifest.json'), JSON.stringify({ ...BASE, originId: ORIGIN, version, sandbox: 'container', ...(execution ? { execution } : {}), ...extra }));
    return dir;
  };
  const drain = async (it) => { let c; do { c = await it.next(); } while (!c.done && c.value.type !== 'permission.needed'); return c; };
  return { reg, life, mgr, src, drain };
}

test('nexus: the binding carries the root request; only the approval of it records root; update re-approval', async () => {
  const { life, mgr, src, drain } = nexusFixture();
  const exec = { runAs: 'root', reason: 'binds :80' };

  // Not approved: stops at permission.needed with the request bound; nothing installed or recorded.
  const asked = await drain(mgr.install({ ref: src('1.0.0', exec), scope: 'user', approval: async () => false }));
  assert.equal(asked.value.type, 'permission.needed');
  assert.deepEqual(asked.value.binding.execution, { runAs: 'root', digest: DIGEST, reason: 'binds :80', renew: true });
  assert.deepEqual(asked.value.binding.exposure, { sidecars: [], hostPublish: [], portExposes: [], hosts: [] });
  assert.equal(await life.installationOf('org.r.app', 'user'), null);

  // Approved: the installation runs as root with exactly that digest.
  let bound = null;
  const done = await drain(mgr.install({ ref: src('1.0.0', exec), scope: 'user', approval: async (b) => { bound = b; return true; } }));
  assert.equal(done.done, true);
  let inst = await life.installationOf('org.r.app', 'user');
  assert.deepEqual([inst.runAs, inst.execution.digest, inst.execution.via], ['root', DIGEST, 'nexus.install']);
  assert.equal(bound.execution.renew, true);

  // An update with the same request: bound as already approved (renew false); the approval stays.
  let upd = null;
  await drain(mgr.install({ ref: src('1.1.0', exec), scope: 'user', action: 'nexus.update', identity: { action: 'update-existing' }, approval: async (b) => { upd = b; return true; } }));
  assert.equal(upd.execution.renew, false);
  inst = await life.installationOf('org.r.app', 'user');
  assert.equal(inst.execution.via, 'nexus.install', 'the previous approval stays');

  // An update that drops the request keeps the record (the review flags it); one that re-adds it after a flip to app asks again.
  await drain(mgr.install({ ref: src('1.2.0', null), scope: 'user', action: 'nexus.update', identity: { action: 'update-existing' }, approval: async (b) => { assert.equal(b.execution, null); return true; } }));
  assert.equal((await life.installationOf('org.r.app', 'user')).runAs, 'root');
});

test('nexus: an install that introduces root on an app-identity installation needs the new approval; resumed without it, it records nothing', async () => {
  const { reg, life, mgr, src, drain } = nexusFixture();
  await drain(mgr.install({ ref: src('1.0.0', null), scope: 'user', approval: async () => true }));
  const before = await life.installationOf('org.r.app', 'user');
  assert.deepEqual([before.runAs, before.execution], ['app', undefined]);
  // The update introduces root: the binding asks to renew.
  const it = mgr.install({ ref: src('2.0.0', { runAs: 'root', reason: 'x' }), scope: 'user', action: 'nexus.update', identity: { action: 'update-existing' } });
  const c = await drain(it);
  assert.equal(c.value.binding.execution.renew, true);
  // An in-process caller resumes with approve:true: the code lands, root is NOT recorded (only a consumed approval grants it).
  let n = await it.next({ approve: true });
  while (!n.done) n = await it.next();
  const after = await life.installationOf('org.r.app', 'user');
  assert.deepEqual([after.runAs, after.execution], ['app', undefined]);
  assert.equal(executionDecision('org.r.app', ROOT, after, 'approve').kind, 'refused', 'so it does not start');
  void reg;
});

test('nexus: exposure lists only host-facing sidecar templates and port settings, sorted', () => {
  const m = AppManifestSchema.parse({
    ...BASE,
    ports: { hostPublish: [{ port: 9000, hostPort: 19000 }, { port: 8000 }], exposes: [{ sourceApp: 'com.x.db', sourcePort: 5432 }] },
    hosts: [{ name: 'rapp' }],
    services: [
      { name: 'plain', image: 'nginx', user: '101' },
      { name: 'vpn', image: 'wg', privileged: true, capabilities: ['NET_ADMIN'], publish: [{ host: 51820, container: 51820 }] },
      { name: 'dind', image: 'docker', inheritDockerSocket: true, user: '0:0' },
    ],
  });
  assert.deepEqual(installExposure(m), {
    sidecars: [
      { name: 'dind', image: 'docker', privileged: false, capabilities: [], devices: [], publish: [], dockerSocket: true, root: true },
      { name: 'vpn', image: 'wg', privileged: true, capabilities: ['NET_ADMIN'], devices: [], publish: ['51820:51820'], dockerSocket: false, root: true },
    ],
    hostPublish: [8000, 19000], portExposes: ['com.x.db:5432'], hosts: ['rapp'],
  });
});

// ── the start: denied -> no start; approved -> uid 0 and nothing more ─────────

function managerWith(policy = async () => 'approve') {
  const dataDir = mkdtempSync(join(TMP, 'mgr-'));
  const asked = [];
  const identities = { identityFor: async (req) => { asked.push(req); return req.runAs === 'app' ? { uid: 200007, gid: 200007, range: 'app' } : { uid: 0, gid: 0, range: 'root' }; } };
  const homes = { resolve: async () => ({ kind: 'app-global', hostPath: '/h', volumeSubpath: 'h', logicalPath: '/home/aura', uid: 0, gid: 0, mode: 0o700 }) };
  const mgr = new AppManager({ appsDir: join(dataDir, 'apps'), dataDir, baseRootfs: dataDir, toolchainDir: join(dataDir, 'tc'), identities, homes, rootExecutionPolicy: policy });
  const ctx = (manifest, installation) => mgr['spawnContext'](manifest.id, `${manifest.id}-1`, {
    manifest, runtime: { runtime: 'container', capabilities: { identity: 'enforced' } }, installation,
  });
  return { ctx, asked };
}

test('start: a root request without an approval of exactly it does not start (no identity, no fallback); approved runs as approvedRoot', async () => {
  const requesting = { id: 'org.r.app', environmentScope: 'global', execution: { runAs: 'root', reason: 'x' } };
  const approval = { runAs: 'root', digest: DIGEST, approvedAt: 1, via: 'nexus.install' };
  const { ctx, asked } = managerWith();
  for (const installation of [
    { installationId: 'i-1', runAs: 'app' },
    { installationId: 'i-1', runAs: 'root' },
    { installationId: 'i-1', runAs: 'root', execution: { ...approval, digest: `sha256:${'2'.repeat(64)}` } },
  ]) {
    await assert.rejects(ctx(requesting, installation), (e) => e.name === 'RootExecutionError' && e.code === 'root-execution-not-approved'
      && /root execution not approved/.test(e.message));
  }
  assert.equal(asked.length, 0, 'refused before any identity is chosen: never a silent escalation, never an app fallback');
  const ok = await ctx(requesting, { installationId: 'i-1', runAs: 'root', execution: approval });
  assert.deepEqual(ok.identity, { uid: 0, gid: 0, range: 'root', approvedRoot: true });
  // Without a request: unchanged (app stays app, legacy root stays legacy root).
  assert.equal((await ctx({ id: 'org.r.plain', environmentScope: 'global' }, { installationId: 'i-2', runAs: 'app' })).identity.range, 'app');
  assert.deepEqual((await ctx({ id: 'org.r.plain', environmentScope: 'global' }, { installationId: 'i-2', runAs: 'root' })).identity, { uid: 0, gid: 0, range: 'root' });
});

test('start: the D64 switch refuse stops approved root; an unreadable policy fails closed; nothing reads it for plain apps', async () => {
  let reads = 0;
  const approval = { runAs: 'root', digest: DIGEST, approvedAt: 1, via: 'nexus.install' };
  const requesting = { id: 'org.r.app', environmentScope: 'global', execution: { runAs: 'root', reason: 'x' } };
  const refuse = managerWith(async () => { reads += 1; return 'refuse'; });
  await assert.rejects(refuse.ctx(requesting, { installationId: 'i-1', runAs: 'root', execution: approval }), (e) => e.reason === 'policy');
  const broken = managerWith(async () => { throw new Error('valkey down'); });
  await assert.rejects(broken.ctx(requesting, { installationId: 'i-1', runAs: 'root', execution: approval }), /policy can't be read/);
  reads = 0;
  await refuse.ctx({ id: 'org.r.plain', environmentScope: 'global' }, { installationId: 'i-2', runAs: 'app' });
  assert.equal(reads, 0);
});

test('approved root implies no capability, no socket, no host access: cap-drop ALL, no-new-privileges, the sidecar too; PRoot refuses', () => {
  const approved = { uid: 0, gid: 0, range: 'root', approvedRoot: true };
  const args = containerIdentityArgs(approved, { appDataVolume: 'v', instanceId: 'i' });
  assert.deepEqual(args, ['--user', '0:0', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '-e', 'AURA_RUN_AS=root']);
  for (const bad of ['--privileged', '--cap-add', '--device', 'docker.sock', '--pid', '--network=host']) assert.ok(!args.some((a) => a.includes(bad)), bad);
  assert.deepEqual(containerIdentityArgs({ uid: 0, gid: 0, range: 'root' }), [], 'legacy root unchanged');
  assert.deepEqual(containerIdentityArgs({ uid: 0, gid: 0, range: 'root', approvedRoot: true, extra: 1 }).slice(0, 6), args.slice(0, 6));
  // A forged flag on a non-zero uid is not approved root.
  assert.notDeepEqual(containerIdentityArgs({ uid: 5, gid: 5, range: 'root', approvedRoot: true }, { appDataVolume: 'v', instanceId: 'i' }).slice(0, 2), ['--user', '0:0']);
  const sc = sidecarIdentityArgs({ image: 'aura-base', inheritHome: true }, approved, { appDataVolume: 'v', instanceId: 'i', baseImage: 'aura-base' });
  assert.deepEqual(sc, ['--user', '0:0', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges']);
  assert.deepEqual(sidecarIdentityArgs({ image: 'nginx' }, approved, { appDataVolume: 'v', instanceId: 'i', baseImage: 'aura-base' }), [], 'other sidecars keep their image user');
  assert.throws(() => requireProotIdentity('org.r.app', approved), (e) => e.name === 'ProotIdentityError');
  // Adoption: only an approved root request sets an explicit --user 0:0.
  assert.deepEqual(adoptedIdentity('0:0'), { runAs: 'root', uid: 0, gid: 0, approvedRoot: true });
  assert.deepEqual(adoptedIdentity(''), { runAs: 'root', uid: 0, gid: 0 });
});

// ── the privilege review and the D64 switch ─────────────────────────────────

test('privilege review: approved root, legacy root pending migration, and a request that is not approved', () => {
  const approval = { runAs: 'root', digest: DIGEST, approvedAt: 1, via: 'nexus.install' };
  const row = (appId, extra) => ({ appId, scope: 'global', installationId: `i-${appId}`, identity: null, needs: [], instances: [], ...extra });
  const rv = buildPrivilegeReview([
    row('org.r.approved', { runAs: 'root', rootRequest: { digest: DIGEST, reason: 'x' }, rootApproval: approval }),
    row('org.r.legacy', { runAs: 'root' }),
    row('org.r.denied', { runAs: 'app', rootRequest: { digest: DIGEST, reason: 'x' } }),
    row('org.r.changed', { runAs: 'root', rootRequest: { digest: `sha256:${'3'.repeat(64)}`, reason: 'x' }, rootApproval: approval }),
    row('org.r.dropped', { runAs: 'root', rootApproval: approval }),
    row('org.r.app', { runAs: 'app' }),
  ], () => 0);
  const by = Object.fromEntries(rv.rows.map((x) => [x.appId, x]));
  assert.deepEqual(Object.fromEntries(rv.rows.map((x) => [x.appId, [x.execution, x.verdict]])), {
    'org.r.approved': ['approved-root', 'approved-root'], 'org.r.legacy': ['legacy-root', 'ready'],
    'org.r.denied': ['not-approved', 'not-approved'], 'org.r.changed': ['not-approved', 'not-approved'],
    'org.r.dropped': ['approved-root', 'approved-root'], 'org.r.app': ['app', 'app'],
  });
  assert.ok(by['org.r.legacy'].elevated.some((e) => /^legacy root, pending migration/.test(e)));
  assert.ok(!by['org.r.approved'].elevated.some((e) => /legacy/.test(e)), 'approved root is not reported as legacy');
  assert.ok(by['org.r.denied'].elevated.some((e) => /does not start/.test(e)));
  assert.ok(by['org.r.dropped'].elevated.some((e) => /no longer requests/.test(e)));
  assert.deepEqual([rv.summary['approved-root'], rv.summary['not-approved']], [2, 2]);
});

test('D64: app-root-execution is a fresh policy switch, approve by default', () => {
  const o = securityOption('app-root-execution');
  assert.deepEqual([o.source, o.type, o.default, o.change, [...o.values]], ['policy', 'enum', 'approve', 'fresh', ['approve', 'refuse']]);
  assert.equal(securityPolicyValue({}, 'app-root-execution', {}), 'approve');
  assert.equal(securityPolicyValue({ 'app-root-execution': 'refuse' }, 'app-root-execution', {}), 'refuse');
});
