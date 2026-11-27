// The `system` activation lock for the release builder (D68; Phase 6 B/U),
// in the ONE lock format of core release/lock.ts (Phase 7a, phase7/a ff298cd):
// same file (`aura/release/lock` = activationLockPath(dataDir, 'system')), same
// holder `{ jobId, pid, host, start, at, by }`, same creation (link(2) of a
// fully written temp file: never half-written), same stale rule for a holder
// on this host (its pid is gone, or now belongs to another process: `start`
// differs), same take-over (rename to `<lock>.stale.<ms>`). This file is the
// dependency-free twin for code that runs before or outside core (install.sh's
// builder runner, the updater container); lock.ts stays the kernel's API.
//
// The one addition: `heartbeatAt` (ms), renewed every HEARTBEAT_MS while a
// build runs. A holder on ANOTHER host (the shell vs. the updater or runner
// container: different PID namespaces) is stale only when its heartbeat is
// older than STALE_MS: `heartbeatStale` is the `isStale` the kernel passes to
// lock.ts's acquireActivation for the `system` target (stream U).
import { linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { fsyncDir, writeJsonDurable } from './durable.mjs';

export const HEARTBEAT_MS = 30_000;
export const STALE_MS = 5 * 60_000;
export const ACTIVATION_BUSY = 'activation-busy';   // lock.ts's error code

export class LockError extends Error {
  constructor(code, message, holder) { super(message); this.code = code; this.holder = holder ?? null; }
}

export function readLock(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function procStart(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch { return null; }
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** lock.ts's rule: a holder on this host whose process is gone or was replaced. */
export function staleHere(h) {
  if (h.host !== hostname()) return false;
  if (!alive(h.pid)) return true;
  const now = procStart(h.pid);
  return h.start != null && now !== null && now !== h.start;
}

/** The cross-host rule for the system target: no heartbeat for STALE_MS (lock.ts `isStale`). */
export const heartbeatStale = (h, now = Date.now(), staleMs = STALE_MS) => now - (h.heartbeatAt ?? h.at ?? 0) >= staleMs;

const isStale = (h, now, staleMs) => !h || staleHere(h) || heartbeatStale(h, now, staleMs);

/**
 * Takes the lock for `jobId` or throws LockError('activation-busy', …) naming the holder.
 * Returns { jobId, file, brokeStale, heartbeat(), release(), owned() }.
 */
export function acquireLock(file, { jobId, by = 'system.release.build', staleMs = STALE_MS, now = () => Date.now(), autoHeartbeat = true } = {}) {
  mkdirSync(dirname(file), { recursive: true });
  const t = now();
  const holder = { jobId, pid: process.pid, host: hostname(), start: procStart(process.pid), at: t, by, heartbeatAt: t };
  const tmp = `${file}.${jobId}.tmp`;
  writeFileSync(tmp, JSON.stringify(holder), { mode: 0o600 });
  let brokeStale = null;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        linkSync(tmp, file);
        fsyncDir(dirname(file));
        return handle(file, holder, brokeStale, now, autoHeartbeat);
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
      const cur = readLock(file);
      if (cur?.jobId === jobId) throw new LockError(ACTIVATION_BUSY, `the activation lock is already held by this job (${jobId})`, cur);
      if (!isStale(cur, now(), staleMs)) {
        throw new LockError(ACTIVATION_BUSY, `${ACTIVATION_BUSY}: another release job holds the activation lock: ${cur.jobId} (${cur.by ?? 'job'}, since ${new Date(cur.at).toISOString()}, last heartbeat ${new Date(cur.heartbeatAt ?? cur.at).toISOString()})`, cur);
      }
      try { renameSync(file, `${file}.stale.${Date.now()}`); fsyncDir(dirname(file)); brokeStale = cur ?? { jobId: null }; } catch { /* someone else took it over */ }
    }
    throw new LockError(ACTIVATION_BUSY, 'the activation lock changed hands while taking it; try again', readLock(file));
  } finally {
    try { unlinkSync(tmp); } catch { /* gone */ }
  }
}

function handle(file, holder, brokeStale, now, autoHeartbeat) {
  let timer = null;
  const owned = () => readLock(file)?.jobId === holder.jobId;
  const h = {
    jobId: holder.jobId,
    file,
    holder,
    brokeStale,
    owned,
    heartbeat() {
      if (!owned()) throw new LockError('lost', `the activation lock of ${holder.jobId} was taken over (stale heartbeat)`);
      writeJsonDurable(file, { ...holder, heartbeatAt: now() }, { mode: 0o600 });
    },
    release() {
      if (timer) { clearInterval(timer); timer = null; }
      if (!owned()) return false;
      try { unlinkSync(file); fsyncDir(dirname(file)); } catch { /* gone */ }
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
  return { held: true, stale: isStale(l, now, staleMs), holder: l };
}
