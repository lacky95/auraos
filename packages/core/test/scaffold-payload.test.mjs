// AF1 (L5): a scaffold payload never becomes code the shell runs. core scopes/scaffoldPayload.ts refuses the
// files that steer an install or git, clamps modes, and the install runs without scripts or pnpmfile as an
// unprivileged uid (app-manager/unprivilegedInstall.ts). Run via:
//   node tools/run-tests.mjs --only=core

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, chownSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { refusedScaffoldFiles, refusedStoreInstallFiles, scaffoldFileMode, SCAFFOLD_INSTALL_ARGS } from '../dist/scopes/scaffoldPayload.js';
import { PENDING_BUILDS_FILE, provisionApp } from '../dist/app-manager/provisioning.js';
import { AURA_NPMRC } from '../dist/scopes/portability.js';
import {
  installAppDepsUnprivileged, installStoreDepsUnprivileged, INSTALL_GID, INSTALL_UID, STORE_INSTALL_ARGS,
  unprivilegedInstallEnv, unprivilegedPnpm,
} from '../dist/app-manager/unprivilegedInstall.js';

/** Root with the capabilities an install's uid drop needs (a check container's root has none). */
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0 && (() => {
  const probe = mkdtempSync(join(tmpdir(), 'aura-cap-'));
  try { chownSync(probe, 65534, 65534); return true; } catch { return false; } finally { rmSync(probe, { recursive: true, force: true }); }
})();

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

test('the install runs as the unprivileged uid with the safe flags, and the app is root-owned afterwards', { skip: !isRoot && 'needs root with CAP_CHOWN/SETUID' }, () => {
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

test('real pnpm: a payload\'s lifecycle scripts do not run, and a root-only file: dependency is unreadable', { skip: !isRoot && 'needs root with CAP_CHOWN/SETUID' }, (t) => {
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

// ── Nexus store installs (L5 hotfix: no install script as root in the shell) ──────────────────────────────────

/** A store app tree as live apps ship it: an older AuraOS .npmrc wording, a `pnpm` field, an npmjs lockfile. */
function storeApp(root, { npmrc, pkg = {}, lock } = {}) {
  const dir = join(root, 'app'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.npmrc'), npmrc ?? AURA_NPMRC.replace('`aura install sdk`', '`aura sdk install`'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'io.example.store', version: '0.1.0', private: true,
    dependencies: { astro: '^7.4.13' }, auraDependencies: { '@aura/app-sdk': '^0.0.1' },
    pnpm: { onlyBuiltDependencies: ['esbuild'] }, ...pkg,
  }));
  writeFileSync(join(dir, 'package-lock.json'), JSON.stringify(lock ?? { lockfileVersion: 3, packages: {
    '': { name: 'io.example.store' },
    'node_modules/astro': { version: '7.4.13', resolved: 'https://registry.npmjs.org/astro/-/astro-7.4.13.tgz' },
    'node_modules/@aura/app-sdk': { version: '0.0.1' },
  } }));
  return dir;
}

test('store install inputs: the apps live ships are accepted (AuraOS .npmrc in either wording, pnpm field, npmjs lockfile)', () => {
  const root = mkdtempSync(join(tmpdir(), 'aura-nis-'));
  try { assert.deepEqual(refusedStoreInstallFiles(storeApp(root)), []); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test('store install inputs: a foreign .npmrc is refused by its setting names, never its values', () => {
  const root = mkdtempSync(join(tmpdir(), 'aura-nis-'));
  try {
    const r = refusedStoreInstallFiles(storeApp(root, { npmrc: `${AURA_NPMRC}ignore-scripts=false\n//npm.example/:_authToken=SECRET-VALUE\nregistry=http://127.0.0.1:9/\n` }));
    assert.deepEqual(r.map((x) => x.file), ['.npmrc']);
    assert.match(r[0].reason, /ignore-scripts, \/\/npm\.example\/:_authToken, registry/);
    assert.doesNotMatch(r[0].reason, /SECRET-VALUE|127\.0\.0\.1/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('store install inputs: non-registry dependencies, malformed @aura entries, foreign or linked lockfile entries, symlinks', () => {
  const root = mkdtempSync(join(tmpdir(), 'aura-nis-'));
  try {
    const dir = storeApp(root, {
      pkg: { dependencies: { astro: '^7.4.13', evil: 'git+https://example.invalid/x.git', local: 'file:/root' }, auraDependencies: { '@aura/../../etc': '0.0.1' } },
      lock: { lockfileVersion: 3, packages: {
        'node_modules/a': { version: '1.0.0', resolved: 'http://127.0.0.1:6379/a.tgz' },
        'node_modules/b': { link: true, resolved: '../b' },
        'node_modules/c': { version: '1.0.0', resolved: 'https://registry.npmjs.org/c/-/c-1.0.0.tgz' },
      } },
    });
    assert.deepEqual(refusedStoreInstallFiles(dir).map((x) => x.file), [
      'package.json: dependencies.evil', 'package.json: dependencies.local', 'package.json: auraDependencies.@aura/../../etc',
      'package-lock.json: node_modules/a', 'package-lock.json: node_modules/b',
    ]);
    rmSync(join(dir, '.npmrc')); symlinkSync('/etc/hostname', join(dir, '.npmrc'));
    assert.ok(refusedStoreInstallFiles(dir).some((x) => x.file === '.npmrc' && /symlink/.test(x.reason)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/** npm and aura stand-ins: log who ran them, where, with what, and whether a shell secret reached them. */
function fakeTools(root) {
  const bin = join(root, 'bin'); mkdirSync(bin);
  const log = join(root, 'calls.log');
  const tool = (name, body) => { writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} uid=$(id -u) cwd=$PWD secret=\${AURA_NIS_SECRET:-none} $*" >> ${log}\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  tool('npm', 'mkdir -p node_modules/.bin node_modules/dep && : > node_modules/.bin/astro && chmod +x node_modules/.bin/astro && printf \'{"name":"dep","version":"1.0.0","scripts":{"postinstall":"id"}}\' > node_modules/dep/package.json');
  tool('aura', 'mkdir -p node_modules/@aura/app-sdk');
  writeFileSync(log, ''); chmodSync(log, 0o666);
  return { bin, log };
}

test('a store install runs as the install user, outside the app dir, with scripts off and no shell secrets; the app\'s data keeps its owners', { skip: !isRoot && 'needs root with CAP_CHOWN/SETUID' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'aura-nis-'));
  chmodSync(root, 0o755);
  const tools = fakeTools(root);
  const dir = storeApp(root, { pkg: { scripts: { postinstall: 'id' } } });
  mkdirSync(join(dir, '.sidecars', 'db'), { recursive: true });
  writeFileSync(join(dir, '.sidecars', 'db', 'PG_VERSION'), '16');
  chownSync(join(dir, '.sidecars', 'db'), 999, 999); chownSync(join(dir, '.sidecars', 'db', 'PG_VERSION'), 999, 999);
  const paths = { storeDir: join(root, 'store'), toolsDir: join(root, 'tools'), workDir: join(root, 'work') };
  const env = { PATH: `${tools.bin}:${process.env.PATH}`, AURA_NIS_SECRET: 'leaked', HOME: '/root' };
  try {
    const r = await provisionApp(dir, undefined, 'astro', { paths, env });
    assert.deepEqual(r.ran, ['npm install', 'aura sdk install']);
    const calls = readFileSync(tools.log, 'utf-8').trim().split('\n');
    assert.equal(calls.length, 2, calls.join('\n'));
    for (const c of calls) {
      assert.match(c, new RegExp(`uid=${INSTALL_UID} `), `as the install user: ${c}`);
      assert.match(c, /secret=none /, `no shell secret: ${c}`);
      assert.ok(!c.includes(`cwd=${dir} `), `never in the app dir: ${c}`);
      assert.match(c, new RegExp(`cwd=${join(root, 'work')}/`), c);
    }
    assert.match(calls[0], new RegExp(STORE_INSTALL_ARGS.join(' ').replace(/[-]/g, '\\-')));
    assert.match(calls[0], / --ignore-scripts /);
    assert.equal(statSync(join(dir, '.sidecars', 'db', 'PG_VERSION')).uid, 999, 'runtime data keeps its owner');
    for (const p of ['node_modules', 'node_modules/.bin/astro', 'node_modules/dep', 'node_modules/@aura/app-sdk']) assert.equal(statSync(join(dir, p)).uid, 0, `${p} is root's`);
    assert.equal(statSync(dir).uid, 0);
    assert.deepEqual(readFileSync(join(dir, PENDING_BUILDS_FILE), 'utf-8').trim().split('\n'), ['io.example.store (postinstall)', 'dep@1.0.0 (postinstall)']);
    assert.ok(r.warnings.some((w) => /container sandbox runs them/.test(w)));
    assert.deepEqual(execFileSync('ls', ['-A', join(root, 'work')], { encoding: 'utf-8' }), '', 'the work dir is gone');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a failed store npm install moves nothing into the app and throws (the sandbox installs at first start)', { skip: !isRoot && 'needs root with CAP_CHOWN/SETUID' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'aura-nis-'));
  chmodSync(root, 0o755);
  const bin = join(root, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'npm'), '#!/bin/sh\nmkdir -p node_modules/half\nexit 1\n'); chmodSync(join(bin, 'npm'), 0o755);
  const dir = storeApp(root);
  try {
    await assert.rejects(installStoreDepsUnprivileged(dir, {
      npm: true, sdk: false, env: { PATH: `${bin}:${process.env.PATH}` },
      paths: { storeDir: join(root, 'store'), toolsDir: join(root, 'tools'), workDir: join(root, 'work') },
    }), /npm install failed/);
    assert.equal(existsSync(join(dir, 'node_modules')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('real npm: a store app\'s and its dependency\'s install scripts do not run in the shell, and are left for the sandbox', { skip: !isRoot && 'needs root with CAP_CHOWN/SETUID' }, async (t) => {
  const npmOk = (() => { try { execFileSync('npm', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
  if (!npmOk) return t.skip('no npm here');
  const root = mkdtempSync(join(tmpdir(), 'aura-nis-real-'));
  chmodSync(root, 0o755);
  const marks = join(root, 'marks'); mkdirSync(marks); chmodSync(marks, 0o1777); // a script as the install user could write here
  const mark = join(marks, 'm');
  // A local tarball (readable by the install user): its postinstall would write a marker.
  const depSrc = join(root, 'depsrc', 'package'); mkdirSync(depSrc, { recursive: true });
  writeFileSync(join(depSrc, 'package.json'), JSON.stringify({ name: 'nisdep', version: '1.0.0', scripts: { preinstall: `id -u > ${mark}-dep-pre`, postinstall: `id -u > ${mark}-dep-post` } }));
  execFileSync('tar', ['-czf', join(root, 'nisdep.tgz'), '-C', join(root, 'depsrc'), 'package']);
  chmodSync(join(root, 'nisdep.tgz'), 0o644);
  const dir = join(root, 'app'); mkdirSync(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'nisapp', version: '0.0.0', private: true, dependencies: { nisdep: `file:${join(root, 'nisdep.tgz')}` },
    scripts: Object.fromEntries(['preinstall', 'install', 'postinstall', 'prepare'].map((p) => [p, `id -u > ${mark}-app-${p}`])),
  }));
  try {
    const r = await provisionApp(dir, undefined, 'raw', { paths: { storeDir: join(root, 'store'), toolsDir: join(root, 'tools'), workDir: join(root, 'work') } });
    assert.deepEqual(r.ran, ['npm install']);
    assert.ok(existsSync(join(dir, 'node_modules', 'nisdep', 'package.json')), 'npm installed the dependency');
    assert.equal(statSync(join(dir, 'node_modules', 'nisdep')).uid, 0);
    assert.deepEqual(execFileSync('sh', ['-c', `ls ${mark}-* 2>/dev/null || true`], { encoding: 'utf-8' }), '', 'no install script ran');
    const pending = readFileSync(join(dir, PENDING_BUILDS_FILE), 'utf-8');
    assert.match(pending, /^nisapp \(preinstall\)$/m); assert.match(pending, /^nisapp \(prepare\)$/m);
    assert.match(pending, /^nisdep@1\.0\.0 \(preinstall, postinstall\)$/m);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
