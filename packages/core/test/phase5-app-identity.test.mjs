// Phase 5 stream A (P5-3): non-root app processes. The runAs record and its
// flip, the identity provider (no root fallback), the spawn identity args and
// passwd files, the sidecar policy, the ownership rows and their race-safe
// apply, the start shell's non-root refusal, the builder provisioning shell,
// adoption, the privilege review and the D64 entry.
//
// Run via: node tools/run-tests.mjs --only=core

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KvServer, createRedis } from '@aura/kv-store';
import { createAppHostRegistry } from '../dist/app-hosts/AppHostRegistry.js';
import { AppHostLifecycle } from '../dist/app-hosts/lifecycle.js';
import { LinuxIdentityStore } from '../dist/identity/LinuxIdentityStore.js';
import { appIdentityProvider } from '../dist/identity/appIdentityProvider.js';
import { appOwnershipSpecs, applyAppOwnership, DEV_CACHE_DIRS } from '../dist/identity/appOwnership.js';
import { buildOwnershipReport } from '../dist/identity/ownershipReport.js';
import { APP_MIGRATION, buildPrivilegeReview, manifestPrivilegeNeeds } from '../dist/identity/privilegeReview.js';
import { newInstallationRunAs } from '../dist/identity/types.js';
import {
  containerIdentityArgs, identityFilesSubpath, renderIdentityFiles, sidecarIdentityArgs, writeIdentityFiles,
} from '../dist/runtimes/spawn/identityArgs.js';
import {
  ASTRO_START_SHELL, BUILDER_CACHE_PATH, RAW_START_SHELL, builderProvisionEnv, builderProvisionShell, PROVISION_BEGIN,
} from '../dist/app-manager/provisioning.js';
import { AppManager, adoptedIdentity } from '../dist/app-manager/AppManager.js';
import { securityOption } from '../dist/security/options.js';

const TMP = mkdtempSync(join(tmpdir(), 'aura-p5a-'));
const server = new KvServer();
let redis;
const r = () => redis;
const isRoot = process.getuid?.() === 0;

before(async () => {
  redis = createRedis(await server.start({ dataDir: join(TMP, 'kv') }));
});
after(async () => {
  redis?.disconnect();
  await server.stop();
  rmSync(TMP, { recursive: true, force: true });
});
beforeEach(async () => { await redis.flushdb(); });

const SRC = { kind: 'oci', ref: 'reg.example/apps/notes:1.0.0' };
const APP = { uid: 200_007, gid: 200_007, range: 'app' };

// ── the installation record ─────────────────────────────────────────────────

test('runAs: new installations start as app, built-in ones as root; old records have none (root)', async () => {
  assert.equal(newInstallationRunAs('global'), 'app');
  assert.equal(newInstallationRunAs('user'), 'app');
  assert.equal(newInstallationRunAs('system'), 'root');
  const reg = createAppHostRegistry(r);
  const life = new AppHostLifecycle(reg);
  const g = (await life.sync({ appId: 'org.a.notes', originId: null, scope: 'global', source: SRC })).installation;
  const s = (await life.sync({ appId: 'com.aura.counter', originId: null, scope: 'system', source: { kind: 'system', ref: 'com.aura.counter' } })).installation;
  assert.equal(g.runAs, 'app');
  assert.equal(s.runAs, 'root');
  const old = await reg.createInstallation({ appId: 'org.a.old', originId: null, scope: 'global', source: SRC });
  assert.equal(old.runAs, undefined, 'a record written without it (before 5-apps) stays without it');
  // An update of the same installation keeps its runAs.
  const updated = await reg.updateInstallation(g.installationId, { source: { ...SRC, ref: 'reg.example/apps/notes:2.0.0' } });
  assert.equal(updated.runAs, 'app');
});

test('setRunAs: the owner flip, compare-and-set, and the per-app rollback', async () => {
  const reg = createAppHostRegistry(r);
  const inst = await reg.createInstallation({ appId: 'org.a.flip', originId: null, scope: 'global', source: SRC });
  const up = await reg.setRunAs(inst.installationId, 'app', 'root');
  assert.equal(up.ok, true);
  assert.equal((await reg.getInstallation(inst.installationId)).runAs, 'app');
  assert.equal((await reg.setRunAs(inst.installationId, 'root', 'root')).ok, false, 'a stale decision is refused, not applied');
  assert.equal((await reg.getInstallation(inst.installationId)).runAs, 'app');
  assert.equal((await reg.setRunAs(inst.installationId, 'root', 'app')).ok, true, 'rollback of one app is a flip back');
  assert.equal((await reg.getInstallation(inst.installationId)).runAs, 'root');
  await assert.rejects(reg.setRunAs(inst.installationId, 'admin'), /invalid runAs/);
  assert.deepEqual(await reg.setRunAs('no-such-installation', 'app'), { ok: false, installation: null });
});

// ── the identity provider: no root fallback ─────────────────────────────────

test('identity provider: root stays root; app gets its registry uid; failures never fall back to root', async () => {
  const store = new LinuxIdentityStore({ redis: r, hwmFile: join(mkdtempSync(join(TMP, 'hwm-')), 'hwm.json') });
  const p = appIdentityProvider(async () => store);
  assert.deepEqual(await p.identityFor({ appId: 'org.a.x', installationId: 'i-1' }), { uid: 0, gid: 0, range: 'root' });
  assert.deepEqual(await p.identityFor({ appId: 'org.a.x', installationId: 'i-1', runAs: 'root' }), { uid: 0, gid: 0, range: 'root' });
  const a = await p.identityFor({ appId: 'org.a.x', installationId: 'i-1', runAs: 'app' });
  assert.equal(a.range, 'app');
  assert.ok(a.uid >= 200_000 && a.uid <= 299_999 && a.gid === a.uid);
  assert.deepEqual(await p.identityFor({ appId: 'org.a.x', installationId: 'i-1', runAs: 'app' }), a, 'stable per installation');
  const b = await p.identityFor({ appId: 'org.a.x', installationId: 'i-2', runAs: 'app' });
  assert.notEqual(b.uid, a.uid, 'two installations of one app never share a uid');
  await assert.rejects(p.identityFor({ appId: 'org.a.x', installationId: null, runAs: 'app' }), /no root fallback/);
  const broken = appIdentityProvider(async () => ({ ensureApp: async () => { throw new Error('valkey down'); } }));
  await assert.rejects(broken.identityFor({ appId: 'org.a.x', installationId: 'i-1', runAs: 'app' }), /no root fallback/);
  await store.retire('app', 'i-1');
  await assert.rejects(p.identityFor({ appId: 'org.a.x', installationId: 'i-1', runAs: 'app' }), /retired/);
});

test('spawnContext: an app identity on a runtime without an enforced identity is refused (capability-missing)', async () => {
  const dataDir = mkdtempSync(join(TMP, 'mgr-'));
  const ident = { identityFor: async (req) => (req.runAs === 'app' ? { ...APP } : { uid: 0, gid: 0, range: 'root' }) };
  const homes = { resolve: async () => ({ kind: 'app-global', hostPath: '/h', volumeSubpath: 'h', logicalPath: '/home/aura', uid: 0, gid: 0, mode: 0o700 }) };
  const mgr = new AppManager({ appsDir: join(dataDir, 'apps'), dataDir, baseRootfs: dataDir, toolchainDir: join(dataDir, 'tc'), identities: ident, homes });
  const manifest = { id: 'org.a.x', environmentScope: 'global' };
  const ctx = (identity, runAs) => mgr['spawnContext']('org.a.x', 'org.a.x', {
    manifest, runtime: { runtime: 'proot', capabilities: { identity } }, installation: { installationId: 'i-1', runAs },
  });
  await assert.rejects(ctx('none', 'app'), (e) => e.code === 'capability-missing' && /no root fallback/.test(e.message));
  assert.equal((await ctx('none', 'root')).identity.range, 'root', 'root on PRoot: unchanged');
  assert.deepEqual((await ctx('enforced', 'app')).identity, APP);
  // The installation record can't be read: no start (its runAs is unknown).
  mgr.registry.getScopeId = () => 'global';
  const svc = (await import('../dist/app-hosts/services.js')).getAppHostServices();
  const saved = svc.registry;
  svc.registry = { findInstallation: async () => { throw new Error('ECONNREFUSED'); } };
  try {
    await assert.rejects(mgr.installationRunAs('org.a.x'), /can't be read/);
  } finally { svc.registry = saved; }
});

// ── spawn args and identity files ───────────────────────────────────────────

test('container identity args: nothing for root; --user, cap-drop ALL, no-new-privileges and passwd for an app', () => {
  assert.deepEqual(containerIdentityArgs(undefined), []);
  assert.deepEqual(containerIdentityArgs({ uid: 0, gid: 0, range: 'root' }), []);
  assert.throws(() => containerIdentityArgs(APP), /identity files/);
  const a = containerIdentityArgs(APP, { appDataVolume: 'vol', instanceId: 'org.a.x-2' });
  assert.deepEqual(a.slice(0, 6), ['--user', '200007:200007', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges']);
  assert.ok(a.includes('type=volume,source=vol,target=/etc/passwd,volume-subpath=aura/runtime/org.a.x-2/identity/passwd,readonly'));
  assert.ok(a.includes('type=volume,source=vol,target=/etc/group,volume-subpath=aura/runtime/org.a.x-2/identity/group,readonly'));
  assert.ok(!a.includes('--group-add'), 'no supplementary groups');
  assert.ok(!a.some((x) => /^--cap-add/.test(x)), 'no capability added back');
});

test('identity files: deterministic, the app account with pw_dir /home/aura, written read-only', () => {
  const f = renderIdentityFiles(APP, '3f1c2e7a-0000-4000-8000-000000000001');
  assert.deepEqual(renderIdentityFiles(APP, '3f1c2e7a-0000-4000-8000-000000000001'), f);
  assert.match(f.passwd, /^app-3f1c2e7a0000:x:200007:200007:AuraOS app:\/home\/aura:\/bin\/bash$/m);
  assert.match(f.passwd, /^root:x:0:0:/m);
  assert.match(f.group, /^app-3f1c2e7a0000:x:200007:$/m);
  const dir = mkdtempSync(join(TMP, 'idf-'));
  const out = writeIdentityFiles(dir, 'org.a.x', APP, '3f1c2e7a-0000-4000-8000-000000000001');
  assert.equal(out, join(dir, identityFilesSubpath('org.a.x')));
  assert.equal(readFileSync(join(out, 'passwd'), 'utf-8'), f.passwd);
  assert.equal(statSync(join(out, 'passwd')).mode & 0o777, 0o644);
});

test('sidecars keep their image user; only an aura-base inheritHome sidecar of an app runs as the app', () => {
  const opts = { appDataVolume: 'vol', instanceId: 'org.b.board', baseImage: 'aura-base' };
  assert.deepEqual(sidecarIdentityArgs({ image: 'trilium', inheritHome: false }, APP, opts), [], 'foreign image');
  assert.deepEqual(sidecarIdentityArgs({ image: 'canvas', inheritHome: false, user: '0:0' }, APP, opts), [], 'explicit user wins');
  assert.deepEqual(sidecarIdentityArgs({ image: 'aura-base', inheritHome: false }, APP, opts), [], 'aura-base without the home');
  assert.deepEqual(sidecarIdentityArgs({ image: 'aura-base', inheritHome: true }, { uid: 0, gid: 0, range: 'root' }, opts), [], 'root parent');
  const s = sidecarIdentityArgs({ image: 'aura-base', inheritHome: true }, APP, opts);
  assert.deepEqual(s.slice(0, 6), ['--user', '200007:200007', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges']);
});

test('adoption keeps the latched identity from Config.User (D77)', () => {
  assert.deepEqual(adoptedIdentity(undefined), { runAs: 'root', uid: 0, gid: 0 });
  assert.deepEqual(adoptedIdentity(''), { runAs: 'root', uid: 0, gid: 0 });
  // 5-main item 3: only an approved root request sets an explicit --user 0:0 (no capabilities).
  assert.deepEqual(adoptedIdentity('0:0'), { runAs: 'root', uid: 0, gid: 0, approvedRoot: true });
  assert.deepEqual(adoptedIdentity('200007:200007'), { runAs: 'app', uid: 200007, gid: 200007 });
  assert.deepEqual(adoptedIdentity('200008'), { runAs: 'app', uid: 200008, gid: 200008 });
});

// ── ownership rows and apply ────────────────────────────────────────────────

function layout() {
  const root = mkdtempSync(join(TMP, 'own-'));
  const appDir = join(root, 'apps', 'org.a.x');        // the source tree (global/user scope)
  mkdirSync(join(appDir, 'src'), { recursive: true });
  mkdirSync(join(appDir, 'node_modules', 'astro'), { recursive: true });
  writeFileSync(join(appDir, 'src', 'index.astro'), 'x');
  const inst = join(appDir, 'org.a.x');                 // the instance data dir, inside the source
  mkdirSync(join(inst, 'db', 'deep'), { recursive: true });
  writeFileSync(join(inst, 'db', 'deep', 'a.sqlite'), 'data');
  mkdirSync(join(appDir, 'org.a.x-2'));
  return { root, appDir, inst };
}

test('ownership rows: the instance dirs and, for astro dev, the caches; the same rows feed the report', async () => {
  const { appDir } = layout();
  const base = { appId: 'org.a.x', installationId: 'i-1', appDataRoot: appDir, appDir, identity: APP };
  const prod = appOwnershipSpecs({ ...base, devServed: false });
  assert.deepEqual(prod.map((x) => [x.kind, x.path]), [['app-data', join(appDir, 'org.a.x')], ['app-data', join(appDir, 'org.a.x-2')]]);
  assert.ok(prod.every((x) => x.section === 'plannedAppPaths' && x.recursive && x.to.uid === APP.uid));
  assert.ok(!prod.some((x) => x.path === appDir), 'never the source tree itself');
  const dev = appOwnershipSpecs({ ...base, devServed: true });
  assert.deepEqual(dev.filter((x) => x.kind === 'dev-cache').map((x) => x.path), DEV_CACHE_DIRS.map((d) => join(appDir, d)));
  assert.equal(appOwnershipSpecs({ ...base, devServed: false, instanceDirs: ['org.a.x-2', 'other'] }).length, 1, 'only instance dirs of this app');
  const notYet = appOwnershipSpecs({ ...base, devServed: false, identity: null });
  assert.ok(notYet.every((x) => x.to === null));
  const report = await buildOwnershipReport(dev, { refuseRoots: ['/'] });
  assert.equal(report.plannedAppPaths.length, dev.length);
});

test('apply: the instance tree and the caches go to the app uid; the source stays root; idempotent', { skip: !isRoot && 'needs root (chown)' }, () => {
  const { appDir, inst } = layout();
  const rows = appOwnershipSpecs({ appId: 'org.a.x', installationId: 'i-1', appDataRoot: appDir, instanceDirs: ['org.a.x'], appDir, devServed: true, identity: APP });
  const res = applyAppOwnership(rows, APP);
  for (const p of [inst, join(inst, 'db'), join(inst, 'db', 'deep'), join(inst, 'db', 'deep', 'a.sqlite')]) {
    assert.equal(lstatSync(p).uid, APP.uid, p);
  }
  for (const d of DEV_CACHE_DIRS) {
    const st = lstatSync(join(appDir, d));
    assert.ok(st.isDirectory() && st.uid === APP.uid && (st.mode & 0o777) === 0o700, d);
  }
  assert.equal(res.created.length, DEV_CACHE_DIRS.length);
  for (const p of [appDir, join(appDir, 'src'), join(appDir, 'src', 'index.astro'), join(appDir, 'node_modules'), join(appDir, 'node_modules', 'astro'), join(appDir, 'org.a.x-2')]) {
    assert.equal(lstatSync(p).uid, 0, `untouched: ${p}`);
  }
  assert.equal(applyAppOwnership(rows, APP).changed, 0, 'a second apply changes nothing');
  // Root wrote into the app's tree later (a rollback period): the next apply hands it over, inside app-owned dirs too.
  writeFileSync(join(inst, 'db', 'deep', 'root-later'), 'r');
  assert.equal(applyAppOwnership(rows, APP).changed, 1);
  assert.throws(() => applyAppOwnership(rows, { uid: 0, gid: 0 }), /non-root/);
});

test('apply: symlinks are never followed, hard links are left alone, a symlinked row is refused', { skip: !isRoot && 'needs root (chown)' }, () => {
  const { appDir, inst } = layout();
  const outside = join(appDir, 'src', 'secret');
  writeFileSync(outside, 's');
  symlinkSync(outside, join(inst, 'link-to-file'));
  symlinkSync(join(appDir, 'src'), join(inst, 'link-to-dir'));
  linkSync(join(appDir, 'src', 'index.astro'), join(inst, 'hard'));
  const rows = appOwnershipSpecs({ appId: 'org.a.x', installationId: 'i-1', appDataRoot: appDir, instanceDirs: ['org.a.x'], appDir, devServed: false, identity: APP });
  const res = applyAppOwnership(rows, APP);
  assert.equal(lstatSync(outside).uid, 0, 'a link target stays root');
  assert.equal(lstatSync(join(appDir, 'src')).uid, 0, 'a linked dir is not entered');
  assert.equal(lstatSync(join(inst, 'link-to-file')).uid, APP.uid, 'the link itself is the app\'s');
  assert.equal(lstatSync(join(appDir, 'src', 'index.astro')).uid, 0, 'a hard-linked source file is not handed over');
  assert.ok(res.skipped.some((s) => /hard/.test(s) && /links/.test(s)));
  // A row whose own path is a symlink: refused.
  const { appDir: d2 } = layout();
  rmSync(join(d2, 'org.a.x'), { recursive: true });
  symlinkSync(join(d2, 'src'), join(d2, 'org.a.x'));
  const r2 = applyAppOwnership(appOwnershipSpecs({ appId: 'org.a.x', installationId: 'i', appDataRoot: d2, instanceDirs: ['org.a.x'], appDir: d2, devServed: false, identity: APP }), APP);
  assert.equal(lstatSync(join(d2, 'src')).uid, 0);
  assert.ok(r2.skipped.some((s) => /symbolic link/.test(s)));
});

// ── the start shell and the builder ─────────────────────────────────────────

function fakeApp(pkg) {
  const d = mkdtempSync(join(TMP, 'app-'));
  writeFileSync(join(d, 'package.json'), JSON.stringify(pkg));
  return d;
}
/** A PATH dir where `id -u` answers `uid` and `aura`/`npm` record their calls. */
function stubs(uid) {
  const bin = mkdtempSync(join(TMP, 'bin-'));
  writeFileSync(join(bin, 'id'), `#!/bin/sh\n[ "$1" = "-u" ] && echo ${uid} && exit 0\nexec /usr/bin/id "$@"\n`);
  writeFileSync(join(bin, 'aura'), '#!/bin/sh\necho "aura $*" >> calls.log\nmkdir -p node_modules/@aura/app-sdk\n');
  writeFileSync(join(bin, 'npm'), '#!/bin/sh\necho "npm $*" >> calls.log\nmkdir -p node_modules/.bin\n');
  for (const f of ['id', 'aura', 'npm']) chmodSync(join(bin, f), 0o755);
  return bin;
}

test('a non-root start never installs: it reports "not provisioned" and exits non-zero', () => {
  const d = fakeApp({ name: 'raw', auraDependencies: { '@aura/app-sdk': '^0.0.1' } });
  writeFileSync(join(d, 'entrypoint.sh'), 'echo entry\n');
  const bin = stubs(200007);
  const r = spawnSync('bash', ['-c', RAW_START_SHELL, 'aura-raw', join(d, 'entrypoint.sh')],
    { cwd: d, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, APP_ID: 'org.a.raw' }, encoding: 'utf-8' });
  assert.notEqual(r.status, 0, 'fail closed');
  assert.match(r.stderr, /not provisioned: .*OS builder.*aura build app org\.a\.raw/);
  assert.ok(!r.stdout.includes('entry'), 'the app does not start');
  assert.ok(!r.stdout.includes(PROVISION_BEGIN));
  assert.ok(!existsSync(join(d, 'calls.log')), 'nothing was installed');
  assert.ok(ASTRO_START_SHELL.includes('not provisioned'), 'the Astro start has the same block');
  // Provisioned: a non-root start goes straight to the app.
  mkdirSync(join(d, 'node_modules', '@aura'), { recursive: true });
  const ok = spawnSync('bash', ['-c', RAW_START_SHELL, 'aura-raw', join(d, 'entrypoint.sh')],
    { cwd: d, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf-8' });
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /^entry$/m);
});

test('the builder runs the same provisioning block, with the aura CLI and caches outside every home', () => {
  const sh = builderProvisionShell('raw');
  assert.ok(sh.includes('aura() { node /workspace/packages/aura-cli/dist/aura.cjs'));
  assert.ok(sh.includes(PROVISION_BEGIN));
  const env = builderProvisionEnv('org.a.x').filter((x) => x !== '-e');
  assert.ok(env.includes(`HOME=${BUILDER_CACHE_PATH}/home`));
  assert.ok(env.every((x) => !/AURA_INSTANCE_TOKEN|AURA_LIFECYCLE_TOKEN|\/home\/aura/.test(x)), 'no token, no user home');
  // As root in the builder it installs, then checks.
  const d = fakeApp({ name: 'raw', auraDependencies: { '@aura/app-sdk': '^0.0.1' } });
  const bin = stubs(0);
  const shell = sh.replace(/^aura\(\) .*$/m, ''); // the stub `aura` stands in for the CLI
  const out = execFileSync('bash', ['-c', shell], { cwd: d, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: join(d, 'h') }, encoding: 'utf-8' });
  assert.ok(out.includes(PROVISION_BEGIN));
  assert.equal(readFileSync(join(d, 'calls.log'), 'utf-8'), 'aura sdk install --quiet\n');
  // An install that leaves the tree missing fails the builder run.
  const d2 = fakeApp({ name: 'x', dependencies: { left: '1' } });
  const bad = stubs(0);
  writeFileSync(join(bad, 'npm'), '#!/bin/sh\nexit 0\n');
  writeFileSync(join(bad, 'aura'), '#!/bin/sh\nexit 0\n');
  const r = spawnSync('bash', ['-c', shell], { cwd: d2, env: { ...process.env, PATH: `${bad}:${process.env.PATH}`, HOME: join(d2, 'h') }, encoding: 'utf-8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /did not install/);
});

// ── the privilege review ────────────────────────────────────────────────────

test('privilege review: verdicts, elevated reasons and mismatched instances', () => {
  assert.equal(Object.keys(APP_MIGRATION).length, 23, 'the plan\'s 23 apps');
  const needs = manifestPrivilegeNeeds({
    id: 'io.x.steel', tools: ['docker'],
    services: [{ name: 'steel', image: 'steel' }, { name: 'sup', image: 'aura-base', inheritHome: true }, { name: 'p', image: 'p', user: '1000', privileged: true }],
  }, { id: 'container', identity: 'enforced' }, 'aura-base');
  assert.ok(needs.some((n) => n.level === 'blocks' && /Docker socket/.test(n.reason)));
  assert.ok(needs.some((n) => n.level === 'info' && /root sidecar steel/.test(n.reason)));
  assert.ok(needs.some((n) => /sup .*runs as the app's identity/.test(n.reason)));
  assert.ok(needs.some((n) => /p is privileged/.test(n.reason)));
  assert.ok(manifestPrivilegeNeeds({ id: 'a' }, { id: 'proot', identity: 'none' }, 'aura-base').some((n) => n.level === 'blocks'));
  const rv = buildPrivilegeReview([
    { appId: 'com.aura.counter', scope: 'system', installationId: 'i1', runAs: 'app', identity: { uid: 200001, gid: 200001 }, needs: [], instances: [{ instanceId: 'c', uid: 200001 }] },
    { appId: 'com.aura.registry', scope: 'system', installationId: 'i2', runAs: 'root', identity: null, needs: [], instances: [{ instanceId: 'r', uid: 200002 }] },
    { appId: 'com.aura.docs', scope: 'system', installationId: 'i3', runAs: 'root', identity: null, needs: [], instances: [] },
    { appId: 'dev.box', scope: 'global', installationId: 'i4', runAs: 'root', identity: null, needs: [], instances: [] },
    { appId: 'io.x.steel', scope: 'global', installationId: 'i5', runAs: 'root', identity: null, needs, instances: [] },
    { appId: 'org.unknown', scope: 'user', installationId: null, runAs: null, identity: null, needs: [], instances: [] },
  ], () => 0);
  const v = Object.fromEntries(rv.rows.map((x) => [x.appId, x.verdict]));
  assert.deepEqual(v, {
    'com.aura.counter': 'app', 'com.aura.registry': 'ready', 'com.aura.docs': 'needs-review', 'dev.box': 'blocked',
    'io.x.steel': 'blocked', 'org.unknown': 'root',
  });
  assert.deepEqual(rv.rows.find((x) => x.appId === 'com.aura.registry').mismatched, ['r']);
  assert.ok(rv.rows.find((x) => x.appId === 'com.aura.docs').elevated[0].startsWith('needs elevated privileges: '));
  assert.equal(rv.summary.blocked, 2);
});

test('D64: the per-installation runAs is listed in the security options registry', () => {
  const o = securityOption('app-run-as');
  assert.deepEqual([o.source, o.type, o.change], ['record', 'record', 'fresh']);
  assert.match(o.record, /apphost:install:/);
});
