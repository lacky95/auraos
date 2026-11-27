// SF-1 (D94 G8): `chroot <base-rootfs> apt-get …` needs /dev/null and friends.
// core runtimes/proot/chrootDevices.ts makes them the right character devices (null 1,3,
// zero 1,5, random 1,8, urandom 1,9; 0666 root), replaces a wrong node (the
// stray regular /dev/null an earlier failed run left) atomically, never
// follows a symlink, is idempotent and runs mknod by argv (no shell).
//
//   node tools/run-tests.mjs --only=shell
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHROOT_DEVICES, ensureChrootDevices, isChrootDevice, type ArgvRunner } from '@aura/core';

const NAMES = CHROOT_DEVICES.map((d) => d.name);

/** The real runner shape (spawnSync argv, as lib/privilegedExec.ts), recording each call. */
function argvRunner(calls: Array<{ file: string; args: readonly string[] }>): ArgvRunner {
  return (file, args, { timeoutMs }) => {
    calls.push({ file, args });
    const r = spawnSync(file, [...args], { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
    if (r.error || r.status !== 0) throw new Error(`${file} exited ${r.status}: ${r.stderr}`);
    return r.stdout;
  };
}

/** mknod works here (root with CAP_MKNOD on a filesystem that allows device nodes). */
const canMknod = (() => {
  if (process.getuid?.() !== 0) return false;
  const d = mkdtempSync(join(tmpdir(), 'aura-mknod-probe-'));
  try { return spawnSync('mknod', ['-m', '0666', '--', join(d, 'n'), 'c', '1', '3']).status === 0; } finally { rmSync(d, { recursive: true, force: true }); }
})();
const REAL = canMknod ? {} : { skip: 'needs root with CAP_MKNOD (runs in the master)' };

const rootfs = () => mkdtempSync(join(tmpdir(), 'aura-rootfs-'));
const assertAllDevices = (root: string) => {
  for (const dev of CHROOT_DEVICES) {
    const st = lstatSync(join(root, 'dev', dev.name));
    assert.ok(isChrootDevice(st, dev), `${dev.name} is c ${dev.major},${dev.minor} 0666 root`);
  }
  assert.deepEqual(readdirSync(join(root, 'dev')).sort(), [...NAMES].sort(), 'no temporary node left behind');
};

test('creates the four devices in an empty /dev (and /dev itself when missing), by argv mknod', REAL, () => {
  for (const withDev of [true, false]) {
    const root = rootfs();
    try {
      if (withDev) mkdirSync(join(root, 'dev'));
      const calls: Array<{ file: string; args: readonly string[] }> = [];
      const changed = ensureChrootDevices(root, argvRunner(calls));
      assert.equal(changed.length, 4);
      assert.ok(changed.every((c) => c.startsWith('created ')));
      assertAllDevices(root);
      assert.equal(lstatSync(join(root, 'dev')).mode & 0o777, 0o755);
      assert.equal(calls.length, 4);
      for (const [i, { file, args }] of calls.entries()) {
        const dev = CHROOT_DEVICES[i]!;
        assert.equal(file, 'mknod');
        assert.deepEqual([args[0], args[1], args[2], args[4], args[5], args[6]], ['-m', '0666', '--', 'c', String(dev.major), String(dev.minor)]);
        assert.match(String(args[3]), new RegExp(`^${root}/dev/\\.${dev.name}\\.aura-[0-9a-f]{16}$`), 'a fresh temporary name in the same directory');
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('replaces a stray regular file (the failed run\'s /dev/null) and a wrong device atomically', REAL, () => {
  const root = rootfs();
  try {
    mkdirSync(join(root, 'dev'));
    writeFileSync(join(root, 'dev', 'null'), '', { mode: 0o644 });
    // urandom as the wrong device (zero's numbers), random with the wrong mode.
    spawnSync('mknod', ['-m', '0666', '--', join(root, 'dev', 'urandom'), 'c', '1', '5']);
    spawnSync('mknod', ['-m', '0600', '--', join(root, 'dev', 'random'), 'c', '1', '8']);
    const changed = ensureChrootDevices(root, argvRunner([]));
    assert.deepEqual(changed.map((c) => c.split(' ')[0]), ['replaced', 'created', 'replaced', 'replaced']);
    assertAllDevices(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('idempotent: right devices are left alone, nothing runs', REAL, () => {
  const root = rootfs();
  try {
    ensureChrootDevices(root, argvRunner([]));
    const before = NAMES.map((n) => lstatSync(join(root, 'dev', n)).ino);
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    assert.deepEqual(ensureChrootDevices(root, argvRunner(calls)), []);
    assert.equal(calls.length, 0);
    assert.deepEqual(NAMES.map((n) => lstatSync(join(root, 'dev', n)).ino), before, 'the same inodes');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('symlinks are refused, never followed: <rootfs>, <rootfs>/dev or a node', () => {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const run = argvRunner(calls);
  const outside = rootfs();
  const root = rootfs();
  try {
    // <rootfs>/dev -> a directory outside: nothing is created there.
    symlinkSync(outside, join(root, 'dev'));
    assert.throws(() => ensureChrootDevices(root, run), /refusing .*\/dev: not a directory/);
    assert.deepEqual(readdirSync(outside), []);
    rmSync(join(root, 'dev'));

    // <rootfs>/dev/null -> a file outside: refused, the target is untouched.
    mkdirSync(join(root, 'dev'));
    writeFileSync(join(outside, 'victim'), 'keep');
    symlinkSync(join(outside, 'victim'), join(root, 'dev', 'null'));
    assert.throws(() => ensureChrootDevices(root, run), /refusing .*\/dev\/null: a symlink/);
    assert.equal(readFileSync(join(outside, 'victim'), 'utf8'), 'keep');
    assert.ok(lstatSync(join(root, 'dev', 'null')).isSymbolicLink(), 'the symlink is not replaced either');

    // A dangling symlink, and a directory in a node's place: refused too.
    rmSync(join(root, 'dev', 'null'));
    symlinkSync('/nonexistent/x', join(root, 'dev', 'null'));
    assert.throws(() => ensureChrootDevices(root, run), /a symlink/);
    rmSync(join(root, 'dev', 'null'));
    mkdirSync(join(root, 'dev', 'null'));
    assert.throws(() => ensureChrootDevices(root, run), /a directory/);

    // <rootfs> itself a symlink, or relative, or missing.
    const link = join(outside, 'rootfs-link');
    symlinkSync(root, link);
    assert.throws(() => ensureChrootDevices(link, run), /refusing .*: not a directory/);
    assert.throws(() => ensureChrootDevices('os/base-rootfs', run), /absolute path/);
    assert.throws(() => ensureChrootDevices(join(outside, 'missing'), run), /not a directory/);
    assert.equal(calls.length, 0, 'nothing ran');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('fails closed when mknod does not produce the device; no temporary file is left', () => {
  const root = rootfs();
  try {
    mkdirSync(join(root, 'dev'));
    writeFileSync(join(root, 'dev', 'null'), '', { mode: 0o644 });
    // A runner that "succeeds" but makes a regular file: the check refuses it before the rename.
    const fake: ArgvRunner = (_f, args) => { writeFileSync(String(args[3]), ''); return ''; };
    assert.throws(() => ensureChrootDevices(root, fake), /did not create the 1,3 device/);
    assert.deepEqual(readdirSync(join(root, 'dev')), ['null'], 'the original stays, no temporary left');
    // A runner that fails: the error propagates, nothing changes.
    assert.throws(() => ensureChrootDevices(root, () => { throw new Error('mknod: Operation not permitted'); }), /not permitted/);
    assert.deepEqual(readdirSync(join(root, 'dev')), ['null']);
    assert.equal(lstatSync(join(root, 'dev', 'null')).isFile(), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('source: no shell, mknod by argv only, rename for the swap', () => {
  const src = readFileSync(new URL('../../core/src/runtimes/proot/chrootDevices.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /child_process|\bexecSync\b|\bexec\(|shell:\s*true|\/bin\/sh|bash -c/);
  assert.match(src, /run\('mknod', \['-m', '0666', '--', tmp, 'c', /);
  assert.match(src, /renameSync\(tmp, path\)/);
  assert.ok(!existsSync(new URL('../src/lib/chrootDevices.sh', import.meta.url)));
  assert.ok(!existsSync(new URL('../src/lib/chrootDevices.ts', import.meta.url)), 'one copy: the PRoot module owns it (5b PR)');
});
