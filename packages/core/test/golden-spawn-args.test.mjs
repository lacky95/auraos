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
// Stream R2 (owner-approved difference, Phase 5b P-3): the `direct` column is
// gone (PRoot never runs an app unwrapped) and a `pool` column records the
// pool placement's refusal (not built in this release; no fallback to master).
// The `proot` column is the narrowed master placement: setpriv to the app
// identity, no /workspace beyond the shared pieces, no /run/context, no
// socket, a per-instance /tmp and a clean env. PRoot runs only app
// identities, so a fixture without one runs there as PROOT_APP_IDENTITY.
// Stream T (owner-approved D89 B4 strict, D69): every container start carries
// its relay mode (`AURA_RELAY_STRICT=strict` by default); a System Terminal
// carries its session user and the tmux socket tmpfs, and with a session
// identity runs as that user's uid. Owner decision (2026-11-26): a session host
// gets AURA_SERVER_SEALED (production build only, execute-only node) and its
// lifecycle token as a one-time file, never `-e AURA_LIFECYCLE_TOKEN`; the
// synthesised start script (every fixture's digest) carries the sealed branch.
// Stream T2 (owner decision 2026-11-27): no execute-only node. A session host
// with a session identity runs as --user 0:0 with only SETUID/SETGID (its
// session launcher `aura-term-launch serve` is the command, the server runs as
// the Terminal service uid, the sessions as the user), carries
// AURA_SESSION_HOST/AURA_SESSION_UID, the session-identity label, the user's
// tmux tmpfs at /run/aura-term/<uid> and the server's /run/aura-term-server;
// the start script's session-host branch replaces the sealed one (digests).
// Stream C (owner-approved difference, Q7): no `/run/context` mount or bind;
// the context env is what the kernel resolved for the start (`ctx.contextEnv`:
// declared AND granted keys), which the runners pass through unchanged.
// Root requests (owner decision 5-main item 3, new fixture `approved-root`):
// an approved root request runs as --user 0:0 with cap-drop ALL and
// no-new-privileges; every other fixture is unchanged.
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
const { prootRuntime } = await import('../dist/runtimes/builtins/proot.js');
const { healthRefusal } = await import('../dist/runtimes/ari.js');

const TMP = mkdtempSync(join(tmpdir(), 'aura-golden-'));
const dataDir = join(TMP, 'data');
const rootfs = join(TMP, 'rootfs');
const toolchain = join(TMP, 'toolchain');
for (const d of [dataDir, rootfs, join(toolchain, 'bin')]) mkdirSync(d, { recursive: true });

const opts = { baseRootfs: rootfs, toolchainDir: toolchain, appsDir: join(TMP, 'apps'), dataDir, osApiBase: 'http://127.0.0.1:3000' };
const stubStores = (runner, volumes) => {
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
    // no-new-privileges and the generated passwd/group (container); setpriv
    // to the same uid and the passwd/group binds (PRoot, R2).
    name: 'app-identity',
    manifest: { id: 'org.golden.appid', sandbox: 'container' },
    appDir: () => userApp('org.golden.appid'),
    ctx: { owner: 'default', identity: { uid: 200001, gid: 200001, range: 'app' }, installationId: '3f1c2e7a-0000-4000-8000-000000000001', home: { ...appHome('3f1c2e7a-0000-4000-8000-000000000001'), uid: 200001, gid: 200001 } },
    contextEnv: {},
    volumes: [],
  },
  {
    // Owner decision 5-main item 3: an APPROVED root request (manifest `execution`).
    // uid 0 and nothing more: --user 0:0, cap-drop ALL, no-new-privileges, no
    // passwd mounts, no socket (even with docker and *), no --privileged/--cap-add.
    // PRoot refuses it (R2).
    name: 'approved-root',
    manifest: { id: 'org.golden.rootreq', tools: ['docker', '*'], sandbox: 'container', execution: { runAs: 'root', reason: 'binds :80' } },
    appDir: () => userApp('org.golden.rootreq'),
    ctx: { owner: 'default', identity: { uid: 0, gid: 0, range: 'root', approvedRoot: true }, installationId: '3f1c2e7a-0000-4000-8000-000000000002', home: appHome('3f1c2e7a-0000-4000-8000-000000000002') },
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

/** Normalise run-specific values; the docker socket is checked separately (never bound, J.7). */
function norm(value) {
  // Long values (the synthesised start scripts) are pinned by their digest.
  return JSON.parse(JSON.stringify(value).split(TMP).join('<TMP>'), (_k, v) =>
    typeof v === 'string' && v.length > 200 ? `<sha256:${createHash('sha256').update(v).digest('hex')}>` : v);
}
function noSocket(argv) {
  const found = argv.some((a, i) => (a === '-v' && argv[i + 1] === `${SOCKET}:${SOCKET}`) || a === `--bind=${SOCKET}:${SOCKET}` || String(a).includes(SOCKET));
  assert.equal(found, false, 'stream J.7: no sandbox gets the Docker socket, whatever tools[] says (`*`, `docker`)');
  return argv;
}

async function containerArgv(fx) {
  const runner = new ContainerRunner(opts);
  const appDir = typeof fx.appDir === 'function' ? fx.appDir() : fx.appDir;
  const m = manifest(fx.manifest);
  const instanceId = `${m.id}-1`;
  const ctx = { appDir, instanceDataDir: join(dataDir, 'scopes', 'users', 'default', 'apps', m.id, instanceId), contextEnv: { ...fx.contextEnv }, ...fx.ctx };
  const argv = runner.buildDockerArgs(instanceId, m.id, 4321, m, `aura-${instanceId}`, ctx, fx.volumes, fx.term ?? null);
  return norm(noSocket(argv));
}

/** The app identity a PRoot fixture without one runs as (PRoot refuses root, R2). */
const PROOT_APP_IDENTITY = { uid: 200099, gid: 200099, range: 'app' };

/** The master placement's launch (command, prefix, env), with AURA_USE_PROOT set. */
async function prootLaunch(fx, { ctx: extra = {}, env: hostEnv = { AURA_USE_PROOT: 'true' } } = {}) {
  const saved = process.env['AURA_USE_PROOT'];
  if (hostEnv.AURA_USE_PROOT === undefined) delete process.env['AURA_USE_PROOT']; else process.env['AURA_USE_PROOT'] = hostEnv.AURA_USE_PROOT;
  try {
    const runner = new ProotRunner(opts);
    stubStores(runner, fx.volumes);
    let captured;
    runner.startProcess = async (_i, _a, _p, launch, entrypointArgv) => {
      captured = { launch, entrypointArgv };
      return 4242;
    };
    const appDir = typeof fx.appDir === 'function' ? fx.appDir() : fx.appDir;
    const m = manifest(fx.manifest);
    const instanceId = `${m.id}-1`;
    await runner.spawn(instanceId, m.id, 4321, m, {
      appDir, instanceDataDir: join(dataDir, 'inst', instanceId), identity: PROOT_APP_IDENTITY, contextEnv: { ...fx.contextEnv }, ...fx.ctx, ...extra,
    });
    const { command, prefix, env, appDir: cwd } = captured.launch;
    assert.ok(!prefix.some((a) => a.includes(SOCKET)), 'PRoot never binds the docker socket');
    assert.match(env['AURA_LIFECYCLE_TOKEN'], /^[A-Za-z0-9_-]{16,}$/);
    return norm({
      command, prefix, appDir: cwd,
      entrypointArgv: captured.entrypointArgv,
      env: Object.fromEntries(Object.entries({ ...env, AURA_LIFECYCLE_TOKEN: '<token>' }).sort(([a], [b]) => a.localeCompare(b))),
    });
  } finally {
    if (saved === undefined) delete process.env['AURA_USE_PROOT']; else process.env['AURA_USE_PROOT'] = saved;
  }
}

/** The pool placement: refused before any start (not built in this release), never the master's argv. */
function prootPool() {
  const runtime = prootRuntime(new ProotRunner(opts), { baseRootfs: rootfs, env: { AURA_USE_PROOT: 'true' } });
  return { refused: healthRefusal(runtime.health({ placement: 'pool' })) };
}

test('spawn args match the golden file (container argv; proot master launch and env; proot pool)', async () => {
  const actual = {};
  for (const fx of FIXTURES) {
    actual[fx.name] = {
      container: await containerArgv(fx),
      // 5-main (R2 + T): PRoot runs app identities only, so a session host's user identity is a recorded refusal.
      proot: await prootLaunch(fx).catch((err) => {
        if (err?.name !== 'ProotIdentityError') throw err;
        return { refused: err.message };
      }),
      pool: prootPool(),
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
  await assert.rejects(prootLaunch(fx), /no home was resolved/);
  const tmpfs = { ...FIXTURES[0], ctx: { home: { kind: 'ephemeral', hostPath: null, volumeSubpath: null, logicalPath: '/home/aura', uid: 1000, gid: 1000, mode: 0o700 } } };
  await assert.rejects(containerArgv(tmpfs), /can't be an app process's home/);
  await assert.rejects(prootLaunch(tmpfs), /can't be an app process's home/);
});

test('R2: PRoot refuses a root (or non-app) identity, never runs it as root', async () => {
  for (const identity of [undefined, { uid: 0, gid: 0, range: 'root' }, { uid: 1000, gid: 1000, range: 'owner' }]) {
    await assert.rejects(prootLaunch(FIXTURES[0], { ctx: { identity } }),
      (e) => e.name === 'ProotIdentityError' && /only under its own app identity/.test(e.message) && /run-as org\.golden\.system app/.test(e.message));
  }
});

test('R2: without AURA_USE_PROOT (proot-host) the runner itself refuses; nothing runs unwrapped', async () => {
  for (const v of [undefined, 'false', 'no']) {
    await assert.rejects(prootLaunch(FIXTURES[0], { env: { AURA_USE_PROOT: v } }), /runtime proot is not available: AURA_USE_PROOT is not true/);
  }
});

test('R2: the master placement is narrowed (no /workspace, /run/context, socket or master env; own /tmp; app uid)', async () => {
  const fx = FIXTURES.find((f) => f.name === 'user-tools-token-owner-preview');
  const saved = process.env['AURA_GOLDEN_LEAK'];
  process.env['AURA_GOLDEN_LEAK'] = 'master-only';
  try {
    const l = await prootLaunch({ ...fx, manifest: { ...fx.manifest, context: ['FOO', 'APP_ID'] } });
    assert.equal(l.command, 'setpriv');
    assert.deepEqual(l.prefix.slice(0, 6), ['--reuid=200099', '--regid=200099', '--clear-groups', '--no-new-privs', '--', 'proot']);
    assert.ok(!l.prefix.includes('--bind=/workspace:/workspace'), 'never all of /workspace');
    assert.ok(!l.prefix.some((a) => /^--bind=\/workspace\/apps(\/|:|$)/.test(a)), 'no other app dir (only its own appDir)');
    assert.ok(!l.prefix.some((a) => a.endsWith(':/run/context')), 'no /run/context');
    assert.ok(l.prefix.includes('--bind=<TMP>/data/aura/runtime/org.golden.user-1/tmp:/tmp'), 'its own /tmp');
    assert.ok(!l.prefix.includes('--bind=/tmp'), 'never the master /tmp');
    assert.equal(l.env['AURA_GOLDEN_LEAK'], undefined, 'nothing of the master env');
    assert.equal(l.env['FOO'], 'bar', 'a declared context key');
    assert.equal(l.env['APP_ID'], 'org.golden.user', 'a context key never clobbers an OS var');
    // Stream C: the kernel decides the keys (declared AND granted, ctx.contextEnv); the runner hands over exactly those.
    const ungranted = await prootLaunch({ ...fx, contextEnv: {} });
    assert.equal(ungranted.env['FOO'], undefined, 'a key the kernel did not grant is not handed over');
  } finally {
    if (saved === undefined) delete process.env['AURA_GOLDEN_LEAK']; else process.env['AURA_GOLDEN_LEAK'] = saved;
  }
  const { statSync } = await import('node:fs');
  const st = statSync(join(dataDir, 'aura', 'runtime', 'org.golden.user-1', 'tmp'));
  assert.equal(st.mode & 0o777, 0o700);
  if (process.getuid?.() === 0) assert.deepEqual([st.uid, st.gid], [200099, 200099], 'the tmp dir belongs to the app identity');
});

test('audit N4: every AURA_* variable the spawn args set is on exactly one kernel list (server-only or session-visible)', async () => {
  const { SERVER_ONLY_ENV, SESSION_VISIBLE_ENV } = await import('../dist/runtimes/workloadEnv.js');
  const golden = readFileSync(GOLDEN, 'utf-8');
  const set = new Set(golden.match(/AURA_[A-Z0-9_]+(?==)|(?<=")AURA_[A-Z0-9_]+(?=":)/g) ?? []);
  assert.ok(set.size >= 10, `the golden file sets the AURA_* variables (${[...set].join(', ')})`);
  for (const name of set) {
    const n = Number(SERVER_ONLY_ENV.includes(name)) + Number(SESSION_VISIBLE_ENV.includes(name));
    assert.equal(n, 1, `${name}: add it to SERVER_ONLY_ENV (a session must not see it) or SESSION_VISIBLE_ENV (runtimes/workloadEnv.ts)`);
  }
  for (const name of SERVER_ONLY_ENV) assert.ok(!SESSION_VISIBLE_ENV.includes(name), name);
});
