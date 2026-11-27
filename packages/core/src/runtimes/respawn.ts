/**
 * The kernel's PRoot respawn record (5b RS; D73, D77, D78): instances on a
 * runtime whose workloads end with the kernel (`survivesShellRestart: false`,
 * PRoot) that were running, so the next `AppManager.init()` starts them
 * again. Before 5b the desktop session did this (shell desktopSession.ts),
 * so it needed a browser, a sign-in and the desktop restore; the desktop now
 * keeps windows only and maps old instance ids to new ones through the
 * kernel (`app:respawned`, `AppManager.respawnedInstance`).
 *
 * Kernel-owned state, one small JSON file next to the warm-pool record
 * (`<dataDir>/aura/runtime-respawn.json`), written on every lifecycle change.
 * Keyed by installation and owner (D85 A7, A9): the former instance id is
 * kept only to map a window to its new instance, never as a durable
 * reference. A respawn goes through the normal resolve (overrides honoured,
 * capability-checked, failing closed visibly): no runtime is chosen here.
 *
 * Shutdown: the kernel freezes the record when the shell announces it
 * (`os:shuttingDown`), so processes dying with it do not empty it (a crash
 * before that point is a crash: not respawned, M5). The freeze lapses after
 * `RESPAWN_FREEZE_MS` (a restart that never happened). A shutdown announced
 * with `restore: false` (no restore asked, or the owner's restore setting
 * off) empties the record first: nothing comes back (M5).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Instance states a respawn brings back: running ones, never one that had crashed or stopped (M5). */
export const RESPAWN_STATES: ReadonlySet<string> = new Set(['resumed', 'started', 'paused']);

/** How long a shutdown freeze holds the record when no shutdown follows. */
export const RESPAWN_FREEZE_MS = 5 * 60_000;

export interface RespawnEntry {
  /** The installation it ran for; a reinstalled app (another installation) is not respawned. */
  installationId: string | null;
  appId: string;
  /** The user it was started for (C8); absent: the owner. */
  owner?: string;
  /** The former instance id: only to map its windows to the new instance. */
  formerInstanceId: string;
  state: string;
}

export interface RespawnRecord { v: 1; entries: RespawnEntry[] }

export function respawnFile(dataDir: string): string {
  return join(dataDir, 'aura', 'runtime-respawn.json');
}

/** The record on disk; empty when missing or unreadable (nothing to respawn, never a guess). */
export function readRespawnRecord(dataDir: string): RespawnRecord {
  try {
    const r = JSON.parse(readFileSync(respawnFile(dataDir), 'utf-8')) as Partial<RespawnRecord>;
    if (r?.v !== 1 || !Array.isArray(r.entries)) return { v: 1, entries: [] };
    const entries = r.entries.filter((e): e is RespawnEntry => !!e && typeof e === 'object'
      && typeof e.appId === 'string' && typeof e.formerInstanceId === 'string' && typeof e.state === 'string'
      && (e.installationId === null || typeof e.installationId === 'string')
      && (e.owner === undefined || typeof e.owner === 'string'));
    return { v: 1, entries };
  } catch {
    return { v: 1, entries: [] };
  }
}

/** Writes the record atomically; returns false when it could not (logged by the caller). */
export function writeRespawnRecord(dataDir: string, record: RespawnRecord): boolean {
  const file = respawnFile(dataDir);
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(record));
    renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/** The instance facts the selection needs. */
export interface RespawnCandidate {
  instanceId: string;
  appId: string;
  state: string;
  owner?: string;
  inPool?: boolean;
  preview?: unknown;
  /** Its runtime's `survivesShellRestart`; null: unknown runtime. */
  survives: boolean | null;
  /** Started by the kernel anyway (a service or autoStart app): never respawned twice. */
  startedByKernel: boolean;
}

/** Which instances the record keeps, in a stable order. */
export function respawnEntries(cands: readonly RespawnCandidate[], installationOf: (appId: string) => string | null): RespawnEntry[] {
  return cands
    .filter((c) => c.survives === false && !c.inPool && !c.preview && !c.startedByKernel && RESPAWN_STATES.has(c.state))
    .map((c) => ({
      installationId: installationOf(c.appId), appId: c.appId, formerInstanceId: c.instanceId, state: c.state,
      ...(c.owner ? { owner: c.owner } : {}),
    }))
    .sort((a, b) => a.formerInstanceId.localeCompare(b.formerInstanceId));
}
