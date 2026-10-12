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
import { MountManager, isSidecarConsumer, parentOfConsumer } from '../dist/app-manager/MountManager.js';

const INST = 'io.test.app-2';
const SC = `${INST}--box`;

function world(t, { noCat = new Set(), noMountRoot = new Set(), pidFallbackFails = false } = {}) {
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
    registry: { getById: (id) => (id.startsWith('gone.') ? undefined : { id, appDir: `/workspace/apps/${id}`, scopeId: 'system' }) },
    scopeRegistry: { getById: () => ({ dataDir: join(dataDir, 'scopes', 'system') }) },
    runner: {
      canPropagateMounts: () => ({ ok: true }),
      mountRootDir,
      toDaemonHostPath: (p) => p,
    },
    instanceDataDir: (k) => join(dataDir, 'scopes', 'system', 'apps', 'io.test.app', parentOfConsumer(k)),
    fanoutTargets: () => targets,
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
