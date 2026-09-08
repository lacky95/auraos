/**
 * Shared libraries — keeping a dynamically-linked capability runnable across
 * the sandbox boundary.
 *
 * The bug these pin: `aura cap install adb` staged adb's `ldd` graph into
 * /os/base-rootfs and nowhere else. That is PRoot's `/`, so PRoot apps worked;
 * a container app runs its own image and sees only the flat dir of binaries at
 * /aura/my-tools. So `adb` installed clean, sat on PATH, and died on every run
 * with "libbase.so.0: cannot open shared object file" — a failure that looks
 * nothing like a missing grant.
 *
 * The subtle half is naming: `ldd`'s left-hand side is the SONAME the loader
 * searches for, and the right-hand side is often a differently-named real file
 * (`libusb-1.0.so.0` => `libusb-1.0.so.0.3.0`). Copying dereferences, so a
 * store keyed by the resolved filename holds a name nothing ever asks for.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseLdd, readLinkage, BASELINE_SONAMES,
  readLibMap, writeLibMap, setLibs, LIB_MANIFEST, INSTANCE_LIB_DIR,
  stageLibs, restoreLibsFromStore, libsForBinaries, orphanedLibs, conflictingLibs,
  materialiseLibs, toolchainMirrorLib, toolchainLibFor,
} from '../dist/app-manager/tool-libs.js';
import { listToolchainBinaries, provisionAllowlist } from '../dist/app-manager/tool-provision.js';

const store = () => mkdtempSync(join(tmpdir(), 'aura-libs-'));

/** Real `ldd /usr/bin/adb` output on Debian 12 — the case that started this. */
const ADB_LDD = [
  '\tlinux-vdso.so.1 (0x00007ffd8b5f4000)',
  '\tlibbase.so.0 => /usr/lib/x86_64-linux-gnu/android/libbase.so.0 (0x00007f0a1c000000)',
  '\tlibcrypto.so.0 => /usr/lib/x86_64-linux-gnu/android/libcrypto.so.0 (0x00007f0a1b800000)',
  '\tlibcutils.so.0 => /usr/lib/x86_64-linux-gnu/android/libcutils.so.0 (0x00007f0a1bf00000)',
  '\tliblog.so.0 => /usr/lib/x86_64-linux-gnu/android/liblog.so.0 (0x00007f0a1bd00000)',
  '\tlibusb-1.0.so.0 => /lib/x86_64-linux-gnu/libusb-1.0.so.0 (0x00007f0a1bc00000)',
  '\tlibstdc++.so.6 => /lib/x86_64-linux-gnu/libstdc++.so.6 (0x00007f0a1b400000)',
  '\tlibm.so.6 => /lib/x86_64-linux-gnu/libm.so.6 (0x00007f0a1bb00000)',
  '\tlibgcc_s.so.1 => /lib/x86_64-linux-gnu/libgcc_s.so.1 (0x00007f0a1ba00000)',
  '\tlibc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x00007f0a1b000000)',
  '\t/lib64/ld-linux-x86-64.so.2 (0x00007f0a1c400000)',
].join('\n');

// ── parsing ldd ──────────────────────────────────────────────────────────────
test('the five android/usb libs stage, the glibc baseline does not', () => {
  const { linkage, deps } = parseLdd(ADB_LDD);
  assert.equal(linkage, 'dynamic');
  const staged = deps.filter((d) => d.kind === 'staged').map((d) => d.soname);
  assert.deepEqual(staged, [
    'libbase.so.0', 'libcrypto.so.0', 'libcutils.so.0', 'liblog.so.0', 'libusb-1.0.so.0',
  ], 'exactly the libs the app image has never seen');
  for (const s of ['libc.so.6', 'libm.so.6', 'libstdc++.so.6', 'libgcc_s.so.1', 'linux-vdso.so.1']) {
    assert.equal(deps.find((d) => d.soname === s)?.kind, 'baseline', `${s} must never be staged`);
  }
});

test('the loader line has no => and is still classified, not dropped', () => {
  const deps = parseLdd(ADB_LDD).deps;
  const loader = deps.find((d) => d.soname === 'ld-linux-x86-64.so.2');
  assert.ok(loader, 'the bare /lib64/ld-linux… line is parsed');
  assert.equal(loader.kind, 'baseline');
});

test('"not found" is recorded as missing, not silently dropped', () => {
  // The old regex required whitespace after a path, so this line vanished and
  // an unrunnable binary reported a clean install.
  const { deps } = parseLdd('\tlibbase.so.0 => not found\n\tlibc.so.6 => /lib/libc.so.6 (0x7f)');
  const dep = deps.find((d) => d.soname === 'libbase.so.0');
  assert.equal(dep.kind, 'missing');
  assert.equal(dep.origin, null);
});

test('a resolved line with no load address still parses', () => {
  const { deps } = parseLdd('\tlibfoo.so.1 => /usr/lib/libfoo.so.1');
  assert.deepEqual(deps, [{ soname: 'libfoo.so.1', origin: '/usr/lib/libfoo.so.1', kind: 'staged' }]);
});

test('statically linked binaries have nothing to carry', () => {
  assert.deepEqual(parseLdd('\tstatically linked'), { linkage: 'static', deps: [] });
  assert.deepEqual(parseLdd('\tnot a dynamic executable'), { linkage: 'static', deps: [] });
});

test('a soname is recorded once even if ldd repeats it', () => {
  const { deps } = parseLdd('\tlibz.so.1 => /a/libz.so.1 (0x1)\n\tlibz.so.1 => /b/libz.so.1 (0x2)');
  assert.equal(deps.length, 1);
  assert.equal(deps[0].origin, '/a/libz.so.1');
});

test('readLinkage reports a shell script as a script, not a broken tool', () => {
  const root = store();
  const p = join(root, 'aura');
  writeFileSync(p, '#!/bin/sh\necho hi\n');
  // ldd exits non-zero on a script; that is an answer, not a failure.
  const r = readLinkage(p, () => { throw new Error('not a dynamic executable'); });
  assert.equal(r.linkage, 'script');
  assert.deepEqual(r.deps, []);
});

// ── the manifest on disk ─────────────────────────────────────────────────────
test('the lib map round-trips and stays out of the grantable list', () => {
  const bin = store();
  const deps = [{ soname: 'libbase.so.0', origin: '/usr/lib/android/libbase.so.0', kind: 'staged' }];
  writeLibMap(bin, { adb: deps });
  assert.deepEqual(readLibMap(bin), { adb: deps });
  assert.ok(existsSync(join(bin, LIB_MANIFEST)));
  assert.deepEqual(listToolchainBinaries(bin), [], 'the dotfile is never offered as a tool');
});

test('a missing or corrupt map degrades to {} instead of throwing', () => {
  assert.deepEqual(readLibMap(store()), {});
  const bin = store();
  writeFileSync(join(bin, LIB_MANIFEST), '{ not json');
  assert.deepEqual(readLibMap(bin), {});
  const bin2 = store();
  writeFileSync(join(bin2, LIB_MANIFEST), '["wrong", "shape"]');
  assert.deepEqual(readLibMap(bin2), {});
});

test('setLibs writes every bin dir, and an empty list clears the entry', () => {
  const a = store(), b = store();
  const deps = [{ soname: 'libz.so.1', origin: '/usr/lib/libz.so.1', kind: 'staged' }];
  setLibs([a, b], 'tool', deps);
  assert.deepEqual(readLibMap(a), readLibMap(b), 'store and mirror agree');
  setLibs([a, b], 'tool', []);
  assert.deepEqual(readLibMap(a), {}, 'a tool that stopped needing a lib leaves no stale entry');
});

// ── staging ──────────────────────────────────────────────────────────────────
test('a staged lib is named by SONAME, not by the file it resolved to', () => {
  const src = store(), libDir = store();
  // libusb is the real-world case: soname libusb-1.0.so.0, file …so.0.3.0.
  const real = join(src, 'libusb-1.0.so.0.3.0');
  writeFileSync(real, 'ELF');
  const { staged } = stageLibs(
    [{ soname: 'libusb-1.0.so.0', origin: real, kind: 'staged' }], [libDir],
  );
  assert.deepEqual(staged, ['libusb-1.0.so.0']);
  assert.ok(existsSync(join(libDir, 'libusb-1.0.so.0')), 'stored under the name the loader asks for');
  assert.ok(!existsSync(join(libDir, 'libusb-1.0.so.0.3.0')), 'not under the resolved filename');
});

test('re-staging truncates in place so instance hardlinks see the new content', () => {
  const src = store(), libDir = store(), inst = store();
  const real = join(src, 'libz.so.1');
  writeFileSync(real, 'v1');
  const dep = [{ soname: 'libz.so.1', origin: real, kind: 'staged' }];
  stageLibs(dep, [libDir]);
  materialiseLibs({ toolsDir: inst, libStore: libDir, sonames: ['libz.so.1'], mode: 'hardlink' });

  writeFileSync(real, 'v2');
  stageLibs(dep, [libDir]);
  assert.equal(
    readFileSync(join(inst, INSTANCE_LIB_DIR, 'libz.so.1'), 'utf-8'), 'v2',
    'unlink-then-copy would have stranded the instance on v1',
  );
});

test('baseline libs are never staged even when ldd resolved them', () => {
  const src = store(), libDir = store();
  const p = join(src, 'libc.so.6');
  writeFileSync(p, 'ELF');
  const { staged } = stageLibs([{ soname: 'libc.so.6', origin: p, kind: 'baseline' }], [libDir]);
  assert.deepEqual(staged, []);
  assert.ok(!existsSync(join(libDir, 'libc.so.6')));
  assert.ok(BASELINE_SONAMES.has('libc.so.6'));
});

test('restore puts a lib back at its origin path and under its soname', () => {
  const libStore = store(), root = store();
  writeFileSync(join(libStore, 'libusb-1.0.so.0'), 'ELF');
  const map = { adb: [{ soname: 'libusb-1.0.so.0', origin: '/lib/x86_64-linux-gnu/libusb-1.0.so.0.3.0', kind: 'staged' }] };
  const restored = restoreLibsFromStore(map, libStore, root);
  assert.equal(restored.length, 2, 'both the real filename and the soname');
  assert.ok(existsSync(join(root, 'lib/x86_64-linux-gnu/libusb-1.0.so.0.3.0')));
  assert.ok(existsSync(join(root, 'lib/x86_64-linux-gnu/libusb-1.0.so.0')));
});

test('restore never overwrites a lib the image legitimately ships', () => {
  const libStore = store(), root = store();
  writeFileSync(join(libStore, 'libz.so.1'), 'ours');
  mkdirSync(join(root, 'usr/lib'), { recursive: true });
  writeFileSync(join(root, 'usr/lib/libz.so.1'), 'theirs');
  restoreLibsFromStore({ t: [{ soname: 'libz.so.1', origin: '/usr/lib/libz.so.1', kind: 'staged' }] }, libStore, root);
  assert.equal(readFileSync(join(root, 'usr/lib/libz.so.1'), 'utf-8'), 'theirs');
});

// ── grant expansion ──────────────────────────────────────────────────────────
test('an instance gets libs for the tools it was granted and no others', () => {
  const map = {
    adb: [{ soname: 'libbase.so.0', origin: '/x', kind: 'staged' }],
    other: [{ soname: 'libsecret.so.9', origin: '/y', kind: 'staged' }],
  };
  assert.deepEqual(libsForBinaries(['adb'], map), ['libbase.so.0']);
  assert.deepEqual(libsForBinaries(['adb', 'other'], map).length, 2);
  assert.deepEqual(libsForBinaries(['nothing-granted'], map), []);
});

test('baseline deps never reach an instance', () => {
  const map = { adb: [
    { soname: 'libbase.so.0', origin: '/x', kind: 'staged' },
    { soname: 'libc.so.6', origin: '/y', kind: 'baseline' },
  ] };
  assert.deepEqual(libsForBinaries(['adb'], map), ['libbase.so.0']);
});

test('a shared lib survives removing one of its two owners', () => {
  const map = {
    adb:  [{ soname: 'libz.so.1', origin: '/z', kind: 'staged' }],
    fast: [{ soname: 'libz.so.1', origin: '/z', kind: 'staged' }],
  };
  assert.deepEqual(orphanedLibs(map, 'adb'), [], 'fastboot still needs it');
  assert.deepEqual(orphanedLibs({ adb: map.adb }, 'adb'), ['libz.so.1'], 'last owner frees it');
});

test('a cap with no recorded libs frees nothing on another cap\'s behalf', () => {
  // Caps installed before libs were tracked contribute no references; treating
  // that as "nobody needs it" would strip a lib out from under them.
  assert.deepEqual(orphanedLibs({ adb: [] }, 'adb'), []);
  assert.deepEqual(orphanedLibs({}, 'never-installed'), []);
});

test('two caps staging the same soname from different paths is reported', () => {
  const map = { a: [{ soname: 'libz.so.1', origin: '/usr/lib/libz.so.1', kind: 'staged' }] };
  const deps = [{ soname: 'libz.so.1', origin: '/opt/other/libz.so.1', kind: 'staged' }];
  assert.deepEqual(conflictingLibs(map, 'b', deps), ['libz.so.1']);
  assert.deepEqual(conflictingLibs(map, 'b', map.a), [], 'same path is not a conflict');
});

// ── per-instance materialisation ─────────────────────────────────────────────
test('.lib holds exactly the granted union and keeps its inode across refreshes', () => {
  const libStore = store(), inst = store();
  for (const n of ['libbase.so.0', 'libz.so.1']) writeFileSync(join(libStore, n), 'ELF');

  materialiseLibs({ toolsDir: inst, libStore, sonames: ['libbase.so.0', 'libz.so.1'], mode: 'hardlink' });
  const libDir = join(inst, INSTANCE_LIB_DIR);
  const ino = statSync(libDir).ino;

  // Revoking a tool must drop its lib — and must NOT replace the directory:
  // a container binds it by inode, so a new one would be invisible inside.
  const r = materialiseLibs({ toolsDir: inst, libStore, sonames: ['libz.so.1'], mode: 'hardlink' });
  assert.deepEqual(r.linked, ['libz.so.1']);
  assert.ok(!existsSync(join(libDir, 'libbase.so.0')), 'stale lib pruned');
  assert.equal(statSync(libDir).ino, ino, 'the .lib dir is reconciled in place, never recreated');
});

test('a lib the store lacks is reported, not silently skipped', () => {
  const inst = store();
  const r = materialiseLibs({ toolsDir: inst, libStore: store(), sonames: ['libgone.so.1'], mode: 'hardlink' });
  assert.deepEqual(r.missing, ['libgone.so.1']);
});

test('symlink mode copies, because the lib store is not mounted in the sandbox', () => {
  const libStore = store(), inst = store();
  writeFileSync(join(libStore, 'libz.so.1'), 'ELF');
  materialiseLibs({ toolsDir: inst, libStore, sonames: ['libz.so.1'], mode: 'symlink' });
  const st = statSync(join(inst, INSTANCE_LIB_DIR, 'libz.so.1'));
  assert.ok(st.isFile() && st.nlink === 1, 'a symlink into the store would dangle inside the sandbox');
});

// ── end to end through provisionAllowlist ────────────────────────────────────
test('provisioning a grant carries the tool AND its libraries', () => {
  const dataDir = store();
  const mirrorBin = join(dataDir, 'aura', 'toolchain', 'bin');
  const mirrorLib = toolchainMirrorLib(dataDir);
  mkdirSync(mirrorBin, { recursive: true });
  mkdirSync(mirrorLib, { recursive: true });
  writeFileSync(join(mirrorBin, 'adb'), 'ELF');
  writeFileSync(join(mirrorBin, 'gh'), 'ELF');
  writeFileSync(join(mirrorLib, 'libbase.so.0'), 'ELF');
  writeLibMap(mirrorBin, { adb: [{ soname: 'libbase.so.0', origin: '/usr/lib/android/libbase.so.0', kind: 'staged' }] });

  const dir = join(dataDir, 'aura', 'runtime', 'inst-1', 'tools');
  const res = provisionAllowlist({ dataDir, dir, tools: ['adb'], legacyStoreBin: mirrorBin });

  assert.ok(res.linked.includes('adb'));
  assert.deepEqual(res.libs, ['libbase.so.0'], 'the lib travelled with the grant');
  assert.deepEqual(res.missingLibs, []);
  assert.ok(existsSync(join(dir, INSTANCE_LIB_DIR, 'libbase.so.0')));

  // Revoke adb for gh: the lib goes with it.
  const res2 = provisionAllowlist({ dataDir, dir, tools: ['gh'], legacyStoreBin: mirrorBin });
  assert.deepEqual(res2.libs, []);
  assert.ok(!existsSync(join(dir, INSTANCE_LIB_DIR, 'libbase.so.0')), 'an ungranted tool leaves no libs behind');
});

test('a pre-existing .lib dir does not abort emptying the rest of the allowlist', () => {
  // Regression: the empty-in-place loop used a non-recursive rmSync, which
  // throws ERR_FS_EISDIR on a directory. The catch wrapped the whole loop, so
  // one .lib would abandon every entry after it — silently leaving revoked
  // tools in place.
  const dataDir = store();
  const mirrorBin = join(dataDir, 'aura', 'toolchain', 'bin');
  mkdirSync(mirrorBin, { recursive: true });
  for (const n of ['aaa', 'zzz']) writeFileSync(join(mirrorBin, n), 'ELF');
  mkdirSync(toolchainMirrorLib(dataDir), { recursive: true });

  const dir = join(dataDir, 'aura', 'runtime', 'inst-2', 'tools');
  provisionAllowlist({ dataDir, dir, tools: ['aaa', 'zzz'], legacyStoreBin: mirrorBin });
  mkdirSync(join(dir, INSTANCE_LIB_DIR), { recursive: true });

  provisionAllowlist({ dataDir, dir, tools: [], legacyStoreBin: mirrorBin });
  assert.ok(!existsSync(join(dir, 'aaa')), 'revoked before .lib');
  assert.ok(!existsSync(join(dir, 'zzz')), 'revoked AFTER .lib — the case that used to survive');
});

test('toolchainLibFor is the lib store beside a bin store', () => {
  assert.equal(toolchainLibFor('/os/toolchain/bin'), '/os/toolchain/lib');
  assert.equal(toolchainMirrorLib('/data'), '/data/aura/toolchain/lib');
});
