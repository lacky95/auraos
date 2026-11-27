/**
 * The device nodes a program run with `chroot <rootfs>` needs: `/dev/null`,
 * `/dev/zero`, `/dev/random`, `/dev/urandom`, as the standard character
 * devices (mode 0666, root), the way debootstrap-style chroots provide them.
 * apt needs them (apt-key, gpgv and the methods write to `/dev/null`); the
 * base-rootfs is copied from an image stage whose `/dev` is empty.
 *
 * Fail closed, never through a shell:
 *   - `<rootfs>` and `<rootfs>/dev` must be real directories, and an
 *     existing node must not be a symlink or a directory: anything else is
 *     refused (nothing is followed);
 *   - a missing or wrong node (e.g. a stray regular file left by an earlier
 *     run that wrote to `/dev/null` without a device) is replaced
 *     atomically: `mknod` (argv) creates the device under a fresh temporary
 *     name in the same directory, it is checked, then renamed over the path;
 *   - a node that is already right is left as is (idempotent).
 *
 * PRoot apps never see these nodes: ProotRunner binds the master's `/dev`
 * over `<rootfs>/dev`. Part of the PRoot module (5b PR): the `baseInstall`
 * action prepares the chroot with it.
 */
import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, renameSync, rmSync, type Stats } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/** One program, by argv (no shell); throws when it fails. */
export type ArgvRunner = (file: string, args: readonly string[], opts: { timeoutMs: number }) => string;

export const CHROOT_DEVICES: ReadonlyArray<{ name: string; major: number; minor: number }> = [
  { name: 'null', major: 1, minor: 3 },
  { name: 'zero', major: 1, minor: 5 },
  { name: 'random', major: 1, minor: 8 },
  { name: 'urandom', major: 1, minor: 9 },
];

const DEVICE_MODE = 0o666;

/** Linux `major()`/`minor()` of a `st_rdev`. */
const major = (rdev: number) => ((rdev >>> 8) & 0xfff) | (Math.floor(rdev / 2 ** 32) & ~0xfff);
const minor = (rdev: number) => (rdev & 0xff) | ((rdev >>> 12) & ~0xff);

/** Whether `st` is exactly the character device `dev`: numbers, mode 0666, owned by root. */
export function isChrootDevice(st: Stats, dev: { major: number; minor: number }): boolean {
  return st.isCharacterDevice() && major(st.rdev) === dev.major && minor(st.rdev) === dev.minor
    && (st.mode & 0o7777) === DEVICE_MODE && st.uid === 0 && st.gid === 0;
}

const lstatOrNull = (p: string): Stats | null => {
  try { return lstatSync(p); } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
};

/**
 * Makes `<rootfs>/dev/{null,zero,random,urandom}` the right character
 * devices. Returns what it created or replaced (empty when all were right);
 * throws (and changes nothing further) on anything it refuses.
 */
export function ensureChrootDevices(rootfs: string, run: ArgvRunner): string[] {
  if (!isAbsolute(rootfs)) throw new Error(`chroot devices: rootfs must be an absolute path: ${rootfs}`);
  const root = lstatOrNull(rootfs);
  if (!root || root.isSymbolicLink() || !root.isDirectory()) throw new Error(`chroot devices: refusing ${rootfs}: not a directory`);
  const dir = join(rootfs, 'dev');
  if (!lstatOrNull(dir)) mkdirSync(dir, { mode: 0o755 });
  const d = lstatSync(dir);
  if (d.isSymbolicLink() || !d.isDirectory()) throw new Error(`chroot devices: refusing ${dir}: not a directory (symlinks are never followed)`);

  const changed: string[] = [];
  for (const dev of CHROOT_DEVICES) {
    const path = join(dir, dev.name);
    const cur = lstatOrNull(path);
    if (cur && isChrootDevice(cur, dev)) continue;
    if (cur && (cur.isSymbolicLink() || cur.isDirectory())) {
      throw new Error(`chroot devices: refusing ${path}: a ${cur.isSymbolicLink() ? 'symlink' : 'directory'}, not a device`);
    }
    const tmp = join(dir, `.${dev.name}.aura-${randomBytes(8).toString('hex')}`);
    try {
      run('mknod', ['-m', '0666', '--', tmp, 'c', String(dev.major), String(dev.minor)], { timeoutMs: 10_000 });
      if (!isChrootDevice(lstatSync(tmp), dev)) throw new Error(`chroot devices: mknod did not create the ${dev.major},${dev.minor} device for ${path}`);
      renameSync(tmp, path);
    } finally {
      rmSync(tmp, { force: true });
    }
    changed.push(`${cur ? 'replaced' : 'created'} ${path} (c ${dev.major},${dev.minor})`);
  }
  return changed;
}
