/**
 * The per-installation ownership rows of a non-root app (P5-3, stream A).
 *
 * One table, two users: the dry-run ownership report lists exactly these rows
 * under `plannedAppPaths`, and the shell applies exactly these rows, lazily,
 * when it spawns an instance with `runAs: app`. Never a blanket chown (D70).
 *
 * The layout decision (stream I's finding: installed apps keep instance data
 * inside their source dir, `<scope>/apps/<appId>/<appId>[-N]`): nothing moves.
 *   app-data   each instance directory, recursively, to the app uid. It is
 *              mounted alone at `/data`; the source tree around it stays
 *              root-owned, so a closed source is never made writable.
 *   dev-cache  for an Astro app served in dev (`astro dev`): `.astro/` and
 *              `node_modules/{.vite,.vite-temp,.astro}`, created if missing, to
 *              the app uid. Caches, not source; the builder writes everything
 *              else (`node_modules`, `dist`) as root.
 * Modes are left as they are: the instance dir is mounted only into its own
 * container, and a capability-less root in `aura jump` (5-apps) still reads it.
 *
 * Apply walks each row through directory file descriptors
 * (`/proc/self/fd/<fd>/<name>`, `O_NOFOLLOW`): a path component can't be
 * swapped for a symlink between the check and the chown, so a process of the
 * app can't steer the shell's chown outside the row. Symlinks are never
 * followed (their own owner changes), the walk stays on the row's filesystem,
 * and a regular file with more than one link is skipped and reported (a hard
 * link made while the app ran as root must not hand it another file).
 */
import {
  closeSync, constants, fchownSync, fstatSync, lchownSync, lstatSync, mkdirSync, openSync, readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import type { OwnershipRowSpec } from './ownershipReport.js';
import type { LinuxIdentity } from './types.js';

export type AppOwnershipKind = 'app-data' | 'dev-cache';

export interface AppOwnershipInput {
  appId: string;
  /** The row owner shown in the report; null before the installation is recorded. */
  installationId: string | null;
  /** `<scope data>/apps/<appId>`: where the instance directories are. */
  appDataRoot: string;
  /** The instance directory names (`<appId>`, `<appId>-2`); default: every one that exists. */
  instanceDirs?: readonly string[];
  /** The app's source dir (dev-cache rows). */
  appDir: string;
  /** An Astro app served by `astro dev` gets the dev-cache rows. */
  devServed: boolean;
  /** The target; null while the identity is not allocated (shown, never applicable). */
  identity: LinuxIdentity | null;
}

/** The dev-server caches of an Astro app, relative to its source dir. */
export const DEV_CACHE_DIRS = ['.astro', 'node_modules/.vite', 'node_modules/.vite-temp', 'node_modules/.astro'] as const;

function instanceDirRe(appId: string): RegExp {
  return new RegExp(`^${appId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(-\\d+)?$`);
}

/** The instance directories that exist under `appDataRoot` (sorted). */
export function existingInstanceDirs(appDataRoot: string, appId: string): string[] {
  const re = instanceDirRe(appId);
  try {
    return readdirSync(appDataRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && re.test(d.name)).map((d) => d.name).sort();
  } catch { return []; }
}

/** The rows of one installation, as the report and the spawn prep both read them. */
export function appOwnershipSpecs(input: AppOwnershipInput): Array<OwnershipRowSpec & { kind: AppOwnershipKind }> {
  const to = input.identity ? { uid: input.identity.uid, gid: input.identity.gid } : null;
  const owner = input.installationId ?? input.appId;
  const note = to ? 'applied at each start with runAs: app (P5-3)' : 'app identity not allocated yet (allocated at the first runAs: app start)';
  const re = instanceDirRe(input.appId);
  const dirs = (input.instanceDirs ?? existingInstanceDirs(input.appDataRoot, input.appId)).filter((d) => re.test(d));
  const rows: Array<OwnershipRowSpec & { kind: AppOwnershipKind }> = dirs.map((d) => ({
    section: 'plannedAppPaths' as const, path: join(input.appDataRoot, d), kind: 'app-data' as const, owner, to, recursive: true, note,
  }));
  if (input.devServed) {
    for (const rel of DEV_CACHE_DIRS) {
      rows.push({ section: 'plannedAppPaths', path: join(input.appDir, rel), kind: 'dev-cache', owner, to, recursive: true, note });
    }
  }
  return rows;
}

export interface AppOwnershipResult {
  /** Entries whose owner changed. */
  changed: number;
  /** Directories created (dev caches). */
  created: string[];
  /** What was left alone, by path (never file contents). */
  skipped: string[];
}

const DIR_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const MAX_DEPTH = 64;

/**
 * Applies `rows` (from `appOwnershipSpecs`) for `target`. Root only (the
 * shell). Idempotent: only entries owned by someone else change. Creates a
 * missing dev-cache directory (its parent must exist) and a missing instance
 * directory, never anything above them.
 */
export function applyAppOwnership(rows: readonly OwnershipRowSpec[], target: LinuxIdentity): AppOwnershipResult {
  if (!Number.isSafeInteger(target.uid) || target.uid <= 0 || !Number.isSafeInteger(target.gid) || target.gid <= 0) {
    throw new Error('app ownership needs a non-root target');
  }
  const out: AppOwnershipResult = { changed: 0, created: [], skipped: [] };
  for (const row of rows) {
    if (row.section !== 'plannedAppPaths') continue;
    if (!row.to || row.to.uid !== target.uid || row.to.gid !== target.gid) { out.skipped.push(`${row.path}: row is for another identity`); continue; }
    let st;
    try { st = lstatSync(row.path); } catch {
      try { mkdirSync(row.path, { mode: row.kind === 'dev-cache' ? 0o700 : 0o755 }); out.created.push(row.path); st = lstatSync(row.path); }
      catch (err) { out.skipped.push(`${row.path}: cannot create (${(err as NodeJS.ErrnoException).code ?? 'error'})`); continue; }
    }
    if (st.isSymbolicLink()) { out.skipped.push(`${row.path}: a symbolic link, never followed`); continue; }
    if (!st.isDirectory()) { out.skipped.push(`${row.path}: not a directory`); continue; }
    let fd: number;
    try { fd = openSync(row.path, DIR_FLAGS); } catch (err) { out.skipped.push(`${row.path}: cannot open (${(err as NodeJS.ErrnoException).code ?? 'error'})`); continue; }
    try {
      const dev = fstatSync(fd).dev;
      if (row.recursive) walk(fd, row.path, dev, target, out, 0);
      chownFd(fd, target, out);
    } finally { closeSync(fd); }
  }
  return out;
}

function chownFd(fd: number, t: LinuxIdentity, out: AppOwnershipResult): void {
  const st = fstatSync(fd);
  if (st.uid !== t.uid || st.gid !== t.gid) { fchownSync(fd, t.uid, t.gid); out.changed++; }
}

/** Children first, the directory itself last (by its caller): nothing is handed over before its contents are done. */
function walk(dirFd: number, shown: string, dev: number, t: LinuxIdentity, out: AppOwnershipResult, depth: number): void {
  if (depth >= MAX_DEPTH) { out.skipped.push(`${shown}: deeper than ${MAX_DEPTH} levels`); return; }
  const base = `/proc/self/fd/${dirFd}`;
  let names: string[];
  try { names = readdirSync(base); } catch { out.skipped.push(`${shown}: cannot list`); return; }
  for (const name of names) {
    const p = `${base}/${name}`;
    let st;
    try { st = lstatSync(p); } catch { continue; }
    if (st.dev !== dev) { out.skipped.push(`${join(shown, name)}: another filesystem`); continue; }
    if (st.isDirectory()) {
      let fd: number;
      try { fd = openSync(p, DIR_FLAGS); } catch { out.skipped.push(`${join(shown, name)}: changed while walking`); continue; }
      try {
        walk(fd, join(shown, name), dev, t, out, depth + 1);
        chownFd(fd, t, out);
      } finally { closeSync(fd); }
      continue;
    }
    if (st.uid === t.uid && st.gid === t.gid) continue;
    if (st.isFile() && st.nlink > 1) { out.skipped.push(`${join(shown, name)}: a file with ${st.nlink} links, left as it is`); continue; }
    // lchown: a symlink's own owner, never its target.
    try { lchownSync(p, t.uid, t.gid); out.changed++; } catch { out.skipped.push(`${join(shown, name)}: cannot change its owner`); }
  }
}
