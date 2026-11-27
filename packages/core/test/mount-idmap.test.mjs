// D80 (Phase 5b G): writable cross-app mounts between different uids go
// through an idmapped bind (the session launcher's `idmap-bind` in the mount
// helper), or are refused clearly: never a plain bind that is writable in name
// only, never read-only or broader as a fallback. Against a fake kernel and a
// fake helper (no Docker): the probe true and false, the cross-uid refusal
// when it fails, Developer Mode for source, root-owned data, read-only
// unchanged, verification of the idmapping, and revocation.
//
// Run via: node tools/run-tests.mjs --only=core
import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MountManager } from '../dist/app-manager/MountManager.js';
import { ContainerRunner, idmapProbeArgs } from '../dist/app-manager/ContainerRunner.js';
import { IDMAP_HELPER_PATH } from '../dist/runtimes/container/backends.js';
import { RuntimeCapabilityError, runtimeRefusal, requestNeeds, missingCapabilities } from '../dist/index.js';

const CONSUMER = 'com.aura.terminal-2';
const APP_UID = 200007;          // the consumer's process identity
const TARGET_UID = 200003;       // the target app's on-disk owner

function world(t, { probe = { ok: true }, devMode = false, owners = {}, dropIdmap = false, consumer = { uid: APP_UID, gid: APP_UID } } = {}) {
  const dataDir = fs.mkdtempSync(join(tmpdir(), 'aura-idmap-'));
  const kernel = new Map();   // shell-side dest → { mode, idmapped }
  const helper = [];          // privileged helper runs: { script, args }
  const realRead = fs.readFileSync;
  const realStat = fs.statSync;
  const mountRootDir = (k) => join(dataDir, 'aura', 'mounts', k);
  const appDir = (id) => join(dataDir, 'src', id);
  for (const id of ['io.t.src', 'io.t.root']) fs.mkdirSync(appDir(id), { recursive: true });
  const view = () => [...kernel].map(([dest, m]) => `9 1 0:1 / /mnt/aura/${dest.slice(mountRootDir(CONSUMER).length + 1)} ${m.mode},relatime${m.idmapped && !dropIdmap ? ',idmapped' : ''} - ext4 x ${m.mode}`).join('\n') + '\n';

  t.mock.method(fs, 'readFileSync', (p, ...rest) => (p === '/proc/self/mountinfo'
    ? [...kernel].map(([dest, m]) => `5 1 0:1 / ${dest} ${m.mode},relatime master:1 - ext4 x ${m.mode}`).join('\n') + '\n'
    : realRead(p, ...rest)));
  // The on-disk owner of each source root: source trees are root-owned (since A), data dirs the app uid's.
  t.mock.method(fs, 'statSync', (p, ...rest) => {
    for (const [part, uid] of Object.entries(owners)) if (String(p).includes(part)) return { uid, gid: uid };
    if (String(p).startsWith(join(dataDir, 'src'))) return { uid: 0, gid: 0 };
    if (String(p).startsWith(join(dataDir, 'scopes'))) return { uid: TARGET_UID, gid: TARGET_UID };
    return realStat(p, ...rest);
  });
  t.mock.method(childProcess, 'execSync', () => '/mnt/aura\n/data\n');
  t.mock.method(childProcess, 'execFileSync', (cmd, args) => {
    assert.equal(cmd, 'docker');
    if (args[0] === 'exec') return view();
    const script = args[args.indexOf('-euc') + 1];
    const rest = args.slice(args.indexOf('_') + 1);
    helper.push({ script, args, rest });
    const dest = rest[0];
    if (script.includes('idmap-bind')) {
      assert.ok(args.includes(`/helper/aura-session-enter:${IDMAP_HELPER_PATH}:ro`), 'the launcher is bound read-only');
      assert.ok(args.some((a) => a.endsWith(':/src')), 'the source is bound writable for an idmapped rw mount');
      kernel.set(dest, { mode: 'rw', idmapped: true });
    } else if (script.includes('mount --bind')) {
      kernel.set(dest, { mode: args.some((a) => a.endsWith(':/src:ro')) ? 'ro' : 'rw', idmapped: false });
    } else kernel.delete(dest);
    return '';
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });

  const mm = new MountManager({
    dataDir,
    registry: { getById: (id) => ({ id, appDir: appDir(id), scopeId: 'global' }) },
    scopeRegistry: { getById: () => ({ dataDir: join(dataDir, 'scopes', 'global') }) },
    runner: {
      canPropagateMounts: () => ({ ok: true }),
      canIdmapMounts: () => probe,
      idmapHelperHostPath: () => (probe.ok ? '/helper/aura-session-enter' : null),
      mountRootDir,
      toDaemonHostPath: (p) => p,
    },
    instanceDataDir: (k) => join(dataDir, 'scopes', 'global', 'apps', 'com.aura.terminal', k),
    sourceMode: () => 'open',
    consumerIdentity: () => consumer,
    developerMode: () => devMode,
    runtimeOf: () => 'container',
  });
  return { mm, kernel, helper, dataDir, setDev: (v) => { devMode = v; } };
}

test('D80: a writable data mount into another uid is an idmapped bind (target uid → consumer uid), verified', async (t) => {
  const w = world(t);
  const m = await w.mm.add(CONSUMER, { targetAppId: 'io.t.src', mode: 'rw', data: true });
  assert.equal(m.mode, 'rw');
  assert.deepEqual(m.idmap, { from: `${TARGET_UID}:${TARGET_UID}`, to: `${APP_UID}:${APP_UID}` });
  const run = w.helper.find((h) => h.script.includes('idmap-bind'));
  assert.ok(run, 'the launcher made the bind');
  assert.deepEqual(run.rest.slice(1), [`${TARGET_UID}:${TARGET_UID}`, `${APP_UID}:${APP_UID}`]);
  assert.ok(!w.helper.some((h) => h.script.includes('mount --bind')), 'never also a plain bind');
});

test('D80: the same uid, a root consumer with its capabilities, or a read-only mount: a plain bind as before', async (t) => {
  const same = world(t, { consumer: { uid: TARGET_UID, gid: TARGET_UID } });
  assert.equal((await same.mm.add(CONSUMER, { targetAppId: 'io.t.src', mode: 'rw', data: true })).idmap, undefined);
  const ro = world(t);
  const m = await ro.mm.add(CONSUMER, { targetAppId: 'io.t.src', mode: 'ro', data: true });
  assert.equal(m.mode, 'ro');
  assert.equal(m.idmap, undefined);
  assert.ok(ro.helper.every((h) => !h.script.includes('idmap')), 'read-only mounts are unchanged');
});

test('D80: probe false → refused with capability-missing: idmappedMounts; never weaker, never a helper run', async (t) => {
  const w = world(t, { probe: { ok: false, reason: 'idmapped mounts unavailable: EINVAL' } });
  await assert.rejects(w.mm.add(CONSUMER, { targetAppId: 'io.t.src', mode: 'rw', data: true }), (e) => {
    assert.ok(e instanceof RuntimeCapabilityError);
    assert.deepEqual(e.missing, ['idmappedMounts']);
    const r = runtimeRefusal(e);
    assert.equal(r.code, 'capability-missing');
    assert.equal(r.category, 'unsupported-feature');
    assert.match(e.message, /EINVAL/);
    return true;
  });
  assert.equal(w.kernel.size, 0);
  assert.equal(w.helper.length, 0);
  assert.deepEqual(w.mm.list(CONSUMER), []);
  // The restore of a declaration fails the same way: it is never made read-only behind the user's back.
  await assert.rejects(w.mm.add(CONSUMER, { targetAppId: 'io.t.src', mode: 'rw', data: true }, { persist: false, origin: 'restored' }), RuntimeCapabilityError);
});

test('D80 / owner answer 4: a writable source mount into another uid needs Developer Mode; restored without it, read-only', async (t) => {
  const off = world(t);
  await assert.rejects(off.mm.add(CONSUMER, { targetAppId: 'io.t.src', mode: 'rw' }), /needs Developer Mode/);
  assert.equal(off.kernel.size, 0);
  const restored = await off.mm.add(CONSUMER, { targetAppId: 'io.t.src', mode: 'rw' }, { persist: false, origin: 'restored' });
  assert.equal(restored.mode, 'ro', 'a declaration from Developer Mode comes back read-only');
  assert.equal(restored.idmap, undefined);

  const on = world(t, { devMode: true });
  const m = await on.mm.add(CONSUMER, { targetAppId: 'io.t.src', mode: 'rw' });
  assert.deepEqual(m.idmap, { from: '0:0', to: `${APP_UID}:${APP_UID}` });
});

test('D80: a root-owned data tree is never mapped to another uid', async (t) => {
  const root = world(t, { owners: { '/scopes/global/apps/io.t.root': 0 } });
  await assert.rejects(root.mm.add(CONSUMER, { targetAppId: 'io.t.root', mode: 'rw', data: true }),
    /root-owned, and uid 0 is never mapped[\s\S]*owned by the app's identity first[\s\S]*aura admin homes ownership/);
  assert.equal(root.helper.length, 0, 'nothing mounted');
  assert.equal(root.kernel.size, 0);
  // Restored from a declaration: read-only, never mapped.
  const back = await root.mm.add(CONSUMER, { targetAppId: 'io.t.root', mode: 'rw', data: true }, { persist: false, origin: 'restored' });
  assert.equal(back.mode, 'ro');
  assert.equal(back.idmap, undefined);
});

test('D80 / owner answer 4: an authorized patch workspace stays writable without Developer Mode (no idmap, never refused)', async (t) => {
  const w = world(t, { devMode: false });
  const m = await w.mm.add(CONSUMER, { targetAppId: 'io.t.src', workspace: 'aura/workspaces/default/inst-io-t-src/1' });
  assert.equal(m.kind, 'work');
  assert.equal(m.mode, 'rw');
  assert.equal(m.idmap, undefined);
  assert.equal(m.containerPath, '/mnt/aura/work/io.t.src');
  // …while the source itself, writable into another uid, needs Developer Mode.
  await assert.rejects(w.mm.add(CONSUMER, { targetAppId: 'io.t.src', mode: 'rw' }), /needs Developer Mode/);
});

test('D80 / owner answer 4: losing apps.mount detaches every cross-app mount (read-only and writable) and its declaration', async (t) => {
  const w = world(t, { devMode: true });
  await w.mm.add(CONSUMER, { targetAppId: 'io.t.src', mode: 'rw' });
  await w.mm.add(CONSUMER, { targetAppId: 'io.t.src', mode: 'ro', data: true });
  await w.mm.add(CONSUMER, { targetAppId: 'io.t.src', workspace: 'aura/workspaces/default/inst-io-t-src/1' });
  assert.equal(w.mm.list(CONSUMER).length, 3);
  const revoked = w.mm.revokeConsumer(CONSUMER).sort();
  assert.deepEqual(revoked, [`${CONSUMER}:io.t.src`, `${CONSUMER}:io.t.src:data`, `${CONSUMER}:io.t.src:work`].sort());
  assert.deepEqual(w.mm.list(CONSUMER), []);
  assert.equal(w.kernel.size, 0, 'every bind is gone');
  assert.equal(fs.existsSync(join(w.dataDir, 'aura', 'mounts', '.state', `${CONSUMER}.json`)), false, 'no declaration a later spawn would restore');
});

test('D80: an idmapped mount that arrives without its idmapping is rolled back', async (t) => {
  const w = world(t, { dropIdmap: true });
  await assert.rejects(w.mm.add(CONSUMER, { targetAppId: 'io.t.src', mode: 'rw', data: true }), /without its idmapping/);
  assert.equal(w.kernel.size, 0, 'rolled back');
});

test('D80: revokeWritable makes the idmapped source mount read-only again, and its declaration', async (t) => {
  const w = world(t, { devMode: true });
  await w.mm.add(CONSUMER, { targetAppId: 'io.t.src', mode: 'rw' });
  await w.mm.add(CONSUMER, { targetAppId: 'io.t.src', mode: 'rw', data: true });
  w.setDev(false);
  const revoked = await w.mm.revokeWritable((m) => m.kind === 'source' && !!m.idmap);
  assert.deepEqual(revoked, [`${CONSUMER}:io.t.src`]);
  const byId = Object.fromEntries(w.mm.list(CONSUMER).map((m) => [m.id, m]));
  assert.equal(byId['io.t.src'].mode, 'ro');
  assert.equal(byId['io.t.src'].idmap, undefined);
  assert.equal(byId['io.t.src:data'].mode, 'rw', 'the data mount was not selected');
  const decls = JSON.parse(fs.readFileSync(join(w.dataDir, 'aura', 'mounts', '.state', `${CONSUMER}.json`), 'utf-8'));
  assert.equal(decls.find((d) => !d.data).mode, 'ro');
});

test('D80: the request need idmap-mount names idmappedMounts; the container runtime declares it only after a passing probe', async () => {
  assert.deepEqual(missingCapabilities({ mounts: true, idmappedMounts: false }, requestNeeds('idmap-mount')), ['idmappedMounts']);
  assert.equal(ContainerRunner.prototype.capabilities.call({}).idmappedMounts, false, 'not probed: false');
  assert.equal(ContainerRunner.prototype.capabilities.call({ idmapProbe: { ok: false } }).idmappedMounts, false);
  assert.equal(ContainerRunner.prototype.capabilities.call({ idmapProbe: { ok: true } }).idmappedMounts, true);
});

test('D80 probe: true when the launcher accepts an idmapped tree, false (with the reason) when it fails; argv fixed', async (t) => {
  const dataDir = fs.mkdtempSync(join(tmpdir(), 'aura-idmap-probe-'));
  const bin = join(dataDir, 'fake-launcher');
  fs.writeFileSync(bin, '#!/bin/sh\n');
  const prev = process.env['AURA_SESSION_ENTER'];
  process.env['AURA_SESSION_ENTER'] = bin;
  t.after(() => { if (prev === undefined) delete process.env['AURA_SESSION_ENTER']; else process.env['AURA_SESSION_ENTER'] = prev; });
  const self = (o = {}) => Object.assign(Object.create(ContainerRunner.prototype), { dataDir, toDaemonHostPath: (p) => `/host${p}`, ...o });

  const okRunner = self();
  const seen = [];
  assert.deepEqual(await okRunner.probeIdmappedMounts(async (args) => { seen.push(args); }), { ok: true });
  assert.equal(okRunner.capabilities().idmappedMounts, true);
  assert.match(okRunner.idmapHelperHostPath(), /^\/host.*aura-session-enter-[0-9a-f]{16}$/);
  const args = seen[0];
  assert.deepEqual(args.slice(0, 6), ['run', '--rm', '--privileged', '--network', 'none', '--label']);
  assert.deepEqual(args.slice(-3), [IDMAP_HELPER_PATH, 'idmap-probe', '/probe']);
  assert.deepEqual(idmapProbeArgs({ helper: '/h', scratch: '/s', image: 'img' }),
    ['run', '--rm', '--privileged', '--network', 'none', '--label', 'aura.mount=1', '-v', `/h:${IDMAP_HELPER_PATH}:ro`, '-v', '/s:/probe', 'img', IDMAP_HELPER_PATH, 'idmap-probe', '/probe']);

  const bad = self();
  const r = await bad.probeIdmappedMounts(async () => { throw Object.assign(new Error('exit 125'), { stderr: 'aura-session-enter: idmapped mounts are not supported on /probe: Invalid argument\n' }); });
  assert.equal(r.ok, false);
  assert.match(r.reason, /not supported on \/probe/);
  assert.equal(bad.capabilities().idmappedMounts, false);
  assert.equal(bad.idmapHelperHostPath(), null);
});
