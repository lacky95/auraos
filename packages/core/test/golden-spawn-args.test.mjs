// Golden spawn arguments (Phase 5 Stage 1, ARI §6): the `docker run` argv of
// ContainerRunner and the `proot` argv plus env of ProotRunner, per fixture
// app, must stay byte-identical across refactors. Every Phase 5 stream extends
// this test; a deliberate change (an owner-approved difference, e.g. the home
// source in stream H) updates test/golden/spawn-args.json in the same commit.
//
// Missing golden file: the test writes it from the current code and fails, so
// a first run records the baseline and the next run compares against it.
//
// Stream H (owner-approved difference, D65): the home source. Every fixture
// mounts the App Home the Home Resolver decided (`aura/apphomes/<inst>/…`),
// the System Terminal its owner's Private Home; an unwrapped PRoot spawn
// (`direct`) is refused, since it has no home of its own.
//
// Stream T (owner-approved D89 B4 strict, D69): every container start carries
// its relay mode (`AURA_RELAY_STRICT=strict` by default); a System Terminal
// carries its session user and the tmux socket tmpfs, and with a session
// identity runs as that user's uid.
//
// Run via: node tools/run-tests.mjs --only=core

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), 'golden', 'spawn-args.json');
const SOCKET = '/var/run/docker.sock';

// Module-level constants (network name) are read at import: set the env first.
process.env['AURA_DOCKER_NETWORK'] = 'golden-net';
process.env['AURA_APP_DATA_VOLUME'] = 'golden_app-data';
process.env['AURA_NODE_MODULES_VOLUME'] = 'golden_node-modules';
process.env['AURA_SHELL_HOSTNAME'] = 'golden-shell';
delete process.env['AURA_HOST_WORKSPACE'];

const { AppManifestSchema } = await import('../dist/types/manifest.js');
const { ContainerRunner } = await import('../dist/app-manager/ContainerRunner.js');
const { ProotRunner } = await import('../dist/app-manager/ProotRunner.js');

const TMP = mkdtempSync(join(tmpdir(), 'aura-golden-'));
const dataDir = join(TMP, 'data');
const rootfs = join(TMP, 'rootfs');
const toolchain = join(TMP, 'toolchain');
for (const d of [dataDir, rootfs, join(toolchain, 'bin')]) mkdirSync(d, { recursive: true });

const opts = { baseRootfs: rootfs, toolchainDir: toolchain, appsDir: join(TMP, 'apps'), dataDir, osApiBase: 'http://127.0.0.1:3000' };
const stubStores = (runner, contextEnv, volumes) => {
  runner.contextStore = { ensureDir() {}, resolveEnv: async () => ({ ...contextEnv }), systemDir: join(dataDir, 'context', 'system') };
  runner.volumeStore = { ensureAll: async () => {}, resolveMounts: async () => volumes.map((v) => ({ ...v })), volumesDir: join(dataDir, 'context', 'volumes') };
};

const manifest = (extra) => AppManifestSchema.parse({
  id: extra.id, name: 'Golden', version: '1.0.0', ...extra,
});

function userApp(id, files = {}) {
  const dir = join(dataDir, 'scopes', 'users', 'default', 'apps', id);
  mkdirSync(dir, { recursive: true });
  for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, f), body);
  return dir;
}

/** A resolved App Home (homes/HomeResolver.ts) as the spawn seam hands it over. */
const appHome = (inst, scope = 'global', user = 'default') => {
  const sub = scope === 'global' ? `aura/apphomes/${inst}/global` : `aura/apphomes/${inst}/users/${user}`;
  return { kind: scope === 'global' ? 'app-global' : 'app-user', hostPath: join(dataDir, sub), volumeSubpath: sub, logicalPath: '/home/aura', uid: 0, gid: 0, mode: 0o700 };
};
const privateHome = (user) => ({
  kind: 'private', hostPath: join(dataDir, 'aura', 'home', user), volumeSubpath: `aura/home/${user}`, logicalPath: '/home/aura', uid: 1000, gid: 1000, mode: 0o700,
});

/** The fixture apps. Each runs through both runners. */
const FIXTURES = [
  {
    name: 'system-default',
    manifest: { id: 'org.golden.system' },
    appDir: '/workspace/apps/org.golden.system',
    ctx: { home: appHome('inst-system') },
    contextEnv: {},
    volumes: [],
  },
  {
    name: 'user-tools-token-owner-preview',
    manifest: { id: 'org.golden.user', tools: ['git', 'ripgrep'] },
    appDir: () => userApp('org.golden.user', { 'entrypoint.sh': '#!/bin/sh\n' }),
    ctx: { instanceToken: { token: 'tok-1', nonce: 'nonce-1' }, owner: 'default', preview: 'ws/preview-1', sourceMode: 'open', home: appHome('inst-user', 'user') },
    contextEnv: { FOO: 'bar', APP_ID: 'clobber-attempt' },
    volumes: [{ name: 'shared', mountPath: '/mnt/shared', mode: 'rw' }, { name: 'ro', mountPath: '/mnt/ro', mode: 'ro' }],
  },
  {
    name: 'wildcard-closed-raw',
    manifest: { id: 'org.golden.raw', tools: ['*'], runtime: 'raw', entrypoint: 'start.sh', sandbox: 'container' },
    appDir: () => userApp('org.golden.raw', { 'start.sh': '#!/bin/sh\n' }),
    ctx: { sourceMode: 'closed', owner: 'u-2', home: appHome('inst-raw') },
    contextEnv: { SECRET_KEY: 'v' },
    volumes: [],
  },
  {
    // Stream N (D58): the System Terminal on its user's private network.
    // A context key can't replace its listen env (pushed after the context env).
    name: 'system-terminal-private-network',
    manifest: { id: 'com.aura.terminal', tools: ['*'], sandbox: 'container' },
    appDir: '/workspace/apps/com.aura.terminal',
    ctx: { owner: 'default', home: privateHome('default') },
    contextEnv: { AURA_LISTEN_SUBNET: '0.0.0.0/0' },
    volumes: [],
    term: { name: 'aura-term-default', subnet: '172.30.0.0/16' },
  },
  {
    // Stream T (D69): the System Terminal as its user's session host: the
    // user's uid (passwd names the username), no capabilities, the user's
    // Private Home, AURA_SESSION_USER and the tmux socket tmpfs.
    name: 'system-terminal-session-user',
    manifest: { id: 'com.aura.terminal', tools: ['*'], sandbox: 'container' },
    appDir: '/workspace/apps/com.aura.terminal',
    ctx: { owner: 'default', identity: { uid: 1000, gid: 1000, range: 'owner', userId: 'default', account: 'lukas' }, home: privateHome('default') },
    contextEnv: {},
    volumes: [],
    term: { name: 'aura-term-default', subnet: '172.30.0.0/16' },
  },
  {
    // Stream A (P5-3): an installation with runAs: app. --user, cap-drop ALL,
    // no-new-privileges and the generated passwd/group (container); PRoot
    // ignores the identity (AppManager refuses an app identity there).
    name: 'app-identity',
    manifest: { id: 'org.golden.appid', sandbox: 'container' },
    appDir: () => userApp('org.golden.appid'),
    ctx: { owner: 'default', identity: { uid: 200001, gid: 200001, range: 'app' }, installationId: '3f1c2e7a-0000-4000-8000-000000000001', home: { ...appHome('3f1c2e7a-0000-4000-8000-000000000001'), uid: 200001, gid: 200001 } },
    contextEnv: {},
    volumes: [],
  },
  {
    name: 'docker-tool',
    manifest: { id: 'org.golden.docker', tools: ['docker'] },
    appDir: () => userApp('org.golden.docker'),
    ctx: { home: appHome('inst-docker') },
    contextEnv: {},
    volumes: [],
  },
];

/** Normalise run-specific values; the docker-socket pair is checked separately. */
function norm(value) {
  // Long values (the synthesised start scripts) are pinned by their digest.
  return JSON.parse(JSON.stringify(value).split(TMP).join('<TMP>'), (_k, v) =>
    typeof v === 'string' && v.length > 200 ? `<sha256:${createHash('sha256').update(v).digest('hex')}>` : v);
}
function stripSocket(argv, flagged) {
  const out = [];
  let found = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '-v' && argv[i + 1] === `${SOCKET}:${SOCKET}`) { found = true; i++; continue; }
    if (argv[i] === `--bind=${SOCKET}:${SOCKET}`) { found = true; continue; }
    out.push(argv[i]);
  }
  assert.equal(found, flagged && existsSync(SOCKET), 'docker socket is bound exactly when granted and present');
  return out;
}

async function containerArgv(fx) {
  const runner = new ContainerRunner(opts);
  const appDir = typeof fx.appDir === 'function' ? fx.appDir() : fx.appDir;
  const m = manifest(fx.manifest);
  const instanceId = `${m.id}-1`;
  const ctx = { appDir, instanceDataDir: join(dataDir, 'scopes', 'users', 'default', 'apps', m.id, instanceId), ...fx.ctx };
  const argv = runner.buildDockerArgs(instanceId, m.id, 4321, m, `aura-${instanceId}`, ctx, fx.contextEnv, fx.volumes, fx.term ?? null);
  const granted = (m.tools ?? []).some((t) => t === '*' || t === 'docker');
  return norm(stripSocket(argv, granted));
}

async function prootLaunch(fx, useProot) {
  const saved = process.env['AURA_USE_PROOT'];
  if (useProot) process.env['AURA_USE_PROOT'] = 'true'; else delete process.env['AURA_USE_PROOT'];
  try {
    const runner = new ProotRunner(opts);
    stubStores(runner, fx.contextEnv, fx.volumes);
    let captured;
    runner.startProcess = async (_i, _a, _p, _m, args, appDir, env, prooted, entrypointArgv) => {
      captured = { args, appDir, env, prooted, entrypointArgv };
      return 4242;
    };
    const appDir = typeof fx.appDir === 'function' ? fx.appDir() : fx.appDir;
    const m = manifest(fx.manifest);
    const instanceId = `${m.id}-1`;
    try {
      await runner.spawn(instanceId, m.id, 4321, m, { appDir, instanceDataDir: join(dataDir, 'inst', instanceId), ...fx.ctx });
    } catch (err) {
      if (useProot) throw err;
      return { refused: err.message };
    }
    const granted = (m.tools ?? []).some((t) => t === '*' || t === 'docker');
    // The env carries the shell's whole environment (ProotRunner.ts, R2
    // narrows it): keep only what the runner sets or overrides.
    const env = {};
    for (const [k, v] of Object.entries(captured.env)) {
      if (k === 'AURA_USE_PROOT') continue;
      if (k === 'PATH') { env[k] = v.split(process.env['PATH'] ?? '').join('<PATH>'); continue; }
      if (k === 'AURA_LIFECYCLE_TOKEN') { assert.match(v, /^[A-Za-z0-9_-]{16,}$/); env[k] = '<token>'; continue; }
      if (process.env[k] !== v) env[k] = v;
    }
    return norm({
      prooted: captured.prooted,
      args: useProot ? stripSocket(captured.args, granted) : captured.args,
      appDir: captured.appDir,
      entrypointArgv: captured.entrypointArgv,
      env: Object.fromEntries(Object.entries(env).sort(([a], [b]) => a.localeCompare(b))),
    });
  } finally {
    if (saved === undefined) delete process.env['AURA_USE_PROOT']; else process.env['AURA_USE_PROOT'] = saved;
  }
}

test('spawn args match the golden file (container argv; proot argv and env)', async () => {
  const actual = {};
  for (const fx of FIXTURES) {
    actual[fx.name] = {
      container: await containerArgv(fx),
      proot: await prootLaunch(fx, true),
      direct: await prootLaunch(fx, false),
    };
  }
  if (!existsSync(GOLDEN)) {
    mkdirSync(dirname(GOLDEN), { recursive: true });
    writeFileSync(GOLDEN, JSON.stringify(actual, null, 2) + '\n');
    assert.fail(`golden file was missing; recorded ${GOLDEN} from the current code (run again to compare)`);
  }
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf-8'));
  for (const name of Object.keys(golden)) {
    assert.deepEqual(actual[name], golden[name], `fixture ${name}`);
  }
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(golden).sort(), 'fixture set');
});

test('no resolved home: both runners refuse the spawn (no shared-home fallback)', async () => {
  const fx = { ...FIXTURES[0], ctx: {} };
  await assert.rejects(containerArgv(fx), /no home was resolved/);
  await assert.rejects(prootLaunch(fx, true), /no home was resolved/);
  const tmpfs = { ...FIXTURES[0], ctx: { home: { kind: 'ephemeral', hostPath: null, volumeSubpath: null, logicalPath: '/home/aura', uid: 1000, gid: 1000, mode: 0o700 } } };
  await assert.rejects(containerArgv(tmpfs), /can't be an app process's home/);
});
