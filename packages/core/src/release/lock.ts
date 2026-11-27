/**
 * The activation lock (Q23 "serialized activation", D68): one activation per
 * target at a time, across processes and shell restarts. Targets are
 * `app:<scope>:<appId>` (every install, update, patch activation and rollback
 * of one app installation; Phase 7a) and `system` (release updates and system
 * patch activations; Phase 6 U / 7b take the same helper).
 *
 * A lock is a file created with link(2) (atomic, never half-written) holding
 * `{jobId, pid, host, start, at, by}`. A holder on this host whose process is
 * gone (or whose pid now belongs to another process: `start` differs) is
 * stale and is taken over; a holder elsewhere (an updater container) is
 * stale only when the caller's `isStale` says so. Callers release in a
 * `finally` around a section that does not suspend on an outside answer.
 *
 * A leaf: no core module imports.
 */
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { linkSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type ActivationTarget = 'system' | `app:${'global' | 'user'}:${string}`;

export interface ActivationHolder {
  jobId: string;
  pid: number;
  host: string;
  /** The holder process's start (Linux /proc starttime ticks), to tell pid reuse. */
  start: string | null;
  at: number;
  /** What the job is, for messages ("app.patch.activate", "nexus.update"). */
  by?: string;
}

export const ACTIVATION_BUSY = 'activation-busy';

/** Another activation of the target is running. */
export class ActivationBusyError extends Error {
  readonly code = ACTIVATION_BUSY;
  constructor(readonly target: ActivationTarget, readonly heldBy: ActivationHolder) {
    super(`${ACTIVATION_BUSY}: ${target} is being changed by another activation (${heldBy.by ?? 'job'} ${heldBy.jobId}, since ${new Date(heldBy.at).toISOString()})`);
  }
}

const APP_TARGET = /^app:(global|user):[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;

export const appActivationTarget = (scope: 'global' | 'user', appId: string): ActivationTarget => `app:${scope}:${appId}`;

/** Where a target's lock lives: Phase 6's release lock for `system`, `aura/locks/` for the rest. */
export function activationLockPath(dataDir: string, target: ActivationTarget): string {
  if (target === 'system') return join(dataDir, 'aura', 'release', 'lock');
  if (!APP_TARGET.test(target)) throw new Error(`invalid activation target: ${JSON.stringify(target)}`);
  return join(dataDir, 'aura', 'locks', `${target}.lock`);
}

function procStart(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // Field 22 (starttime), counted after the parenthesised comm, which may hold spaces.
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch { return null; }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
}

function readHolder(path: string): ActivationHolder | null {
  try { return JSON.parse(readFileSync(path, 'utf8')) as ActivationHolder; } catch { return null; }
}

/** A holder on this host whose process is gone or was replaced. */
function staleHere(h: ActivationHolder): boolean {
  if (h.host !== hostname()) return false;
  if (!alive(h.pid)) return true;
  const now = procStart(h.pid);
  return h.start !== null && now !== null && now !== h.start;
}

export interface ActivationLock {
  readonly target: ActivationTarget;
  readonly holder: ActivationHolder;
  /** Idempotent; only removes the lock while it is still this job's. */
  release(): void;
}

/**
 * Take the lock of `target` or throw ActivationBusyError. `isStale` judges a
 * holder this host cannot (another host or container).
 */
export function acquireActivation(
  dataDir: string, target: ActivationTarget, job: { jobId?: string; by?: string } = {},
  opts: { isStale?: (h: ActivationHolder) => boolean } = {},
): ActivationLock {
  const path = activationLockPath(dataDir, target);
  mkdirSync(join(path, '..'), { recursive: true });
  const holder: ActivationHolder = {
    jobId: job.jobId ?? randomUUID(), pid: process.pid, host: hostname(), start: procStart(process.pid), at: Date.now(),
    ...(job.by ? { by: job.by } : {}),
  };
  const tmp = `${path}.${holder.jobId}.tmp`;
  writeFileSync(tmp, JSON.stringify(holder), { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        linkSync(tmp, path);
        let released = false;
        return {
          target, holder,
          release: () => {
            if (released) return;
            released = true;
            if (readHolder(path)?.jobId === holder.jobId) { try { unlinkSync(path); } catch { /* gone */ } }
          },
        };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      const current = readHolder(path);
      // An unreadable lock was being written by nobody (link is atomic): treat as stale.
      if (current && !staleHere(current) && !opts.isStale?.(current)) throw new ActivationBusyError(target, current);
      try { renameSync(path, `${path}.stale.${Date.now()}`); } catch { /* someone else took it over */ }
    }
    const current = readHolder(path);
    throw new ActivationBusyError(target, current ?? { jobId: 'unknown', pid: 0, host: '', start: null, at: Date.now() });
  } finally {
    try { unlinkSync(tmp); } catch { /* gone */ }
  }
}

/** The live holder of `target`, or null (stale holders count as free). */
export function activationHolder(dataDir: string, target: ActivationTarget): ActivationHolder | null {
  const h = readHolder(activationLockPath(dataDir, target));
  return h && !staleHere(h) ? h : null;
}

/** Every app target with a live holder (the store's "installing…" view survives a page reload). */
export function heldAppActivations(dataDir: string): Array<{ target: ActivationTarget; appId: string; holder: ActivationHolder }> {
  const dir = join(dataDir, 'aura', 'locks');
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return []; }
  const out: Array<{ target: ActivationTarget; appId: string; holder: ActivationHolder }> = [];
  for (const n of names) {
    if (!n.endsWith('.lock')) continue;
    const target = n.slice(0, -'.lock'.length) as ActivationTarget;
    if (!APP_TARGET.test(target)) continue;
    try { statSync(join(dir, n)); } catch { continue; }
    const holder = activationHolder(dataDir, target);
    if (holder) out.push({ target, appId: target.split(':')[2]!, holder });
  }
  return out;
}
