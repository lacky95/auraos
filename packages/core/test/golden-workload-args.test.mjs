// Golden workload and mount arguments (Phase 6 ari-rest, D-S and D-M): every
// `docker` call the OS sidecar path (SidecarManager over the container
// module's workloads group) and the cross-app mount path (MountManager over
// the container module's mounts group) make, per scenario, must stay
// byte-identical across the extraction into runtimes/container. The argv is
// recorded against a fake docker (no engine): create, start, the boot check,
// seed, tools, inheritHome and identity mounts, remove, exec, logs and
// reconcile for sidecars; the helper bind (plain, read-only, idmapped), the
// unbind, the consumer mount-table read (exec and the PID-namespace fallback)
// and the legacy-root inspect for mounts.
//
// Normalised: the temp data dir (<DATA>), timestamps (<TS>), the workload
// token and its nonce (<TOKEN>, <NONCE>). A deliberate change updates
// test/golden/workload-args.json in the same commit, owner-approved.
//
// Missing golden file: the test writes it from the current code and fails.
//
// Run via: node tools/run-tests.mjs --only=core
import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SidecarManager } from '../dist/app-manager/SidecarManager.js';
import { containerSidecars } from '../dist/runtimes/container/sidecars.js';
import { containerMounts } from '../dist/runtimes/container/mounts.js';
import { MountManager } from '../dist/app-manager/MountManager.js';
import { InstanceTokens } from '../dist/app-manager/InstanceTokens.js';

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), 'golden', 'workload-args.json');
const APP = 'io.test.app';
const INST = 'io.test.app-2';
const recorded = {};

function normalise(v, dataDir) {
  return JSON.parse(JSON.stringify(v).split(dataDir).join('<DATA>')
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, '<TS>')
    .replace(/AURA_INSTANCE_TOKEN=[^"\\]+/g, 'AURA_INSTANCE_TOKEN=<TOKEN>')
    .replace(/\\"nonce\\":\\"[^"\\]+\\"/g, '\\"nonce\\":\\"<NONCE>\\"'));
}

// ─── Sidecars ───────────────────────────────────────────────────────────────

/** In-memory docker CLI (execFile), recording every argv. */
function fakeDocker(t, { failStart = false, dieOnBoot = false, missingImages = [] } = {}) {
  const containers = new Map();
  const calls = [];
  let nextId = 1;
  const byRef = (ref) => containers.get(ref) ?? [...containers.values()].find((c) => c.id === ref);
  const reply = (cb, code, stdout = '', stderr = '') => queueMicrotask(() => {
    if (code === 0) cb(null, stdout, stderr);
    else cb(Object.assign(new Error(stderr || 'failed'), { code }), stdout, stderr);
  });
  t.mock.method(childProcess, 'execFile', (cmd, args, _opts, cb) => {
    assert.equal(cmd, 'docker');
    calls.push([...args]);
    // `docker --config <dir> pull …`: a credentialed pull (the auth file dir is the throwaway one).
    const [verb] = args[0] === '--config' ? args.slice(2) : args;
    if (verb === 'volume') reply(cb, args.at(-1) === `aura-${APP}-legacy` ? 0 : 1, '', 'no such volume');
    else if (verb === 'image') {
      if (args.includes('{{.Id}}') && missingImages.includes(args.at(-1))) reply(cb, 1, '', 'No such image');
      else reply(cb, 0, args.includes('{{.Id}}') ? 'sha256:x' : 'PATH=/usr/local/bin:/usr/bin:/bin\n');
    } else if (verb === 'pull') {
      const image = args.at(-1);
      if (image.startsWith('private.example/other/')) reply(cb, 1, '', 'Error response from daemon: unauthorized: authentication required');
      else { missingImages.splice(missingImages.indexOf(image), 1); reply(cb, 0); }
    }
    else if (verb === 'inspect') {
      const ref = args.at(-1);
      if (args[2]?.startsWith('{{range .Config.Env}}')) { reply(cb, 0, 'PARENT_ONLY=yes\nK1=from-parent\n'); return { stdin: { end() {} } }; }
      const c = byRef(ref);
      if (!c) reply(cb, 1, '', `No such object: ${ref}`);
      else reply(cb, 0, `/${c.name}\t${c.state}\t${JSON.stringify(c.labels)}\t0\n`);
    } else if (verb === 'ps') {
      const filters = args.flatMap((a, i) => (args[i - 1] === '--filter' ? [a.replace(/^label=/, '')] : []));
      const match = [...containers.values()].filter((c) => filters.every((f) => { const [k, v] = f.split('='); return c.labels[k] === v; }));
      const fmt = args[args.indexOf('--format') + 1];
      if (args.includes('-aq')) reply(cb, 0, match.map((c) => c.id).join('\n'));
      else if (fmt?.includes('{{.State}}')) reply(cb, 0, match.map((c) => `${c.name}\t${c.state}\t${c.labels['aura.sidecar.spec']}`).join('\n'));
      else reply(cb, 0, match.map((c) => `${c.name}\t${c.labels['aura.parent']}\t${c.labels['aura.sidecar.spec']}`).join('\n'));
    } else if (verb === 'create') {
      const name = args[args.indexOf('--name') + 1];
      const labels = {};
      args.forEach((a, i) => { if (args[i - 1] === '--label') { const j = a.indexOf('='); labels[a.slice(0, j)] = a.slice(j + 1); } });
      const id = `id${nextId++}`;
      containers.set(name, { id, name, state: 'created', labels });
      reply(cb, 0, `${id}\n`);
    } else if (verb === 'start') {
      const c = byRef(args[1]);
      if (failStart) reply(cb, 1, '', 'port is already allocated');
      else { c.state = dieOnBoot ? 'exited' : 'running'; reply(cb, 0); }
    } else if (verb === 'rm') {
      const c = byRef(args.at(-1));
      if (c) containers.delete(c.name);
      reply(cb, 0);
    } else if (verb === 'logs') reply(cb, 0, 'boom\n');
    else if (verb === 'exec') reply(cb, 0, 'hi\n', '');
    else reply(cb, 0);
    return { stdin: { end() {} } };
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return { containers, calls };
}

const SERVICES = [
  { name: 'box', image: 'alpine:3', command: ['sleep', 'infinity'], env: { A: '1' }, envInherit: ['CTX_KEY', 'K1'],
    volumes: [{ name: 'data', target: '/data' }], inheritIdentity: true, inheritMounts: true },
  { name: 'home', image: 'aura-base', command: ['node', 'w.js'], volumes: [], inheritHome: true, inheritIdentity: true, inheritPermissions: true },
  { name: 'worker', image: 'alpine:3', command: ['sleep', 'infinity'], volumes: [], inheritIdentity: true, tools: ['jq'] },
  { name: 'inh', image: 'alpine:3', command: [], volumes: [], inheritTools: true },
  { name: 'net', image: 'nettool:1', command: ['run'], volumes: [], capabilities: ['NET_ADMIN', 'NET_RAW'], devices: ['/dev/net/tun'],
    publish: [{ host: 18080, container: 8080 }], dns: ['1.1.1.1'], limits: { memory: '256m', cpus: 0.5 }, user: '1000:1000',
    workdir: '/srv', restart: 'always', port: 8080 },
  { name: 'db', image: 'postgres:16', command: [], volumes: [{ name: 'pg', target: '/var/lib/postgresql/data', shared: true }],
    seed: { command: ['init-db'] }, env: { POSTGRES_PASSWORD: 'x' } },
  { name: 'legacy', image: 'alpine:3', command: [], volumes: [{ name: 'legacy', target: '/old' }] },
  { name: 'priv', image: 'private.example/other/x:1', command: [], volumes: [] },
];

/** A Nexus source's login for one image (nexus PullCredential), with a fixed throwaway auth dir. */
const CRED = {
  source: 'src-a', host: 'private.example', repository: 'team/app',
  authFile: () => ({ dir: '/tmp/aura-auth-golden', file: '/tmp/aura-auth-golden/config.json', dispose() {} }),
  redact: (text) => text,
};

function sidecars(t, { toolsMode = 'hardlink', pullCredential } = {}) {
  const dataDir = fs.mkdtempSync(join(tmpdir(), 'aura-gw-'));
  fs.mkdirSync(join(dataDir, 'aura', 'toolchain', 'bin'), { recursive: true });
  for (const b of ['jq', 'rg']) fs.writeFileSync(join(dataDir, 'aura', 'toolchain', 'bin', b), `#!/bin/sh\necho ${b}\n`);
  const runner = {
    sidecarRuntime: () => ({ dataDir, appDataVolume: 'appvol', nodeModulesVolume: 'nm', network: 'aura-net',
      osApiBase: 'http://aura-shell:3000', shellHostname: 'aura-shell', workspaceRoot: '/ws', toolsMode }),
    mountRootDir: (k) => join(dataDir, 'aura', 'mounts', k),
    mountRootSubpath: (k) => `aura/mounts/${k}`,
    toolsDir: (k) => join(dataDir, 'aura', 'runtime', k, 'tools'),
    clearToolsDir: (k) => fs.rmSync(join(dataDir, 'aura', 'runtime', k, 'tools'), { recursive: true, force: true }),
  };
  const mgr = new SidecarManager({
    runner,
    workloads: containerSidecars(runner, { baseImage: 'aura-base' }),
    registry: { getById: (id) => (id === APP ? { id: APP, services: SERVICES, tools: ['jq', 'rg'], permissions: ['sidecars.spawn', 'net.raw'] } : undefined) },
    permissions: { hasPermission: (_app, p) => ['sidecars.tools', 'sidecars.privileged'].includes(p) },
    tokens: new InstanceTokens(join(dataDir, 'aura', 'secrets', 'k')),
    mounts: { reapplyConsumer: async () => ({ restored: 0, inherited: 0, failed: 0 }), removeAll: () => {}, forgetConsumer: () => {} },
    context: async () => ({ env: { CTX_KEY: 'ctx-value' }, known: new Set(['CTX_KEY']) }),
    ...(pullCredential ? { pullCredential } : {}),
    instance: (id) => (id === INST ? { appId: APP, instanceDataDir: join(dataDir, 'scopes/users/default/apps', APP, INST), identity: { uid: 200001, gid: 200001, range: 'app' } } : null),
    appHome: async () => ({ kind: 'app-global', hostPath: join(dataDir, 'aura/apphomes/i/global'), volumeSubpath: 'aura/apphomes/i/global',
      logicalPath: '/home/aura', uid: 200001, gid: 200001, mode: 0o700 }),
  });
  return { mgr, dataDir };
}

const app = { instanceId: INST };
const SIDECAR_SCENARIOS = {
  'spawn-basic': async (m) => { await m.spawn(INST, { template: 'box', env: { A: '2' } }, app); },
  'spawn-grandchild-adopt-recreate': async (m) => {
    await m.spawn(INST, { template: 'box', name: 'kid' }, app);
    await m.spawn(INST, { template: 'box', name: 'grandkid' }, { instanceId: INST, sidecar: 'kid' });
    await m.spawn(INST, { template: 'box', name: 'kid' }, app);
    await m.spawn(INST, { template: 'box', name: 'kid', env: { X: '1' } }, app);
  },
  'spawn-inherit-home-identity': async (m) => { await m.spawn(INST, { template: 'home' }, app); },
  'spawn-own-tools-mount-root': async (m) => { await m.spawn(INST, { template: 'worker', tools: ['rg'], mounts: { own: true } }, app); },
  'spawn-inherit-tools-symlink': async (m) => { await m.spawn(INST, { template: 'inh' }, app); },
  'spawn-privileged-net': async (m) => { await m.spawn(INST, { template: 'net' }, app); },
  'spawn-seed': async (m) => { await m.spawn(INST, { template: 'db' }, app); },
  'spawn-legacy-volume': async (m) => { await m.spawn(INST, { template: 'legacy' }, app); },
  'remove-exec-logs-reconcile': async (m, d) => {
    await m.spawn(INST, { template: 'box', name: 'kid' }, app);
    await m.spawn(INST, { template: 'box', name: 'grandkid' }, { instanceId: INST, sidecar: 'kid' });
    await m.exec(INST, 'kid', { cmd: ['echo', 'hi'], user: 'root', workdir: '/tmp', env: { E: '1' }, stdin: 'in' });
    await m.logs(INST, 'kid', { tail: 50, since: '10m', timestamps: true });
    await m.list(INST);
    await m.get(INST, 'kid');
    d.containers.set('aura-gone.app--x', { id: 'zz', name: 'aura-gone.app--x', state: 'running',
      labels: { 'aura.managed': 'os', 'aura.parent': 'gone.app', 'aura.sidecar.spec': JSON.stringify({ name: 'x', template: 'x', image: 'i', specHash: 'h', mounts: { own: false, inherit: false, exclude: [], forceRo: false }, createdAt: '' }) } });
    await m.reconcile(new Set([INST]));
    await m.remove(INST, 'kid');
  },
  'prepull': async (m) => { await m.prePull({ id: APP, services: [{ name: 'a', image: 'big:1', prePull: true }, { name: 'b', image: 'alpine:3', prePull: true }] }); },
};

for (const [name, run] of Object.entries(SIDECAR_SCENARIOS)) {
  test(`golden sidecar argv: ${name}`, async (t) => {
    const d = fakeDocker(t, name === 'prepull' ? { missingImages: ['big:1'] } : {});
    const { mgr, dataDir } = sidecars(t, name === 'spawn-inherit-tools-symlink' ? { toolsMode: 'symlink' } : {});
    await run(mgr, d);
    recorded[`sidecar:${name}`] = normalise(d.calls, dataDir);
  });
}

// Registry auth (live 0.0.52): a credentialed pull runs with the throwaway auth dir; a refused pull is image_auth.
test('golden sidecar argv: prepull-credential and image-auth refusal', async (t) => {
  const d = fakeDocker(t, { missingImages: ['private.example/team/app/runtime:1', 'private.example/other/x:1'] });
  const { mgr, dataDir } = sidecars(t, { pullCredential: async (_app, image) => (image.includes('team/app') ? CRED : null) });
  await mgr.prePull({ id: APP, services: [{ name: 'p', image: 'private.example/team/app/runtime:1', prePull: true }] });
  const err = await mgr.spawn(INST, { template: 'priv' }, app).then(() => null, (e) => e);
  recorded['sidecar:prepull-credential'] = normalise({ calls: d.calls, err: err && { name: err.name, code: err.code, status: err.status, message: err.message } }, dataDir);
});

for (const [name, opt] of Object.entries({ 'fail-start': { failStart: true }, 'die-on-boot': { dieOnBoot: true } })) {
  test(`golden sidecar argv: ${name}`, async (t) => {
    const d = fakeDocker(t, opt);
    const { mgr, dataDir } = sidecars(t);
    await assert.rejects(mgr.spawn(INST, { template: 'box' }, app));
    recorded[`sidecar:${name}`] = normalise(d.calls, dataDir);
  });
}

// ─── Mounts ─────────────────────────────────────────────────────────────────

const CONSUMER = 'io.test.app-2';
const SC = `${CONSUMER}--box`;

function mounts(t, { noCat = new Set(), noMountRoot = new Set(), idmap = false } = {}) {
  const dataDir = fs.mkdtempSync(join(tmpdir(), 'aura-gm-'));
  const kernel = new Map();
  const calls = [];
  const realRead = fs.readFileSync;
  const realStat = fs.statSync;
  const mountRootDir = (k) => join(dataDir, 'aura', 'mounts', k);
  const hidden = new Set();
  const inner = (consumer, dest) => (dest.startsWith(`${mountRootDir(consumer)}/`) ? `/mnt/aura/${dest.slice(mountRootDir(consumer).length + 1)}`
    : dest.includes(`/${consumer}/.mnt/`) ? `/data/.mnt/${dest.slice(dest.indexOf('/.mnt/') + 6)}` : null);
  const viewOf = (consumer) => [...kernel].filter(([dest]) => inner(consumer, dest) && !hidden.has(dest))
    .map(([dest, m]) => `9 1 0:1 / ${inner(consumer, dest)} ${m.mode},relatime${m.idmapped ? ',idmapped' : ''} - ext4 x ${m.mode}`)
    .join('\n') + '\n';
  const shellPath = (p) => p.replace(`${dataDir}/daemon`, dataDir);
  const consumerOf = (container) => container.replace(/^aura-/, '');
  t.mock.method(fs, 'readFileSync', (p, ...rest) => (p === '/proc/self/mountinfo'
    ? [...kernel].map(([dest, m]) => `5 1 0:1 / ${dest} ${m.mode},relatime master:1 - ext4 x ${m.mode}`).join('\n') + '\n'
    : realRead(p, ...rest)));
  if (idmap) {
    t.mock.method(fs, 'statSync', (p, ...rest) => (String(p).startsWith(join(dataDir, 'scopes')) ? { uid: 200003, gid: 200003 } : realStat(p, ...rest)));
  }
  t.mock.method(childProcess, 'execSync', (cmd) => {
    calls.push(['execSync', cmd]);
    const container = cmd.trim().split(' ').at(-1);
    return noMountRoot.has(consumerOf(container)) ? '/data\n' : '/mnt/aura\n/data\n';
  });
  t.mock.method(childProcess, 'execFileSync', (cmd, args, opts) => {
    calls.push(['execFileSync', cmd, [...args], { timeout: opts?.timeout, encoding: opts?.encoding ?? null }]);
    if (args[0] === 'exec') {
      const consumer = consumerOf(args[1]);
      if (noCat.has(consumer)) throw new Error('exec: "cat": executable file not found');
      return viewOf(consumer);
    }
    const pid = args.find((a) => a.startsWith('--pid=container:'));
    if (pid) return viewOf(consumerOf(pid.slice('--pid=container:'.length)));
    const script = args[args.indexOf('-euc') + 1];
    const rest = args.slice(args.indexOf('_') + 1);
    const dest = shellPath(rest[0]);
    if (script.includes('idmap-bind')) kernel.set(dest, { mode: 'rw', idmapped: true });
    else if (script.includes('mount --bind')) kernel.set(dest, { mode: args.some((a) => a.endsWith(':/src:ro')) ? 'ro' : 'rw' });
    else kernel.delete(dest);
    return '';
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const mm = new MountManager({
    dataDir,
    registry: { getById: (id) => (id.startsWith('gone.') ? undefined : { id, appDir: `/workspace/apps/${id}`, scopeId: 'global' }) },
    scopeRegistry: { getById: () => ({ dataDir: join(dataDir, 'scopes', 'global') }) },
    mounts: containerMounts({
      canPropagateMounts: () => ({ ok: true }),
      canIdmapMounts: () => ({ ok: true }),
      idmapHelperHostPath: () => '/helper/aura-session-enter',
      mountRootDir,
      toDaemonHostPath: (p) => p.replace(dataDir, `${dataDir}/daemon`),
    }, { helperImage: 'aura-base' }),
    instanceDataDir: (k) => join(dataDir, 'scopes', 'global', 'apps', APP, k.split('--')[0]),
    fanoutTargets: (inst) => (inst === CONSUMER ? [{ consumer: SC, exclude: [], forceRo: true }] : []),
    sourceMode: () => 'open',
    ...(idmap ? { consumerIdentity: (k) => (k.includes('--') ? null : { uid: 200007, gid: 200007 }), runtimeOf: () => 'container' } : {}),
  });
  return { mm, calls, dataDir, kernel, hidden, mountRootDir };
}

const MOUNT_SCENARIOS = {
  'add-ro-rw-remove-fanout': async ({ mm }) => {
    await mm.add(CONSUMER, { targetAppId: 'io.t.src' });
    await mm.add(CONSUMER, { targetAppId: 'io.t.data', mode: 'rw', data: true });
    await mm.settled();
    await mm.remove(CONSUMER, 'io.t.src');
    await mm.settled();
    mm.removeAll(CONSUMER);
  },
  'add-idmap': async ({ mm }) => { await mm.add(CONSUMER, { targetAppId: 'io.t.data', mode: 'rw', data: true }); },
  'sidecar-no-cat-pid-fallback': async ({ mm }) => { await mm.add(SC, { targetAppId: 'io.t.src' }); },
  'legacy-root': async ({ mm }) => { await mm.add(CONSUMER, { targetAppId: 'io.t.src' }); },
  'reconcile-reap-adopt': async ({ mm, kernel, hidden, mountRootDir }) => {
    kernel.set(join(mountRootDir('gone.app-1'), 'io.t.src'), { mode: 'ro' });
    kernel.set(join(mountRootDir(CONSUMER), 'io.t.src'), { mode: 'ro' });
    // A bind of a previous life of the id: on the host, not visible inside the consumer.
    kernel.set(join(mountRootDir(CONSUMER), 'io.t.stale'), { mode: 'ro' });
    hidden.add(join(mountRootDir(CONSUMER), 'io.t.stale'));
    mm.reconcile(new Set([CONSUMER]));
    mm.removeAll(CONSUMER);
  },
};

for (const [name, run] of Object.entries(MOUNT_SCENARIOS)) {
  test(`golden mount argv: ${name}`, async (t) => {
    const w = mounts(t, {
      ...(name === 'add-idmap' ? { idmap: true } : {}),
      ...(name === 'sidecar-no-cat-pid-fallback' ? { noCat: new Set([SC]) } : {}),
      ...(name === 'legacy-root' ? { noMountRoot: new Set([CONSUMER]) } : {}),
    });
    await run(w);
    recorded[`mount:${name}`] = normalise(w.calls, w.dataDir);
  });
}

test('golden workload and mount argv: byte-identical to test/golden/workload-args.json', () => {
  const sorted = Object.fromEntries(Object.keys(recorded).sort().map((k) => [k, recorded[k]]));
  if (!fs.existsSync(GOLDEN)) {
    fs.mkdirSync(dirname(GOLDEN), { recursive: true });
    fs.writeFileSync(GOLDEN, `${JSON.stringify(sorted, null, 2)}\n`);
    assert.fail(`recorded a new golden file at ${GOLDEN}: review and commit it`);
  }
  const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf-8'));
  assert.deepEqual(Object.keys(sorted), Object.keys(golden), 'the same scenarios');
  for (const k of Object.keys(golden)) assert.deepEqual(sorted[k], golden[k], k);
});

// ─── The SpawnSpec (5b plan §4.1: golden/spawn-spec.json) ───────────────────
//
// `buildSpawnSpec()` is the one place a start's spec is assembled (A4): the
// spec a runtime with `hostFilesystem` gets, and the one without host paths.

const SPAWN_SPEC_GOLDEN = join(dirname(fileURLToPath(import.meta.url)), 'golden', 'spawn-spec.json');

test('golden SpawnSpec: buildSpawnSpec() per fixture and A4 column, byte-identical to test/golden/spawn-spec.json', async () => {
  const { buildSpawnSpec } = await import('../dist/runtimes/spawnSpec.js');
  const fixtures = {
    'app-identity': {
      instanceId: 'io.g.app-1', appId: 'io.g.app', port: 4101, manifest: { id: 'io.g.app', name: 'G', version: '1.0.0', runtime: 'astro' },
      context: {
        appDir: '/data/scopes/global/apps/io.g.app', instanceDataDir: '/data/scopes/global/apps/io.g.app/io.g.app-1',
        instanceToken: { token: 'tok', nonce: 'non' }, sourceMode: 'closed', installationId: 'inst-1', owner: 'default',
        home: { kind: 'app-global', hostPath: '/data/aura/apphomes/i/global', volumeSubpath: 'aura/apphomes/i/global', logicalPath: '/home/aura', uid: 200001, gid: 200001, mode: 0o700 },
        identity: { uid: 200001, gid: 200001, range: 'app' }, env: { A: '1' }, contextEnv: { KEY: 'v' },
      },
    },
    'preview-no-home': {
      instanceId: 'io.g.app-2', appId: 'io.g.app', port: 4102, manifest: { id: 'io.g.app', name: 'G', version: '1.0.0' },
      context: { appDir: '/a', instanceDataDir: '/d', instanceToken: { token: 't2', nonce: 'n2' }, preview: 'aura/workspaces/u/i/1' },
    },
  };
  const out = {};
  for (const [name, input] of Object.entries(fixtures)) {
    for (const hostFilesystem of [true, false]) out[`${name}:${hostFilesystem ? 'host' : 'no-host'}`] = buildSpawnSpec(input, { hostFilesystem });
  }
  if (!fs.existsSync(SPAWN_SPEC_GOLDEN)) {
    fs.writeFileSync(SPAWN_SPEC_GOLDEN, `${JSON.stringify(out, null, 2)}\n`);
    assert.fail(`recorded a new golden file at ${SPAWN_SPEC_GOLDEN}: review and commit it`);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(out)), JSON.parse(fs.readFileSync(SPAWN_SPEC_GOLDEN, 'utf-8')));
});
