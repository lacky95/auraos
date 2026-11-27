/**
 * Package trees — granting a tool that is a directory, not a file.
 *
 * The bug these pin: Codex 0.172 resolves `/proc/self/exe` and expects its
 * whole platform package around it (`../codex-package.json`,
 * `codex-resources/bwrap`, `codex-path/rg`). The store held the executable
 * flat, so every sandbox got a lone binary: the TUI refused to start ("this
 * CLI has no complete local package") and the sandbox panicked for want of
 * the bundled bwrap. The grant must carry the tree, the name on PATH must
 * exec the IN-PACKAGE file, and an ungranted package must stay absent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, symlinkSync, lstatSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PACKAGE_DIR, PACKAGE_MANIFEST, readPackageMap, setPackage, packageEntry, stagePackage,
  removePackage, syncPackages, materialisePackages,
} from '../dist/app-manager/tool-packages.js';
import {
  INSTANCE_BIN_DIR, listToolchainBinaries, provisionAllowlist, writeSidecarMap,
} from '../dist/app-manager/tool-provision.js';
import { INSTANCE_LIB_DIR, toolchainMirrorLib, writeLibMap } from '../dist/app-manager/tool-libs.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'aura-pkg-'));

/** A miniature Codex platform package. */
function codexPackage(root) {
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(join(root, 'codex-resources', 'voice'), { recursive: true });
  mkdirSync(join(root, 'codex-path'), { recursive: true });
  writeFileSync(join(root, 'bin', 'codex'), 'ELF codex', { mode: 0o755 });
  writeFileSync(join(root, 'bin', 'codex-code-mode-host'), 'ELF host', { mode: 0o755 });
  writeFileSync(join(root, 'codex-package.json'), '{"entrypoint":"bin/codex"}');
  writeFileSync(join(root, 'codex-resources', 'bwrap'), 'ELF bwrap', { mode: 0o755 });
  writeFileSync(join(root, 'codex-resources', 'voice', 'manifest.json'), '{}');
  writeFileSync(join(root, 'codex-path', 'rg'), 'ELF rg', { mode: 0o755 });
  return root;
}

/** A hardlink-mode data dir whose mirror holds codex as `cap install` leaves it. */
function installedCodex() {
  const dataDir = tmp();
  const mirrorBin = join(dataDir, 'aura', 'toolchain', 'bin');
  mkdirSync(mirrorBin, { recursive: true });
  mkdirSync(toolchainMirrorLib(dataDir), { recursive: true });
  const src = codexPackage(join(tmp(), 'vendor'));
  writeFileSync(join(mirrorBin, 'codex'), 'ELF codex', { mode: 0o755 });
  writeFileSync(join(mirrorBin, 'codex-code-mode-host'), 'ELF host', { mode: 0o755 });
  writeFileSync(join(mirrorBin, 'git'), 'ELF git', { mode: 0o755 });
  writeSidecarMap(mirrorBin, { codex: ['codex-code-mode-host'] });
  stagePackage(src, [mirrorBin], 'codex');
  setPackage([mirrorBin], 'codex', 'bin/codex');
  return { dataDir, mirrorBin, src, dir: join(dataDir, 'aura', 'runtime', 'inst-1', 'tools') };
}

// ── the map ────────────────────────────────────────────────────────────────
test('the package map round-trips, clears, and stays out of the binary list', () => {
  const bin = tmp();
  setPackage([bin], 'codex', 'bin/codex');
  assert.deepEqual(readPackageMap(bin), { codex: 'bin/codex' });
  stagePackage(codexPackage(join(tmp(), 'v')), [bin], 'codex');
  assert.deepEqual(listToolchainBinaries(bin), [], 'neither .packages.json nor .pkg is grantable');
  setPackage([bin], 'codex', null);
  assert.deepEqual(readPackageMap(bin), {});
});

test('a corrupt map or an escaping entry degrades to "no package"', () => {
  const bin = tmp();
  writeFileSync(join(bin, PACKAGE_MANIFEST), '{nope');
  assert.deepEqual(readPackageMap(bin), {});
  writeFileSync(join(bin, PACKAGE_MANIFEST), JSON.stringify({ a: '../../etc/passwd', b: '/abs', c: 'bin/c' }));
  assert.deepEqual(readPackageMap(bin), { c: 'bin/c' });
});

test('packageEntry is the executable inside its root, never outside it', () => {
  assert.equal(packageEntry('/v/x86_64', '/v/x86_64/bin/codex'), 'bin/codex');
  assert.throws(() => packageEntry('/v/x86_64', '/usr/local/bin/codex'));
  assert.throws(() => packageEntry('/v/x86_64', '/v/x86_64'));
});

// ── the store ──────────────────────────────────────────────────────────────
test('staging copies the whole tree into every store, dereferencing links', () => {
  const src = codexPackage(join(tmp(), 'v'));
  symlinkSync('codex-path/rg', join(src, 'rg-link'));
  const a = tmp(); const b = tmp();
  stagePackage(src, [a, b], 'codex');
  for (const bin of [a, b]) {
    const p = join(bin, PACKAGE_DIR, 'codex');
    assert.equal(readFileSync(join(p, 'codex-resources', 'bwrap'), 'utf8'), 'ELF bwrap');
    assert.ok(statSync(join(p, 'bin', 'codex')).mode & 0o100, 'exec bit kept');
    assert.ok(lstatSync(join(p, 'rg-link')).isFile(), 'a link becomes a file');
  }
  removePackage([a, b], 'codex');
  assert.ok(!existsSync(join(a, PACKAGE_DIR, 'codex')) && !existsSync(join(b, PACKAGE_DIR, 'codex')));
});

test('re-staging swaps the tree: new inodes, the old ones untouched', () => {
  const src = codexPackage(join(tmp(), 'v'));
  const bin = tmp();
  stagePackage(src, [bin], 'codex');
  const before = statSync(join(bin, PACKAGE_DIR, 'codex', 'bin', 'codex')).ino;
  stagePackage(src, [bin], 'codex');
  assert.notEqual(statSync(join(bin, PACKAGE_DIR, 'codex', 'bin', 'codex')).ino, before);
});

test('syncPackages only adds what the other store lacks', () => {
  const a = tmp(); const b = tmp();
  stagePackage(codexPackage(join(tmp(), 'v')), [a], 'codex');
  mkdirSync(join(b, PACKAGE_DIR, 'other'), { recursive: true });
  assert.deepEqual(syncPackages(a, b), ['codex']);
  assert.ok(existsSync(join(b, PACKAGE_DIR, 'codex', 'codex-package.json')));
  assert.deepEqual(syncPackages(a, b), [], 'idempotent');
  assert.ok(existsSync(join(b, PACKAGE_DIR, 'other')), 'never removes');
});

// ── provisioning ───────────────────────────────────────────────────────────
test('a grant carries the package as hardlinks and execs the in-package binary', () => {
  const { dataDir, mirrorBin, dir } = installedCodex();
  const res = provisionAllowlist({ dataDir, dir, tools: ['codex'], legacyStoreBin: mirrorBin });
  assert.equal(res.mode, 'hardlink');
  assert.ok(res.linked.includes('codex') && res.linked.includes('codex-code-mode-host'));

  const pkg = join(dir, PACKAGE_DIR, 'codex');
  for (const f of ['bin/codex', 'bin/codex-code-mode-host', 'codex-package.json', 'codex-resources/bwrap', 'codex-resources/voice/manifest.json', 'codex-path/rg']) {
    assert.equal(statSync(join(pkg, f)).ino, statSync(join(mirrorBin, PACKAGE_DIR, 'codex', f)).ino, `${f} is the store's file`);
  }
  const wrapper = readFileSync(join(dir, 'codex'), 'utf8');
  assert.match(wrapper, /^#!\/bin\/sh\n/);
  assert.match(wrapper, /exec "\/aura\/my-tools\/\.pkg\/codex\/bin\/codex" "\$@"/);
  assert.doesNotMatch(wrapper, /LD_LIBRARY_PATH/, 'no libs staged, no lib path');
  assert.ok(statSync(join(dir, 'codex')).mode & 0o100);
});

test('an ungranted package is absent, and revoking removes it', () => {
  const { dataDir, mirrorBin, dir } = installedCodex();
  provisionAllowlist({ dataDir, dir, tools: ['git'], legacyStoreBin: mirrorBin });
  assert.ok(!existsSync(join(dir, PACKAGE_DIR)), 'no .pkg without the grant');
  provisionAllowlist({ dataDir, dir, tools: ['codex'], legacyStoreBin: mirrorBin });
  assert.ok(existsSync(join(dir, PACKAGE_DIR, 'codex')));
  provisionAllowlist({ dataDir, dir, tools: ['git'], legacyStoreBin: mirrorBin });
  assert.ok(!existsSync(join(dir, PACKAGE_DIR)) && !existsSync(join(dir, 'codex')));
  provisionAllowlist({ dataDir, dir, tools: ['codex', '#'], legacyStoreBin: mirrorBin });
  assert.ok(!existsSync(join(dir, PACKAGE_DIR)), 'deny-list keeps it out');
});

test('a re-installed package is re-linked to the new inodes, stale files dropped', () => {
  const { dataDir, mirrorBin, src, dir } = installedCodex();
  provisionAllowlist({ dataDir, dir, tools: ['*'], legacyStoreBin: mirrorBin });
  writeFileSync(join(dir, PACKAGE_DIR, 'codex', 'stray'), 'x');
  stagePackage(src, [mirrorBin], 'codex');
  provisionAllowlist({ dataDir, dir, tools: ['*'], legacyStoreBin: mirrorBin });
  const f = 'codex-resources/bwrap';
  assert.equal(statSync(join(dir, PACKAGE_DIR, 'codex', f)).ino, statSync(join(mirrorBin, PACKAGE_DIR, 'codex', f)).ino);
  assert.ok(!existsSync(join(dir, PACKAGE_DIR, 'codex', 'stray')));
});

test('a package the store lacks falls back to the flat binary', () => {
  const { dataDir, mirrorBin, dir } = installedCodex();
  removePackage([mirrorBin], 'codex');
  const res = provisionAllowlist({ dataDir, dir, tools: ['codex'], legacyStoreBin: mirrorBin });
  assert.ok(res.linked.includes('codex'));
  assert.equal(statSync(join(dir, 'codex')).ino, statSync(join(mirrorBin, 'codex')).ino, 'the old hardlink');
  assert.ok(!existsSync(join(dir, PACKAGE_DIR)));
});

test('with staged libs the package wrapper scopes LD_LIBRARY_PATH and skips .bin', () => {
  const { dataDir, mirrorBin, dir } = installedCodex();
  writeFileSync(join(toolchainMirrorLib(dataDir), 'libx.so.1'), 'ELF');
  writeLibMap(mirrorBin, { git: [{ soname: 'libx.so.1', origin: '/usr/lib/libx.so.1', kind: 'staged' }] });
  provisionAllowlist({ dataDir, dir, tools: ['git', 'codex'], legacyStoreBin: mirrorBin });
  assert.ok(existsSync(join(dir, INSTANCE_LIB_DIR, 'libx.so.1')));
  const wrapper = readFileSync(join(dir, 'codex'), 'utf8');
  assert.match(wrapper, /LD_LIBRARY_PATH/);
  assert.match(wrapper, /exec "\/aura\/my-tools\/\.pkg\/codex\/bin\/codex"/);
  assert.ok(!existsSync(join(dir, INSTANCE_BIN_DIR, 'codex')), 'the package executable is not duplicated in .bin');
  assert.ok(existsSync(join(dir, INSTANCE_BIN_DIR, 'codex-code-mode-host')), 'helpers keep the old path');
});

test('symlink mode reaches the package in the bound store and copies nothing', () => {
  // An empty mirror means symlink mode; the runner binds the real store.
  const dataDir = tmp();
  mkdirSync(join(dataDir, 'aura', 'toolchain', 'bin'), { recursive: true });
  const store = tmp();
  writeFileSync(join(store, 'codex'), 'ELF codex', { mode: 0o755 });
  stagePackage(codexPackage(join(tmp(), 'v')), [store], 'codex');
  setPackage([store], 'codex', 'bin/codex');
  const dir = join(dataDir, 'aura', 'runtime', 'inst-s', 'tools');
  const res = provisionAllowlist({ dataDir, dir, tools: ['codex'], legacyStoreBin: store });
  assert.equal(res.mode, 'symlink');
  assert.match(readFileSync(join(dir, 'codex'), 'utf8'), /exec "\/aura\/all-tools\/\.pkg\/codex\/bin\/codex"/);
  assert.ok(!existsSync(join(dir, PACKAGE_DIR)));
});

test('materialisePackages reports owners the store lacks', () => {
  const toolsDir = tmp(); const storeBin = tmp();
  const r = materialisePackages({ toolsDir, storeBin, owners: ['codex'], mode: 'hardlink' });
  assert.deepEqual(r, { linked: [], missing: ['codex'] });
});
