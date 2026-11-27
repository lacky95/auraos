// Durable file primitives for the release layout: a write is on disk before
// anything depends on it (Phase 7 owner decision 1: crash recovery AND
// durability, not only atomic visibility). Dependency-free.
//
//   writeFileDurable   tmp file + fsync + rename over the target + fsync of the parent
//   renameDurable      rename + fsync of both parents
//   fsyncDir           fsync a directory (makes a create/rename/unlink in it durable)
//
// A rename over a FILE is atomic on one filesystem (pointer.json, job files).
// Exchanging two non-empty DIRECTORIES needs renameat2(RENAME_EXCHANGE), which
// node cannot call: that is Phase 7a's small image-built helper (atomic app
// swap). One helper for both: this module stays the JS side of it, the
// exchange call joins it here (agreed in phase7a-progress.md / phase6-B-progress.md).
import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync, constants as fsc } from 'node:fs';
import { basename, dirname, join } from 'node:path';

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

export function renameDurable(from, to) {
  renameSync(from, to);
  fsyncDir(dirname(to));
  if (dirname(from) !== dirname(to)) fsyncDir(dirname(from));
}
