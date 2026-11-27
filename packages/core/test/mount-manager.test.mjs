// MountManager with OS sidecars as consumers (`<inst>--<sidecar>`), against a
// fake kernel: sidecar paths and declarations, the /mnt/aura requirement,
// fan-out of the parent's mounts (exclude, read-only cap, detach), inherited
// mounts never persisted, verification via the PID-namespace fallback for
// images without `cat`, and reconcile/sweep/forget for sidecar consumers.
//
//   pnpm --filter @aura/core test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MountManager, KIND_POLICY, isSidecarConsumer, parentOfConsumer } from '../dist/app-manager/MountManager.js';

const INST = 'io.test.app-2';
const SC = `${INST}--box`;

function world(t, { noCat = new Set(), noMountRoot = new Set(), pidFallbackFails = false, closed = new Set(), identity = null } = {}) {
  const dataDir = fs.mkdtempSync(join(tmpdir(), 'aura-mm-'));
  const kernel = new Map();   // shell-side dest → 'ro' | 'rw'
  const calls = [];
  const realRead = fs.readFileSync;
  const mountRootDir = (k) => join(dataDir, 'aura', 'mounts', k);
  const viewOf = (consumer) => [...kernel].filter(([dest]) => dest.startsWith(`${mountRootDir(consumer)}/`))
    .map(([dest, mode]) => `9 1 0:1 / /mnt/aura/${dest.slice(mountRootDir(consumer).length + 1)} ${mode},relatime - ext4 x ${mode}`)
    .join('\n') + '\n';
  const consumerOf = (container) => container.replace(/^aura-/, '');

  t.mock.method(fs, 'readFileSync', (p, ...rest) => {
    if (p === '/proc/self/mountinfo') {
      return [...kernel].map(([dest, mode]) => `5 1 0:1 / ${dest} ${mode},relatime master:1 - ext4 x ${mode}`).join('\n') + '\n';
    }
    return realRead(p, ...rest);
  });
  t.mock.method(childProcess, 'execSync', (cmd) => {
    calls.push(cmd);
    const container = cmd.trim().split(' ').at(-1);
    return noMountRoot.has(consumerOf(container)) ? '/data\n' : '/mnt/aura\n/data\n';
  });
  t.mock.method(childProcess, 'execFileSync', (cmd, args) => {
    assert.equal(cmd, 'docker');
    calls.push(args);
    if (args[0] === 'exec') {
      const consumer = consumerOf(args[1]);
      if (noCat.has(consumer)) throw new Error('exec: "cat": executable file not found');
      return viewOf(consumer);
    }
    const pid = args.find((a) => a.startsWith('--pid=container:'));
    if (pid) {
      if (pidFallbackFails) throw new Error('no such container');
      return viewOf(consumerOf(pid.slice('--pid=container:'.length)));
    }
    // privileged helper: bind or unbind
    const script = args[args.indexOf('-euc') + 1];
    const dest = args.at(-1);
    if (script.includes('mount --bind')) {
      const src = args.find((a) => a.endsWith(':/src') || a.endsWith(':/src:ro'));
      kernel.set(dest, src.endsWith(':ro') ? 'ro' : 'rw');
    } else kernel.delete(dest);
    return '';
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });

  let targets = [];
  const mm = new MountManager({
    dataDir,
    registry: { getById: (id) => (id.startsWith('gone.') ? undefined : { id, appDir: `/workspace/apps/${id}`, scopeId: id.startsWith('com.aura.') ? 'system' : 'global' }) },
    scopeRegistry: { getById: () => ({ dataDir: join(dataDir, 'scopes', 'system') }) },
    runner: {
      canPropagateMounts: () => ({ ok: true }),
      mountRootDir,
      toDaemonHostPath: (p) => p,
    },
    instanceDataDir: (k) => join(dataDir, 'scopes', 'system', 'apps', 'io.test.app', parentOfConsumer(k)),
    fanoutTargets: () => targets,
    sourceMode: (id) => (closed.has(id) ? 'closed' : 'open'),
    consumerIdentity: () => identity,
  });
  return {
    mm, kernel, calls, dataDir, mountRootDir,
    setTargets: (x) => { targets = x; },
    decls: (k) => { try { return JSON.parse(realRead(join(dataDir, 'aura', 'mounts', '.state', `${k}.json`), 'utf-8')); } catch { return null; } },
  };
}

test('consumer keys: <inst>--<sidecar>', () => {
  assert.equal(isSidecarConsumer(SC), true);
  assert.equal(isSidecarConsumer('io.test.app-2'), false);
  assert.equal(parentOfConsumer(SC), INST);
  assert.equal(parentOfConsumer(INST), INST);
});

test('a sidecar mount lands under its own root, verified, and is declared under its key', async (t) => {
  const w = world(t);
  const m = await w.mm.add(SC, { targetAppId: 'com.aura.docs' });
  assert.equal(m.containerPath, '/mnt/aura/com.aura.docs');
  assert.equal(m.hostDest, join(w.mountRootDir(SC), 'com.aura.docs'));
  assert.equal(w.kernel.get(m.hostDest), 'ro');
  assert.deepEqual(w.decls(SC).map((d) => d.targetAppId), ['com.aura.docs']);
  assert.ok(w.calls.some((a) => Array.isArray(a) && a.includes(`aura.parent=${INST}`)), 'helpers are labelled with the parent instance');
});

test('a sidecar without /mnt/aura is refused (no legacy /data/.mnt for sidecars)', async (t) => {
  const w = world(t, { noMountRoot: new Set([SC]) });
  await assert.rejects(w.mm.add(SC, { targetAppId: 'com.aura.docs' }), /has no mount root at \/mnt\/aura/);
});

test('images without cat: verified through the PID namespace; an unverifiable ro mount is refused', async (t) => {
  const ok = world(t, { noCat: new Set([SC]) });
  await ok.mm.add(SC, { targetAppId: 'com.aura.docs' });
  assert.ok(ok.calls.some((a) => Array.isArray(a) && a.includes(`--pid=container:aura-${SC}`)));

  const bad = world(t, { noCat: new Set([SC]), pidFallbackFails: true });
  await assert.rejects(bad.mm.add(SC, { targetAppId: 'com.aura.docs' }), /refusing an unverified ro mount/);
  assert.equal(bad.kernel.size, 0, 'rolled back');
});

test('fan-out: parent add/remove mirrors into inheriting sidecars, honouring exclude and the ro cap', async (t) => {
  const w = world(t);
  const other = `${INST}--other`;
  w.setTargets([{ consumer: SC, exclude: ['com.secret'], forceRo: true }, { consumer: other, exclude: [], forceRo: false }]);
  await w.mm.add(INST, { targetAppId: 'com.aura.docs', mode: 'rw' });
  await w.mm.add(INST, { targetAppId: 'com.secret' });
  await w.mm.settled();
  assert.equal(w.kernel.get(join(w.mountRootDir(SC), 'com.aura.docs')), 'ro', 'capped at read-only');
  assert.equal(w.kernel.get(join(w.mountRootDir(other), 'com.aura.docs')), 'rw');
  assert.equal(w.kernel.has(join(w.mountRootDir(SC), 'com.secret')), false, 'excluded');
  const inherited = w.mm.list(SC).find((m) => m.id === 'com.aura.docs');
  assert.equal(inherited.origin, 'inherited');
  assert.equal(inherited.inheritedFrom, INST);
  assert.equal(w.decls(SC), null, 'inherited mounts are never declared');
  await assert.rejects(w.mm.remove(SC, 'com.aura.docs'), /is inherited from/);

  await w.mm.remove(INST, 'com.aura.docs');
  await w.mm.settled();
  assert.equal(w.kernel.has(join(w.mountRootDir(SC), 'com.aura.docs')), false);
  assert.equal(w.kernel.has(join(w.mountRootDir(other), 'com.aura.docs')), false);
});

test('reapplyConsumer: own declarations first, then the parent set minus exclude', async (t) => {
  const w = world(t);
  await w.mm.add(INST, { targetAppId: 'a.a' });
  await w.mm.add(INST, { targetAppId: 'b.b', mode: 'rw' });
  await w.mm.add(SC, { targetAppId: 'own.app' });
  w.mm.removeAll(SC);                       // container recreated: binds gone, declarations stay
  assert.equal(w.mm.list(SC).length, 0);
  const r = await w.mm.reapplyConsumer(SC, { inherit: true, exclude: ['b.b'], forceRo: false });
  assert.deepEqual(r, { restored: 1, inherited: 1, failed: 0 });
  assert.deepEqual(w.mm.list(SC).map((m) => [m.id, m.origin]).sort(), [['a.a', 'inherited'], ['own.app', 'restored']]);
  assert.deepEqual(w.decls(SC).map((d) => d.targetAppId), ['own.app']);
});

test('removeAll(parent) drops sidecar binds but keeps their declarations; forget(parent) drops both', async (t) => {
  const w = world(t);
  await w.mm.add(INST, { targetAppId: 'a.a' });
  await w.mm.add(SC, { targetAppId: 'own.app' });
  w.mm.removeAll(INST);
  assert.equal(w.kernel.size, 0);
  assert.ok(w.decls(SC), 'crash: the respawned sidecar gets its mounts back');
  w.mm.forget(INST);
  assert.equal(w.decls(SC), null);
});

test('reconcile: live sidecar binds adopted (inherited vs own), dead ones reaped, declarations swept', async (t) => {
  const w = world(t);
  const dead = 'io.dead.app-9--x';
  // Previous shell generation left these in the kernel and on disk.
  w.kernel.set(join(w.mountRootDir(SC), 'own.app'), 'ro');
  w.kernel.set(join(w.mountRootDir(SC), 'a.a'), 'rw');
  w.kernel.set(join(w.mountRootDir(dead), 'z.z'), 'ro');
  fs.mkdirSync(join(w.dataDir, 'aura', 'mounts', '.state'), { recursive: true });
  fs.writeFileSync(join(w.dataDir, 'aura', 'mounts', '.state', `${SC}.json`), JSON.stringify([{ targetAppId: 'own.app', mode: 'ro' }]));
  fs.writeFileSync(join(w.dataDir, 'aura', 'mounts', '.state', `${dead}.json`), JSON.stringify([{ targetAppId: 'z.z' }]));

  const r = w.mm.reconcile(new Set([INST, SC]));
  assert.deepEqual(r, { adopted: 2, reaped: 1 });
  assert.equal(w.kernel.has(join(w.mountRootDir(dead), 'z.z')), false);
  const byId = Object.fromEntries(w.mm.list(SC).map((m) => [m.id, m.origin]));
  assert.deepEqual(byId, { 'own.app': 'adopted', 'a.a': 'inherited' });
  assert.deepEqual(w.decls(SC).map((d) => d.targetAppId), ['own.app'], 'inherited stays undeclared');
  assert.equal(w.decls(dead), null, 'a dead instance\'s sidecar declarations are swept');
});

test('forget(parent) also removes the empty root of a sidecar whose mounts were all detached', async (t) => {
  const w = world(t);
  await w.mm.add(SC, { targetAppId: 'own.app' });
  await w.mm.remove(SC, 'own.app');
  assert.equal(w.decls(SC), null);
  fs.mkdirSync(w.mountRootDir(SC), { recursive: true });   // SidecarManager creates it at spawn
  w.mm.forget(INST);
  assert.equal(fs.existsSync(w.mountRootDir(SC)), false);
});

test('forgetConsumer: unmounts, drops declarations, removes the empty root', async (t) => {
  const w = world(t);
  await w.mm.add(SC, { targetAppId: 'own.app' });
  w.mm.forgetConsumer(SC);
  assert.equal(w.kernel.size, 0);
  assert.equal(w.decls(SC), null);
  assert.equal(fs.existsSync(w.mountRootDir(SC)), false);
});

test('rebindTarget: an app whose dir was replaced is re-bound everywhere, same mode, origin and declaration', async (t) => {
  const w = world(t);
  w.setTargets([{ consumer: SC, exclude: [], forceRo: true }]);
  await w.mm.add(INST, { targetAppId: 'io.target.app', mode: 'rw' });
  await w.mm.add(INST, { targetAppId: 'io.target.app', data: true });
  await w.mm.add(INST, { targetAppId: 'com.aura.docs' });
  await w.mm.settled();
  const declsBefore = w.decls(INST);
  const binds = (dest) => w.calls.filter((a) => Array.isArray(a) && a.at(-1) === dest
    && a[a.indexOf('-euc') + 1]?.includes('mount --bind')).length;
  const src = join(w.mountRootDir(INST), 'io.target.app');
  const inherited = join(w.mountRootDir(SC), 'io.target.app');
  const docs = join(w.mountRootDir(INST), 'com.aura.docs');
  const before = { src: binds(src), inherited: binds(inherited), docs: binds(docs) };

  const r = await w.mm.rebindTarget('io.target.app');
  assert.deepEqual(r, { rebound: 4, failed: 0 }, 'source + data in the instance, and both inherited copies in the sidecar');
  assert.equal(binds(src), before.src + 1, 're-bound');
  assert.equal(binds(inherited), before.inherited + 1, 're-bound once, not twice');
  assert.equal(binds(docs), before.docs, 'other apps untouched');
  assert.equal(w.kernel.get(src), 'rw');
  assert.equal(w.kernel.get(inherited), 'ro', 'the sidecar keeps its read-only cap');
  assert.deepEqual(w.mm.list(INST).map((m) => [m.id, m.mode, m.origin]).sort(),
    [['com.aura.docs', 'ro', 'added'], ['io.target.app', 'rw', 'added'], ['io.target.app:data', 'ro', 'added']]);
  const sc = w.mm.list(SC).find((m) => m.id === 'io.target.app');
  assert.equal(sc.origin, 'inherited');
  assert.equal(sc.inheritedFrom, INST);
  assert.deepEqual(w.decls(INST), declsBefore, 'declarations unchanged');
  assert.equal(w.decls(SC), null);
  assert.deepEqual(await w.mm.rebindTarget('io.not.mounted'), { rebound: 0, failed: 0 });
});

// ── the AuraOS checkout (`aura mount workspace`, D60) ───────────────────────

test('workspace: /workspace read-write at /mnt/aura/workspace, never declared, never mirrored', async (t) => {
  const w = world(t);
  w.setTargets([{ consumer: SC, exclude: [], forceRo: false }]);
  await w.mm.add(INST, { targetAppId: 'com.aura.docs' });
  const m = await w.mm.addWorkspace(INST);
  await w.mm.settled();
  assert.equal(m.id, 'workspace');
  assert.equal(m.kind, 'workspace');
  assert.equal(m.mode, 'rw');
  assert.equal(m.containerPath, '/mnt/aura/workspace');
  assert.equal(w.kernel.get(m.hostDest), 'rw');
  assert.ok(w.calls.some((a) => Array.isArray(a) && a.includes('/workspace:/src')), 'bound from /workspace, writable');
  assert.deepEqual(w.decls(INST).map((d) => d.targetAppId), ['com.aura.docs'], 'the checkout is not declared');
  assert.deepEqual(w.mm.list(SC).map((x) => x.id), ['com.aura.docs'], 'not mirrored into the sidecar');
  assert.deepEqual(w.mm.workspaceMounts().map((x) => x.instanceId), [INST]);
  await assert.rejects(w.mm.addWorkspace(INST), /already mounted/);
  await assert.rejects(w.mm.addWorkspace(SC), /never mounted into a sidecar/);

  const r = await w.mm.reapplyConsumer(SC, { inherit: true, exclude: [], forceRo: false });
  assert.equal(r.failed, 0);
  assert.ok(!w.mm.list(SC).some((x) => x.kind === 'workspace'), 'a sidecar start does not inherit it');

  await w.mm.remove(INST, 'workspace');
  assert.equal(w.kernel.has(m.hostDest), false);
  assert.deepEqual(w.mm.workspaceMounts(), []);
});

test('workspace: reconcile adopts a live checkout bind as the workspace kind and does not declare it', async (t) => {
  const w = world(t);
  await w.mm.addWorkspace(INST);
  const fresh = new MountManager({ ...w.mm.opts });
  fresh.reconcile(new Set([INST]));
  const [m] = fresh.workspaceMounts();
  assert.equal(m?.kind, 'workspace');
  assert.equal(m?.id, 'workspace');
  assert.equal(w.decls(INST), null, 'still not declared');
  assert.deepEqual(fresh.reconcile(new Set()), { adopted: 0, reaped: 1 }, 'a dead instance\'s bind is reaped');
});

// ── Track P: closed sources and patch workspaces ────────────────────────────

test('a closed install mounts its source read-only; a writable request is refused', async (t) => {
  const w = world(t, { closed: new Set(['io.shop.app']) });
  const m = await w.mm.add(INST, { targetAppId: 'io.shop.app' });
  assert.equal(m.mode, 'ro');
  assert.equal(w.kernel.get(m.hostDest), 'ro', 'bound from a read-only source: writes fail with EROFS');
  await w.mm.remove(INST, 'io.shop.app');
  await assert.rejects(w.mm.add(INST, { targetAppId: 'io.shop.app', mode: 'rw' }), /refusing a writable mount: io\.shop\.app is a closed install/);
  assert.equal(w.kernel.size, 0, 'nothing bound');
  // Data is not source: --wr on a closed app's data still works.
  const d = await w.mm.add(INST, { targetAppId: 'io.shop.app', data: true, mode: 'rw' });
  assert.equal(w.kernel.get(d.hostDest), 'rw');
});

test('a writable declaration of an app that is closed since comes back read-only', async (t) => {
  const closed = new Set();
  const w = world(t, { closed });
  await w.mm.add(INST, { targetAppId: 'io.shop.app', mode: 'rw' });
  closed.add('io.shop.app');
  w.mm.removeAll(INST);
  const r = await w.mm.reapply(INST);
  assert.equal(r.restored, 1);
  assert.equal(w.mm.list(INST)[0].mode, 'ro');
  // and a re-bind (closing it, or a replaced dir) persists read-only
  await w.mm.rebindTarget('io.shop.app');
  assert.equal(w.mm.list(INST)[0].mode, 'ro');
  assert.equal(w.decls(INST)[0].mode, 'ro');
});

test('a workspace binds writable at /mnt/aura/work/<app> in the calling consumer only', async (t) => {
  const w = world(t, { closed: new Set(['io.shop.app']) });
  w.setTargets([{ consumer: SC, exclude: [], forceRo: false }]);
  const ws = 'aura/workspaces/default/inst-1234/1';
  const m = await w.mm.add(INST, { targetAppId: 'io.shop.app', workspace: ws, mode: 'ro' });
  await w.mm.settled();
  assert.equal(m.id, 'io.shop.app:work');
  assert.equal(m.kind, 'work');
  assert.equal(m.mode, 'rw', 'a workspace is always writable, closed app or not');
  assert.equal(m.containerPath, '/mnt/aura/work/io.shop.app');
  assert.equal(m.hostSource, join(w.dataDir, ws), 'from the app-data volume, not the app dir');
  assert.ok(fs.existsSync(join(w.dataDir, ws)), 'the workspace dir is created');
  assert.equal(w.kernel.get(join(w.mountRootDir(INST), 'work', 'io.shop.app')), 'rw');
  assert.equal([...w.kernel.keys()].filter((k) => k.includes('/work/')).length, 1, 'no other consumer, no sidecar mirror');
  assert.deepEqual(w.decls(INST), [{ targetAppId: 'io.shop.app', mode: 'rw', data: false, declaredAt: m.declaredAt, workspace: ws }]);

  await assert.rejects(w.mm.add(INST, { targetAppId: 'io.other.app', workspace: '../../etc' }), /invalid workspace/);

  // The app's dir being replaced does not move a workspace.
  await w.mm.rebindTarget('io.shop.app');
  assert.equal(w.mm.list(INST).find((x) => x.id === 'io.shop.app:work').hostSource, join(w.dataDir, ws));

  // Restart: declared, restored; shell restart: adopted as a work mount.
  w.mm.removeAll(INST);
  assert.equal((await w.mm.reapply(INST)).restored, 1);
  const fresh = new MountManager({ ...w.mm.opts });
  fresh.reconcile(new Set([INST]));
  const adopted = fresh.list(INST).find((x) => x.id === 'io.shop.app:work');
  assert.equal(adopted.kind, 'work');
  assert.equal(adopted.workspace, ws);
  assert.equal(adopted.containerPath, '/mnt/aura/work/io.shop.app');

  await w.mm.remove(INST, 'io.shop.app:work');
  assert.equal(w.kernel.size, 0);
});

test('the patch repo binds writable at /mnt/aura/patches/<app>: one dir per installation, shared by every Terminal, outliving them', async (t) => {
  const w = world(t, { closed: new Set(['io.shop.app']) });
  const OTHER = 'io.test.app-3';
  const repo = 'aura/patches/inst-1234';
  const a = await w.mm.add(INST, { targetAppId: 'io.shop.app', patches: repo });
  const b = await w.mm.add(OTHER, { targetAppId: 'io.shop.app', patches: repo });
  assert.deepEqual([a.id, a.kind, a.mode, a.containerPath, a.patches], ['io.shop.app:patches', 'patches', 'rw', '/mnt/aura/patches/io.shop.app', repo]);
  assert.equal(a.hostSource, join(w.dataDir, repo), 'on the app-data volume, not in an instance\'s data');
  assert.equal(b.hostSource, a.hostSource, 'two Terminals, one repository');
  assert.equal(w.kernel.get(join(w.mountRootDir(OTHER), 'patches', 'io.shop.app')), 'rw');
  assert.deepEqual(w.decls(INST), [{ targetAppId: 'io.shop.app', mode: 'rw', data: false, declaredAt: a.declaredAt, patches: repo }]);
  await assert.rejects(w.mm.add(INST, { targetAppId: 'io.other.app', patches: 'aura/workspaces/x' }), /invalid patch repository/);

  // A workspace and the patch repo of one app live side by side.
  const ws = await w.mm.add(INST, { targetAppId: 'io.shop.app', workspace: 'aura/workspaces/default/inst-1234/1' });
  assert.equal(ws.containerPath, '/mnt/aura/work/io.shop.app');

  // The series written through one Terminal survives that Terminal going away.
  fs.writeFileSync(join(w.dataDir, repo, 'aura-patches.yaml'), 'app: io.shop.app\n');
  w.mm.removeAll(INST);
  w.mm.forget(INST);
  assert.equal(fs.readFileSync(join(w.dataDir, repo, 'aura-patches.yaml'), 'utf-8'), 'app: io.shop.app\n');
  assert.ok(w.mm.list(OTHER).some((m) => m.id === 'io.shop.app:patches'), 'still bound in the other Terminal');

  // Shell restart: adopted as a patches mount.
  const fresh = new MountManager({ ...w.mm.opts });
  fresh.reconcile(new Set([OTHER]));
  const adopted = fresh.list(OTHER).find((x) => x.id === 'io.shop.app:patches');
  assert.deepEqual([adopted.kind, adopted.patches, adopted.containerPath], ['patches', repo, '/mnt/aura/patches/io.shop.app']);
});

test('built-in: no patch repo or workspace mount of a built-in app (Q6)', async (t) => {
  const w = world(t);
  await assert.rejects(w.mm.add(INST, { targetAppId: 'com.aura.terminal', workspace: 'aura/workspaces/default/inst-sys/1' }), /built-in app.*system-app-later/);
  await assert.rejects(w.mm.add(INST, { targetAppId: 'com.aura.terminal', patches: 'aura/patches/inst-sys' }), /built-in app.*system-app-later/);
  assert.deepEqual(w.mm.list(INST), []);
  assert.equal(w.kernel.size, 0, 'nothing bound');
});

test('KIND_POLICY (F11): one row per kind, today\'s rules', () => {
  assert.deepEqual(Object.keys(KIND_POLICY).sort(), ['data', 'patches', 'source', 'work', 'workspace']);
  assert.ok(Object.isFrozen(KIND_POLICY));
  // Mirrored into sidecars live and re-bound on reinstall: only what lives in the target app's dir.
  for (const k of ['source', 'data']) assert.deepEqual([KIND_POLICY[k].fanout, KIND_POLICY[k].rebindOnReinstall, KIND_POLICY[k].modeRule], [true, true, 'requested'], k);
  // The consumer's own writable dirs: always rw, need the mount root, never of a built-in app (Q6).
  for (const k of ['work', 'patches']) {
    assert.deepEqual([KIND_POLICY[k].fanout, KIND_POLICY[k].rebindOnReinstall, KIND_POLICY[k].modeRule, KIND_POLICY[k].needsMountRoot, KIND_POLICY[k].builtInTargets],
      [false, false, 'always-rw', true, false], k);
  }
  // The AuraOS checkout: never declared, never mirrored.
  const ws = KIND_POLICY.workspace;
  assert.deepEqual([ws.persist, ws.fanout, ws.inheritToSidecar, ws.rebindOnReinstall], [false, false, false, false]);
  // No `socket` kind: the root tab gets the socket in its own session namespace (J.6, P5-4).
  assert.equal('socket' in KIND_POLICY, false);
});

test('5-main (VM finding): a fresh work/patches dir belongs to the consumer that writes it; existing and data dirs keep theirs', async (t) => {
  if (process.getuid?.() !== 0) return t.skip('needs root to chown');
  const who = { uid: 54321, gid: 54321 };
  const w = world(t, { identity: who });
  const ws = 'aura/workspaces/u-new/inst-9/1';
  await w.mm.add(INST, { targetAppId: 'io.shop.app', workspace: ws });
  await w.mm.settled();
  const own = (p) => { const st = fs.statSync(join(w.dataDir, p)); return [st.uid, st.gid]; };
  assert.deepEqual(own(ws), [who.uid, who.gid], 'the workspace dir');
  assert.deepEqual(own('aura/workspaces/u-new'), [who.uid, who.gid], 'the user dir it created on the way');
  assert.deepEqual(own('aura/workspaces'), [0, 0], 'a dir it did not create keeps its owner');
  // An existing dir is never re-owned.
  fs.mkdirSync(join(w.dataDir, 'aura/workspaces/u-new/inst-9/2'));
  await w.mm.add(INST, { targetAppId: 'io.shop.app', workspace: 'aura/workspaces/u-new/inst-9/2' }).catch(() => {});
  assert.deepEqual(own('aura/workspaces/u-new/inst-9/2'), [0, 0]);
});
