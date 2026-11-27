// AF1 (L5): a scaffold payload never becomes code the shell runs. core scopes/scaffoldPayload.ts refuses the
// files that steer an install or git, clamps modes, and the install runs without scripts or pnpmfile as an
// unprivileged uid (app-manager/unprivilegedInstall.ts). Run via:
//   node tools/run-tests.mjs --only=core

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { refusedScaffoldFiles, scaffoldFileMode, SCAFFOLD_INSTALL_ARGS } from '../dist/scopes/scaffoldPayload.js';
import { AURA_NPMRC } from '../dist/scopes/portability.js';
import {
  installAppDepsUnprivileged, INSTALL_GID, INSTALL_UID, unprivilegedInstallEnv, unprivilegedPnpm,
} from '../dist/app-manager/unprivilegedInstall.js';

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

/** What `aura dev new` renders for a user-scope app (the template package.json after portPackageJsonForScope). */
const template = () => [
  { relPath: 'app.manifest.json', content: '{"id":"com.example.hello"}\n' },
  { relPath: 'package.json', content: JSON.stringify({
    name: 'com.example.hello', version: '0.1.0', private: true, type: 'module',
    scripts: { dev: 'astro dev', build: 'astro build', start: 'node dist/server/entry.mjs' },
    dependencies: { '@astrojs/node': '^11.1.14', astro: '^7.4.13' },
    auraDependencies: { '@aura/app-sdk': '^0.0.53' },
  }, null, 2) },
  { relPath: '.npmrc', content: AURA_NPMRC },
  { relPath: '.gitignore', content: 'node_modules\n' },
  { relPath: 'src/pages/index.astro', content: '<h1>hi</h1>\n' },
  { relPath: 'entrypoint.sh', content: '#!/bin/sh\n', mode: 0o755 },
];
const files = (refused) => refused.map((r) => r.file);

test('the template payload is accepted unchanged', () => {
  assert.deepEqual(refusedScaffoldFiles(template()), []);
});

test('files that steer the install or git are refused, each named with a reason', () => {
  const extra = [
    { relPath: '.git/config', content: '[core]\n\tfsmonitor = "id"\n' },
    { relPath: '.git/hooks/post-commit', content: '#!/bin/sh\nid\n' },
    { relPath: 'sub/.git', content: 'gitdir: /root\n' },
    { relPath: 'node_modules/.bin/astro', content: '#!/bin/sh\n' },
    { relPath: '.pnpmfile.cjs', content: 'require("child_process").execSync("id")' },
    { relPath: 'lib/.pnpmfile.mjs', content: '' },
    { relPath: 'pnpm-workspace.yaml', content: 'onlyBuiltDependencies: [x]\n' },
    { relPath: './.npmrc', content: 'ignore-scripts=false\n' },
    { relPath: 'sub/.npmrc', content: AURA_NPMRC },
  ];
  const refused = refusedScaffoldFiles([...template().filter((f) => f.relPath !== '.npmrc'), ...extra]);
  assert.deepEqual(files(refused), extra.map((f) => f.relPath));
  for (const r of refused) assert.ok(r.reason.length > 10, r.file);
});

test('package.json: package-manager switches and non-registry dependencies are refused', () => {
  const pkg = {
    name: 'x', packageManager: 'pnpm@https://evil.example/pnpm.tgz', devEngines: { runtime: { name: 'node' } }, pnpm: { overrides: {} },
    dependencies: {
      ok: '^1.2.3', alias: 'npm:@scope/pkg@1', tag: 'latest',
      local: 'file:/root/.ssh', linked: 'link:../../x', git: 'git+ssh://git@example.com/x.git', gh: 'github:user/repo',
      short: 'user/repo', url: 'https://example.com/x.tgz',
    },
    auraDependencies: { '@aura/app-sdk': '^0.0.53', '@aura/../../etc': '1.0.0', '@aura/ui': 'latest' },
    optionalDependencies: [],
  };
  const refused = files(refusedScaffoldFiles([{ relPath: 'package.json', content: JSON.stringify(pkg) }]));
  assert.deepEqual(refused, [
    'package.json: packageManager', 'package.json: devEngines', 'package.json: pnpm',
    'package.json: dependencies.local', 'package.json: dependencies.linked', 'package.json: dependencies.git',
    'package.json: dependencies.gh', 'package.json: dependencies.short', 'package.json: dependencies.url',
    'package.json: optionalDependencies',
    'package.json: auraDependencies.@aura/../../etc', 'package.json: auraDependencies.@aura/ui',
  ]);
  assert.deepEqual(files(refusedScaffoldFiles([{ relPath: 'package.json', content: 'nope' }])), ['package.json']);
  // A system-scope scaffold keeps the SDK as a workspace dependency.
  assert.deepEqual(refusedScaffoldFiles([{ relPath: 'package.json', content: '{"dependencies":{"@aura/app-sdk":"workspace:*"}}' }]), []);
});

test('file modes are 0644 or 0755, never setuid, setgid, sticky or world-writable', () => {
  assert.equal(scaffoldFileMode(undefined), 0o644);
  assert.equal(scaffoldFileMode(0o666), 0o644);
  assert.equal(scaffoldFileMode(0o4777), 0o755);
  assert.equal(scaffoldFileMode(0o2750), 0o755);
  assert.equal(scaffoldFileMode(0o100), 0o755);
});

test('the install never runs lifecycle scripts or a pnpmfile', () => {
  assert.ok(SCAFFOLD_INSTALL_ARGS.includes('--ignore-scripts'));
  assert.ok(SCAFFOLD_INSTALL_ARGS.includes('--ignore-pnpmfile'));
  const env = unprivilegedInstallEnv({ PATH: '/bin', AURA_INTERNAL_SECRET: 's', AURA_INSTANCE_TOKEN: 't', OS_API_BASE: 'http://x', LAKNERIO_KEY: 'k', HOME: '/root' }, '/tmp/h');
  assert.deepEqual(Object.keys(env).filter((k) => /SECRET|TOKEN|OS_API|LAKNERIO/.test(k)), []);
  assert.equal(env.HOME, '/tmp/h');
  assert.equal(env.PATH, '/bin');
  assert.equal(env.npm_config_ignore_scripts, 'true');
  assert.equal(env.npm_config_ignore_pnpmfile, 'true');
});

test('without pnpm for an unprivileged install it fails closed (no root fallback, nothing spawned)', () => {
  const calls = [];
  const r = installAppDepsUnprivileged('/nonexistent', { pnpmEntry: null, spawn: (...a) => { calls.push(a); return { status: 0 }; } });
  assert.equal(r.ok, false);
  assert.match(r.error, /own sandbox/);
  assert.equal(calls.length, 0);
});

test('the install runs as the unprivileged uid with the safe flags, and the app is root-owned afterwards', { skip: !isRoot && 'needs root (chown)' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'aura-af1-'));
  const dest = join(root, 'app'); mkdirSync(dest);
  writeFileSync(join(dest, 'package.json'), '{}');
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, uid: opts.uid, gid: opts.gid, owner: statSync(dest).uid, env: opts.env });
    mkdirSync(join(dest, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(dest, 'node_modules', '.bin', 'astro'), '');
    mkdirSync(join(dest, 'node_modules', '@aura'), { recursive: true });
    return { status: 0, stdout: '', stderr: '' };
  };
  try {
    const r = installAppDepsUnprivileged(dest, { pnpmEntry: '/opt/pnpm/bin/pnpm.mjs', spawn, paths: { storeDir: join(root, 'store'), toolsDir: join(root, 'tools') } });
    assert.deepEqual(r, { ok: true });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].args, ['/opt/pnpm/bin/pnpm.mjs', ...SCAFFOLD_INSTALL_ARGS, `--store-dir=${join(root, 'store', 'store')}`, `--cache-dir=${join(root, 'store', 'cache')}`]);
    assert.deepEqual(calls[1].args, ['sdk', 'install']);
    for (const c of calls) {
      assert.equal(c.uid, INSTALL_UID); assert.equal(c.gid, INSTALL_GID);
      assert.equal(c.owner, INSTALL_UID, 'the app dir is the install user\'s while it runs');
      assert.equal(c.env.npm_config_ignore_scripts, 'true');
    }
    assert.equal(statSync(dest).uid, 0);
    assert.equal(statSync(join(dest, 'node_modules', '.bin', 'astro')).uid, 0);
    assert.equal(statSync(join(root, 'store', 'store')).uid, INSTALL_UID);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('real pnpm: a payload\'s lifecycle scripts do not run, and a root-only file: dependency is unreadable', { skip: !isRoot && 'needs root (setuid)' }, (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aura-af1-real-'));
  chmodSync(root, 0o755); // the install user must reach the tools copy and the app (production: /data/aura, 0755)
  const paths = { storeDir: join(root, 'store'), toolsDir: join(root, 'tools') };
  const pnpm = unprivilegedPnpm(paths.toolsDir);
  if (!pnpm) { rmSync(root, { recursive: true, force: true }); return t.skip('no corepack pnpm in this environment'); }
  const dest = join(root, 'app'); mkdirSync(dest, { mode: 0o755 });
  const mark = join(root, 'marker');
  writeFileSync(join(dest, 'package.json'), JSON.stringify({
    name: 'af1', version: '0.0.0', private: true,
    scripts: Object.fromEntries(['preinstall', 'install', 'postinstall', 'prepare'].map((p) => [p, `id > ${mark}-${p}`])),
  }));
  try {
    const r = installAppDepsUnprivileged(dest, { paths, pnpmEntry: pnpm });
    assert.equal(r.ok, false, 'no astro: the step reports it, the app installs in its sandbox later');
    assert.match(r.error ?? '', /^pnpm install: /, 'pnpm itself ran');
    assert.ok(existsSync(join(dest, 'node_modules')), 'pnpm ran in the app (as the install user)');
    for (const p of ['preinstall', 'install', 'postinstall', 'prepare']) assert.equal(existsSync(`${mark}-${p}`), false, `${p} ran`);
    assert.equal(statSync(dest).uid, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
