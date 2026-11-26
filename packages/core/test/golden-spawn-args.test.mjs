// Golden spawn arguments (Phase 5 Stage 1, ARI §6): the `docker run` argv of
// ContainerRunner and the `proot` argv plus env of ProotRunner, per fixture
// app, must stay byte-identical across refactors. Every Phase 5 stream extends
// this test; a deliberate change (an owner-approved difference, e.g. the home
// source in stream H) updates test/golden/spawn-args.json in the same commit.
//
// Missing golden file: the test writes it from the current code and fails, so
// a first run records the baseline and the next run compares against it.
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

/** The fixture apps. Each runs through both runners. */
const FIXTURES = [
  {
    name: 'system-default',
    manifest: { id: 'org.golden.system' },
    appDir: '/workspace/apps/org.golden.system',
    ctx: {},
    contextEnv: {},
    volumes: [],
  },
  {
    name: 'user-tools-token-owner-preview',
    manifest: { id: 'org.golden.user', tools: ['git', 'ripgrep'] },
    appDir: () => userApp('org.golden.user', { 'entrypoint.sh': '#!/bin/sh\n' }),
    ctx: { instanceToken: { token: 'tok-1', nonce: 'nonce-1' }, owner: 'default', preview: 'ws/preview-1', sourceMode: 'open' },
    contextEnv: { FOO: 'bar', APP_ID: 'clobber-attempt' },
    volumes: [{ name: 'shared', mountPath: '/mnt/shared', mode: 'rw' }, { name: 'ro', mountPath: '/mnt/ro', mode: 'ro' }],
  },
  {
    name: 'wildcard-closed-raw',
    manifest: { id: 'org.golden.raw', tools: ['*'], runtime: 'raw', entrypoint: 'start.sh', sandbox: 'container' },
    appDir: () => userApp('org.golden.raw', { 'start.sh': '#!/bin/sh\n' }),
    ctx: { sourceMode: 'closed', owner: 'u-2' },
    contextEnv: { SECRET_KEY: 'v' },
    volumes: [],
  },
  {
    // Stream N (D58): the System Terminal on its user's private network.
    // A context key can't replace its listen env (pushed after the context env).
    name: 'system-terminal-private-network',
    manifest: { id: 'com.aura.terminal', tools: ['*'], sandbox: 'container' },
    appDir: '/workspace/apps/com.aura.terminal',
    ctx: { owner: 'default' },
    contextEnv: { AURA_LISTEN_SUBNET: '0.0.0.0/0' },
    volumes: [],
    term: { name: 'aura-term-default', subnet: '172.30.0.0/16' },
  },
  {
    name: 'docker-tool',
    manifest: { id: 'org.golden.docker', tools: ['docker'] },
    appDir: () => userApp('org.golden.docker'),
    ctx: {},
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
    await runner.spawn(instanceId, m.id, 4321, m, { appDir, instanceDataDir: join(dataDir, 'inst', instanceId), ...fx.ctx });
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
