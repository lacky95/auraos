// Durable file primitives for the release layout: a write is on disk before
// anything depends on it (Phase 7 owner decision 1: crash recovery AND
// durability, not only atomic visibility). Dependency-free.
//
// ONE helper (owner rule): directory renames and exchanges go through Phase
// 7a's static `aura-rename-exchange` (os/rename-exchange, renameat2 + parent
// fsync), the same binary core nexus/Installer.ts uses for app swaps. The
// release builder's runner image builds it at the same path as the shell
// image (/os/rename-exchange/aura-rename-exchange).
//
//   writeFileDurable   tmp file + fsync + rename over the target + fsync of the parent
//                      (a FILE replace: pointer.json, job files; atomic with rename(2))
//   renameDurable      a directory rename that never replaces (RENAME_NOREPLACE) + parent fsyncs
//   exchangeDurable    swap two paths atomically (RENAME_EXCHANGE) + parent fsyncs; no fallback
//   fsyncDir           fsync a directory
//
// Without the helper (unit tests, a host without the image), renameDurable
// falls back to "target must not exist" + rename(2) + fsync of both parents:
// the same result on one filesystem, minus the kernel's no-replace guarantee
// against a concurrent creator (the activation lock excludes those).
// exchangeDurable has no fallback (fail closed, like 7a's Installer).
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync, constants as fsc } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** Where the images put 7a's helper (core nexus/Installer.ts RENAME_EXCHANGE_IMAGE_PATH). */
export const RENAME_EXCHANGE_PATH = '/os/rename-exchange/aura-rename-exchange';
const EXIT_UNSUPPORTED = 3;

export const helperPath = () => process.env.AURA_RENAME_EXCHANGE ?? RENAME_EXCHANGE_PATH;
export const hasHelper = () => existsSync(helperPath());

function helper(op, a, b) {
  const r = spawnSync(helperPath(), [op, a, b], { encoding: 'utf8' });
  if (r.status === 0) return;
  const e = new Error(`aura-rename-exchange ${op} ${a} ${b}: ${(r.stderr || r.error?.message || '').trim()}`);
  e.code = r.status === EXIT_UNSUPPORTED ? 'unsupported' : 'rename-failed';
  throw e;
}

export function fsyncDir(dir) {
  let fd;
  try {
    fd = openSync(dir, fsc.O_RDONLY | (fsc.O_DIRECTORY ?? 0));
    fsyncSync(fd);
  } catch (e) {
    // Some filesystems refuse fsync on a directory (EINVAL); the rename is still atomic there.
    if (e.code !== 'EINVAL' && e.code !== 'EISDIR') throw e;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function writeFileDurable(file, data, { mode = 0o644 } = {}) {
  const tmp = join(dirname(file), `.${basename(file)}.tmp-${process.pid}-${Date.now()}`);
  const fd = openSync(tmp, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL, mode);
  try {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
    fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    try { unlinkSync(tmp); } catch { /* gone */ }
    throw e;
  }
  closeSync(fd);
  renameSync(tmp, file);
  fsyncDir(dirname(file));
}

export const writeJsonDurable = (file, obj, opts) => writeFileDurable(file, `${JSON.stringify(obj, null, 2)}\n`, opts);

/** Renames `from` to `to`; never replaces an existing `to`. */
export function renameDurable(from, to) {
  if (hasHelper()) { helper('rename', from, to); return; }
  if (existsSync(to)) throw Object.assign(new Error(`${to} exists: a durable rename never replaces`), { code: 'EEXIST' });
  renameSync(from, to);
  fsyncDir(dirname(to));
  if (dirname(from) !== dirname(to)) fsyncDir(dirname(from));
}

/** Swaps two existing paths atomically (stream U / Phase 7 directory switches). Needs the helper. */
export function exchangeDurable(a, b) {
  if (!hasHelper()) throw Object.assign(new Error(`no ${helperPath()}: an atomic exchange needs the image's rename-exchange helper (no two-rename fallback)`), { code: 'unsupported' });
  helper('exchange', a, b);
}
