// The one activation lock (D68 "builder must provide"; Phase 6 stream U):
// a build-and-activate job, a rollback and a Phase 7 system-patch activation
// all hold it, so two of them never run at once. Dependency-free.
//
// `aura/release/lock` is created with O_EXCL and holds
//   { v: 1, jobId, purpose, pid, host, startedAt, heartbeatAt }.
// The holder renews `heartbeatAt` while it works. Another job is refused
// (`locked`) while the heartbeat is fresh. A holder that died (OOM, host
// reboot, killed updater container) stops renewing: after STALE_MS its lock is
// stale and the next job takes it over, recording whose lock it broke. PIDs
// are not used for liveness: the shell, the updater container and the host
// installer live in different PID namespaces.
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, unlinkSync, writeSync, fsyncSync, constants as fsc } from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { fsyncDir, writeJsonDurable } from './durable.mjs';

export const HEARTBEAT_MS = 30_000;
export const STALE_MS = 5 * 60_000;

export class LockError extends Error {
  constructor(code, message, holder) { super(message); this.code = code; this.holder = holder ?? null; }
}

export function readLock(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') return null;
    return { corrupt: true };   // a half-written lock (crash during create): treated as stale
  }
}

const ageMs = (l, now) => {
  const t = Date.parse(l?.heartbeatAt ?? l?.startedAt ?? '');
  return Number.isFinite(t) ? now - t : Infinity;
};

/**
 * Takes the lock for `jobId` or throws LockError('locked', …) naming the holder.
 * Returns a handle: { jobId, file, brokeStale, heartbeat(), release(), owned() }.
 */
export function acquireLock(file, { jobId, purpose = 'build', staleMs = STALE_MS, now = () => Date.now(), autoHeartbeat = true } = {}) {
  mkdirSync(dirname(file), { recursive: true });
  let brokeStale = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const at = new Date(now()).toISOString();
    const body = { v: 1, jobId, purpose, pid: process.pid, host: hostname(), startedAt: at, heartbeatAt: at };
    let fd;
    try {
      fd = openSync(file, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL, 0o644);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const held = readLock(file);
      if (held && !held.corrupt && held.jobId === jobId) throw new LockError('locked', `the activation lock is already held by this job (${jobId})`, held);
      if (held && ageMs(held, now()) < staleMs) {
        throw new LockError('locked', `another release job holds the activation lock: ${held.jobId} (${held.purpose}, since ${held.startedAt}, last heartbeat ${held.heartbeatAt})`, held);
      }
      // Stale: move it aside (only one contender's rename can succeed), then retry the create.
      try { renameSync(file, `${file}.stale-${jobId}`); fsyncDir(dirname(file)); brokeStale = held ?? { gone: true }; } catch (r) { if (r.code !== 'ENOENT') throw r; }
      continue;
    }
    try {
      writeSync(fd, `${JSON.stringify(body, null, 2)}\n`);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    fsyncDir(dirname(file));
    return handle(file, body, brokeStale, now, autoHeartbeat);
  }
  throw new LockError('locked', 'the activation lock changed hands while taking it; try again');
}

function handle(file, body, brokeStale, now, autoHeartbeat) {
  let timer = null;
  const owned = () => readLock(file)?.jobId === body.jobId;
  const h = {
    jobId: body.jobId,
    file,
    brokeStale,
    owned,
    heartbeat() {
      if (!owned()) throw new LockError('lost', `the activation lock of ${body.jobId} was taken over (stale heartbeat)`);
      writeJsonDurable(file, { ...body, heartbeatAt: new Date(now()).toISOString() });
    },
    release() {
      if (timer) { clearInterval(timer); timer = null; }
      if (!owned()) return false;
      unlinkSync(file);
      fsyncDir(dirname(file));
      return true;
    },
  };
  if (autoHeartbeat) {
    timer = setInterval(() => { try { h.heartbeat(); } catch { /* reported by the next owned() check */ } }, HEARTBEAT_MS);
    timer.unref?.();
  }
  return h;
}

/** For status displays: the holder and whether its lock is stale. */
export function lockStatus(file, { staleMs = STALE_MS, now = Date.now() } = {}) {
  if (!existsSync(file)) return { held: false };
  const l = readLock(file);
  return { held: true, stale: !l || l.corrupt || ageMs(l, now) >= staleMs, holder: l };
}
