// Phase 5 stream J: in-environment sessions (D74, D79, J.2–J.7).
//
//   - the session broker's `docker run` (golden) and the launcher input it
//     builds from the kernel's spec (enterSpec);
//   - the launcher itself (os/session-enter/session-enter.c) compiled here and
//     its spec validation (`check`): a user session is never root, the socket
//     is a root tab's only, nothing outside the schema passes;
//   - the kernel's decision (AppManager.sessionContext): identity, home and
//     account files per home mode, J.5 (a root instance gets no private or
//     ephemeral session), D79 (--home app as the app's identity), D82 (a
//     member needs app.jump), J.6 (a root tab only in the user's own Terminal);
//   - J.7: `*` grants no docker, and the CLI spawns docker nowhere but `jump -m`.
//
// Run via: node tools/run-tests.mjs --only=core

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { brokerRunArgs, enterSpec, SESSION_BROKER_NAME } from '../dist/app-manager/SessionBroker.js';
import { AppManager } from '../dist/app-manager/AppManager.js';
import { ContainerRunner } from '../dist/app-manager/ContainerRunner.js';
import { ProotRunner } from '../dist/app-manager/ProotRunner.js';
import { kernelHomeResolver } from '../dist/homes/HomeResolver.js';
import { HomeDeniedError } from '../dist/homes/types.js';
import { RuntimeCapabilityError } from '../dist/runtimes/types.js';
import { toolsGrant } from '../dist/app-manager/tool-allowlist.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const CONTAINER = ContainerRunner.prototype.capabilities.call({});
const PROOT = ProotRunner.prototype.capabilities.call({});
const CID = 'a'.repeat(64);

const spec = (o = {}) => ({
  sessionId: 's-1', instanceId: 'io.test.app-1', kind: 'user', home: { mode: 'private', hostPath: '/data/aura/home/default' },
  uid: 1000, gid: 1000, groups: [1000], env: { HOME: '/home/aura', PATH: '/aura/my-tools:/usr/bin:/bin' }, argv: ['bash', '-l'],
  tty: true, cols: 80, rows: 24, ...o,
});

// ─── broker and launcher input ────────────────────────────────────────────

test('the broker: one privileged launcher container, the data volume at the shell\'s path, sleep only (J.2)', () => {
  assert.deepEqual(brokerRunArgs({ appDataVolume: 'aura_aura-app-data', dataDir: '/data', image: 'aura-base' }), [
    'run', '-d', '--name', SESSION_BROKER_NAME, '--label', 'aura.helper=session-broker',
    '--privileged', '--pid=host', '--cgroupns=host', '--network', 'none', '--restart', 'unless-stopped',
    '--mount', 'type=volume,source=aura_aura-app-data,target=/data',
    '-v', '/var/run/docker.sock:/var/run/docker.sock',
    '--entrypoint', 'sleep', 'aura-base', 'infinity',
  ]);
});

test('enterSpec: the kernel\'s spec and the engine\'s facts only; the socket is a root tab\'s only', () => {
  const user = enterSpec(spec(), { containerId: CID, pid: 4321 });
  assert.deepEqual(Object.keys(user).sort(), ['argv', 'container', 'env', 'gid', 'groups', 'home', 'homePath', 'kind', 'pid', 'sid', 'tty', 'uid', 'v']);
  assert.equal(user.homePath, '/data/aura/home/default');
  const smuggled = enterSpec(spec({ dockerSocket: true }), { containerId: CID, pid: 4321 }, { dockerCli: '/data/aura/toolchain/bin/docker' });
  assert.equal(smuggled.socket, undefined, 'a user session never gets the socket, whatever the spec says');
  const root = enterSpec(spec({ kind: 'root', uid: 0, gid: 0, groups: [], dockerSocket: true }), { containerId: CID, pid: 4321 }, { dockerCli: '/data/aura/toolchain/bin/docker' });
  assert.deepEqual([root.socket, root.dockerCli], ['/var/run/docker.sock', '/data/aura/toolchain/bin/docker']);
  assert.ok(root.env.includes('PATH=/run/aura-session/bin:/aura/my-tools:/usr/bin:/bin'));
  const eph = enterSpec(spec({ home: { mode: 'ephemeral', hostPath: null } }), { containerId: CID, pid: 4321 });
  assert.equal(eph.homePath, undefined);
  assert.throws(() => enterSpec(spec(), { containerId: 'abc', pid: 4321 }), /full container id/);
  assert.throws(() => enterSpec(spec(), { containerId: CID, pid: 1 }), /no running init/);
  assert.throws(() => enterSpec(spec({ home: { mode: 'private', hostPath: null } }), { containerId: CID, pid: 4321 }), /no Private Home/);
});

// ─── the launcher (C) ─────────────────────────────────────────────────────

const helper = (() => {
  const out = join(mkdtempSync(join(tmpdir(), 'session-enter-')), 'aura-session-enter');
  execFileSync('cc', ['-std=gnu11', '-O2', '-Wall', '-Wextra', '-Werror', '-static', '-o', out, join(REPO, 'os', 'session-enter', 'session-enter.c')], { stdio: 'pipe' });
  return out;
})();
const check = (input) => spawnSync(helper, ['check', typeof input === 'string' ? input : JSON.stringify(input)], { encoding: 'utf-8' });

test('the launcher compiles warning-free and accepts what enterSpec builds', () => {
  assert.equal(spawnSync(helper, ['version'], { encoding: 'utf-8' }).stdout.trim(), '1');
  const ok = check(enterSpec(spec(), { containerId: CID, pid: 4321 }));
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^kind=user home=private uid=1000 gid=1000 groups=1 tty=1 argv0=bash socket=0$/m);
  const root = check(enterSpec(spec({ kind: 'root', uid: 0, gid: 0, groups: [], dockerSocket: true }), { containerId: CID, pid: 4321 }));
  assert.equal(root.status, 0, root.stderr);
  assert.match(root.stdout, /kind=root .* socket=1/);
  const app = check(enterSpec(spec({ kind: 'app', home: { mode: 'app', hostPath: null }, uid: 200001, gid: 200001, groups: [] }), { containerId: CID, pid: 4321 }));
  assert.equal(app.status, 0, app.stderr);
});

test('the launcher refuses every spec outside its rules (exit 125, nothing touched)', () => {
  const base = enterSpec(spec(), { containerId: CID, pid: 4321 });
  const refused = [
    ['not JSON', '{'],
    ['trailing data', `${JSON.stringify(base)} x`],
    ['a user session as root', { ...base, uid: 0 }],
    ['a user session with gid 0', { ...base, gid: 0 }],
    ['a user session with group 0', { ...base, groups: [1000, 0] }],
    ['the socket in a user session', { ...base, socket: '/var/run/docker.sock' }],
    ['a root tab not as 0:0', { ...base, kind: 'root', uid: 1000 }],
    ['an app session with a Private Home', { ...base, kind: 'app' }],
    ['the App Home for a user', { ...base, home: 'app' }],
    ['a short container id', { ...base, container: 'abc' }],
    ['pid 1', { ...base, pid: 1 }],
    ['a relative home path', { ...base, homePath: 'home/x' }],
    ['a home path with ..', { ...base, homePath: '/data/aura/home/../../etc' }],
    ['no argv', { ...base, argv: [] }],
    ['env without =', { ...base, env: ['NOPE'] }],
    ['an unknown kind', { ...base, kind: 'admin' }],
    ['a NUL in a string', `{"v":1,"sid":"a\\u0000b"}`],
    ['another version', { ...base, v: 2 }],
  ];
  for (const [why, input] of refused) {
    const r = check(input);
    assert.equal(r.status, 125, `${why}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /^aura-session-enter: /, why);
  }
  assert.equal(spawnSync(helper, ['enter'], { encoding: 'utf-8' }).status, 2, 'usage');
});

// ─── the kernel's decision ────────────────────────────────────────────────

const USERS = { default: { uid: 1000, gid: 1000 }, 'u-bob': { uid: 100000, gid: 100000 } };

/** AppManager.sessionContext on a fake manager: the real resolver over a temp data dir. */
function manager({ runAs = 'app', instRunAs = runAs, runtime = CONTAINER, appId = 'io.test.app', owner = 'default', grants = [] } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'aura-sessions-'));
  const inst = { appId, instanceId: `${appId}-1`, owner, runAs: instRunAs, ...(instRunAs === 'app' ? { uid: 200001, gid: 200001 } : { uid: 0, gid: 0 }) };
  const fake = {
    instances: new Map([[inst.instanceId, inst]]),
    registry: { getById: (id) => (id === appId ? { id: appId, environmentScope: 'global' } : undefined) },
    installationRunAs: async () => ({ installationId: 'inst-1', runAs }),
    runnerOf: () => ({ capabilities: () => runtime }),
    homes: kernelHomeResolver({
      dataDir, userIdentity: async (id) => USERS[id] ?? null,
      mayJumpApp: async (p, i) => grants.includes(`${p.userId}:${i}`),
    }),
    mayJumpApp: async (userId, i) => grants.includes(`${userId}:${i}`),
    userLinuxIdentity: async (id) => USERS[id] ?? null,
  };
  return { dataDir, ctx: (mode, caller) => AppManager.prototype.sessionContext.call(fake, inst.instanceId, { mode, caller }) };
}
const OWNER = { user: { userId: 'default', role: 'owner' } };
const BOB = { user: { userId: 'u-bob', role: 'member' } };

test('private: the user\'s uid/gid and Private Home, passwd with the user and the app (D67, D70)', async () => {
  const m = manager();
  const c = await m.ctx('private', OWNER);
  assert.deepEqual([c.kind, c.home.mode, c.home.hostPath, c.uid, c.gid, c.groups], ['user', 'private', join(m.dataDir, 'aura/home/default'), 1000, 1000, [1000]]);
  assert.equal(statSync(c.home.hostPath).mode & 0o777, 0o700, 'created 0700 by the resolver');
  assert.match(c.passwd, /^aura-user-1000:x:1000:1000:AuraOS user:\/home\/aura:\/bin\/bash$/m);
  assert.match(c.passwd, /^app-inst1:x:200001:200001:AuraOS app:\/home\/aura:\/bin\/bash$/m);
  assert.ok(!/^node:/m.test(c.passwd), 'the owner\'s uid 1000 replaces the image\'s node');
  assert.deepEqual([c.env.HOME, c.env.USER, c.env.TMPDIR], ['/home/aura', 'aura-user-1000', '/run/aura-session']);
  assert.equal(c.dockerSocket, undefined);
  const e = await m.ctx('ephemeral', OWNER);
  assert.deepEqual([e.kind, e.home.mode, e.home.hostPath, e.uid], ['user', 'ephemeral', null, 1000]);
});

test('J.5: a root instance (runtime flag aside) gets no private or ephemeral session; the installation\'s runAs decides', async () => {
  for (const [runAs, instRunAs] of [['root', 'root'], ['root', 'app'], ['app', 'root']]) {
    const m = manager({ runAs, instRunAs });
    for (const mode of ['private', 'ephemeral']) {
      await assert.rejects(m.ctx(mode, OWNER), (e) => e instanceof HomeDeniedError && e.reason === 'root-instance', `${runAs}/${instRunAs} ${mode}`);
    }
    const app = await m.ctx('app', OWNER);
    assert.deepEqual([app.kind, app.uid, app.gid], ['app', 0, 0], 'the owner may enter a root instance as the app (root without capabilities)');
    await assert.rejects(manager({ runAs, instRunAs, grants: ['u-bob:inst-1'] }).ctx('app', BOB), (e) => e.reason === 'not-authorized', 'a root instance is the owner\'s only');
  }
});

test('PRoot fails closed for every mode, with no fallback (J.5)', async () => {
  const m = manager({ runtime: PROOT });
  for (const mode of ['private', 'app', 'ephemeral']) {
    await assert.rejects(m.ctx(mode, OWNER), (e) => e instanceof RuntimeCapabilityError && e.missing.includes('sessionExec'), mode);
  }
});

test('D79: --home app runs as the app\'s uid/gid with its App Home; the user is only authorized and audited', async () => {
  const m = manager();
  const c = await m.ctx('app', OWNER);
  assert.deepEqual([c.kind, c.home.mode, c.home.hostPath, c.uid, c.gid, c.userId], ['app', 'app', null, 200001, 200001, 'default']);
  assert.ok(!c.passwd.includes('aura-user-'), 'no user account in an app session');
});

test('D82: a member needs app.jump for every mode; with it, their own uid and Private Home', async () => {
  await assert.rejects(manager().ctx('private', BOB), (e) => e.reason === 'not-authorized');
  await assert.rejects(manager().ctx('app', BOB), (e) => e.reason === 'not-authorized');
  const m = manager({ grants: ['u-bob:inst-1'] });
  const c = await m.ctx('private', BOB);
  assert.deepEqual([c.uid, c.gid, c.home.hostPath], [100000, 100000, join(m.dataDir, 'aura/home/u-bob')]);
});

test('the instance itself: the app identity only; never a Private Home', async () => {
  const m = manager();
  const c = await m.ctx('app', {});
  assert.deepEqual([c.kind, c.uid, c.home.mode], ['app', 200001, 'app']);
  await assert.rejects(m.ctx('private', {}), (e) => e.reason === 'not-authorized');
});

test('J.6: a root tab only in the user\'s own Terminal instance, with the socket and their Private Home', async () => {
  await assert.rejects(manager().ctx('private', { ...OWNER, root: true }), (e) => e.reason === 'not-authorized', 'not a Terminal');
  await assert.rejects(manager({ appId: 'com.aura.terminal', owner: 'u-bob', runAs: 'root' }).ctx('private', { ...OWNER, root: true }), (e) => e.reason === 'not-authorized', 'another user\'s Terminal');
  const m = manager({ appId: 'com.aura.terminal', runAs: 'root' });
  const c = await m.ctx('private', { ...OWNER, root: true });
  assert.deepEqual([c.kind, c.uid, c.gid, c.dockerSocket, c.home.hostPath], ['root', 0, 0, true, join(m.dataDir, 'aura/home/default')]);
});

// ─── J.7 ──────────────────────────────────────────────────────────────────

test('J.7: `*` and `#` never grant docker; the CLI spawns docker only for `jump -m` in a root tab', () => {
  assert.equal(toolsGrant(['*'], 'docker'), false);
  assert.equal(toolsGrant(['#'], 'docker'), false);
  assert.equal(toolsGrant(['*'], 'git'), true);
  assert.equal(toolsGrant(['docker'], 'docker'), true, 'named explicitly: still no socket (spawn/socketArgs.ts), only a contract warning');
  const cli = join(REPO, 'packages', 'aura-cli', 'src');
  const hits = [];
  const walk = (d) => {
    for (const f of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, f.name);
      if (f.isDirectory()) walk(p);
      else if (/\.ts$/.test(f.name)) {
        readFileSync(p, 'utf-8').split('\n').forEach((line, i) => {
          if (/(spawn|spawnSync|execFile|execFileSync|exec|execSync)\(\s*['"`](docker|proot)\b/.test(line)) hits.push(`${p.slice(cli.length + 1)}:${i + 1}`);
        });
      }
    }
  };
  walk(cli);
  assert.equal(hits.length, 1, hits.join(', '));
  assert.match(hits[0], /^commands\/jump\.ts:/, 'only enterMasterContainer, which refuses without the socket');
  assert.ok(!readFileSync(join(cli, 'lib', 'exec-client.ts'), 'utf-8').includes('AURA_EXEC_VIA'));
});
