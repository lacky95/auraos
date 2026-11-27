/**
 * The kernel's view of a release activation (Phase 6 stream U): the few reads
 * the shell and the updater need while a release job runs. The activation
 * itself is os/release/activate.mjs (dependency-free, run by the detached
 * updater from the running release's tree, and imported by the shell's
 * release routes for the preflight and the status); this file only reads the
 * same files, with the same rules:
 *
 *   aura/release/lock          held while a build or an activation runs: a
 *                              holder with a heartbeat younger than
 *                              RELEASE_LOCK_STALE_MS (= lock.mjs STALE_MS)
 *   aura/boot/writes-held      the release is verifying: the kernel boots
 *                              with `acceptingWrites: false` and the
 *                              middleware answers mutating calls 503
 *   aura/release/snapshots/    the data snapshot of the switch INTO a
 *                              release (a data restore takes only that one)
 *
 * `test/release-activate.test.mjs` compares the constants with the .mjs side.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { layout } from './paths.js';

/** lock.mjs STALE_MS: a holder without a heartbeat for this long is gone (the updater container died). */
export const RELEASE_LOCK_STALE_MS = 5 * 60_000;

/** The holder of the `system` activation lock (lock.mjs / core release/lock.ts format, plus `heartbeatAt`). */
export interface ReleaseLockHolder {
  jobId: string;
  pid: number;
  host: string;
  start: string | null;
  at: number;
  by?: string;
  heartbeatAt?: number;
}

/** `aura/boot/writes-held` (activate.mjs `holdWrites`). */
export interface WritesHeldMarker {
  v: 1;
  jobId: string | null;
  from: string | null;
  to: string | null;
  snapshot: string | null;
  at: string | null;
  /** The marker exists but cannot be read: still held (fails closed). */
  unreadable?: true;
}

function readJson<T>(file: string): T | null {
  try { return JSON.parse(readFileSync(file, 'utf8')) as T; } catch { return null; }
}

/** The live holder of the system lock, or null (none, or its heartbeat is stale). */
export function systemLockHolder(dataDir: string, now: number = Date.now()): ReleaseLockHolder | null {
  const h = readJson<ReleaseLockHolder>(layout(dataDir).lock);
  if (!h || typeof h.jobId !== 'string') return null;
  return now - (h.heartbeatAt ?? h.at ?? 0) >= RELEASE_LOCK_STALE_MS ? null : h;
}

/** The writes-held marker, or null when the kernel accepts writes. An unreadable marker still holds. */
export function readWritesHeld(dataDir: string): WritesHeldMarker | null {
  const file = layout(dataDir).writesHeld;
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { return null; }
  try { return JSON.parse(text) as WritesHeldMarker; } catch {
    return { v: 1, jobId: null, from: null, to: null, snapshot: null, at: null, unreadable: true };
  }
}

/**
 * The snapshot taken by the switch INTO `release` (its `toRelease`, and the
 * job that switched the pointer when known): the only one a rollback of that
 * release may restore (Q35: never data from across two updates).
 */
export function latestSnapshotInto(dataDir: string, release: string, jobId?: string | null): string | null {
  const dir = layout(dataDir).snapshots;
  let names: string[] = [];
  try { names = readdirSync(dir).filter((n) => !n.endsWith('.tmp')).sort().reverse(); } catch { return null; }
  for (const n of names) {
    const r = readJson<{ id?: string; toRelease?: string; jobId?: string }>(join(dir, n, 'snapshot.json'));
    if (r?.id !== n || r.toRelease !== release) continue;
    if (jobId && r.jobId !== jobId) continue;
    return n;
  }
  return null;
}
