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
 *   app-home   its App Homes (D65, stream H), recursively to the app uid, 0700.
 * Modes are left as they are: the instance dir is mounted only into its own
 * container, and a capability-less root in `aura jump` (5-apps) still reads it.
 *
 * Only what the app's previous identity owns changes (`from`, default root):
 * an entry owned by anyone else (a sidecar's uid, the owner) keeps its owner,
 * and a group other than the previous identity's group is kept. So the same
 * rows run both ways (owner decision 5-main, run-as reversible:
 * identity/runAsOwnership.ts): root -> app, and app -> root. Another app's
 * files bound under `<instance>/.mnt` (MountManager) are never walked.
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
  closeSync, constants, fchmodSync, fchownSync, fstatSync, lchownSync, lstatSync, mkdirSync, openSync, readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import type { OwnershipRowSpec } from './ownershipReport.js';
import type { LinuxIdentity } from './types.js';

export type AppOwnershipKind = 'app-data' | 'dev-cache' | 'app-home';

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
  /**
   * The identity the app ran as: only its entries change. Default root (a
   * `runAs: app` start; the flip to app). The flip back to root passes the
   * app identity with `identity` root.
   */
  from?: LinuxIdentity;
  /**
   * The installation's App Homes (D65, stream H): `apphomes/<installationId>/…`,
   * recursively to the app uid. A home created while the app ran as root is
   * handed over at its first `runAs: app` start; one created afterwards is
   * born app-owned (homes/HomeResolver.ts).
   */
  appHomes?: readonly string[];
}

/**
 * Never walked inside an instance directory: MountManager's legacy mount root
 * (`MOUNT_DIR_NAME`), where other apps' files are bound in.
 */
export const APP_DATA_EXCLUDE = ['.mnt'] as const;

/** The dev-server caches of an Astro app, relative to its source dir. */
export const DEV_CACHE_DIRS = ['.astro', 'node_modules/.vite', 'node_modules/.vite-temp', 'node_modules/.astro'] as const;

/**
 * Never handed to the owner with a source tree (the Developer Mode tree,
 * an open app's own source): the builder's `node_modules` and the dev caches
 * (DEV_CACHE_DIRS: `.astro`, the rest lies in node_modules). A cache handed
 * to the owner is no longer root's, so the dev-cache rows (only from root)
 * skip it, and an app running as its own uid can't write it (console:
 * EACCES on `.astro/types.d.ts`).
 */
export const SOURCE_TREE_EXCLUDE = ['node_modules', '.astro'] as const;

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
  const onlyFrom = input.from ? { uid: input.from.uid, gid: input.from.gid } : { uid: 0, gid: 0 };
  const owner = input.installationId ?? input.appId;
  const note = !to ? 'app identity not allocated yet (allocated at the first runAs: app start)'
    : to.uid === 0 ? 'with the flip back to root (aura admin apps run-as <app> root)'
      : 'with the flip to app (aura admin apps run-as <app> app), and at each start with runAs: app (P5-3)';
  const re = instanceDirRe(input.appId);
  const dirs = (input.instanceDirs ?? existingInstanceDirs(input.appDataRoot, input.appId)).filter((d) => re.test(d));
  const rows: Array<OwnershipRowSpec & { kind: AppOwnershipKind }> = dirs.map((d) => ({
    section: 'plannedAppPaths' as const, path: join(input.appDataRoot, d), kind: 'app-data' as const, owner, to, onlyFrom,
    recursive: true, exclude: [...APP_DATA_EXCLUDE], note,
  }));
  for (const home of [...(input.appHomes ?? [])].sort()) {
    // 0700 when handed to the app; back to root, its mode stays as it is.
    rows.push({ section: 'plannedAppPaths', path: home, kind: 'app-home', owner, to, onlyFrom, recursive: true, ...(to?.uid === 0 ? {} : { mode: '0700' }), note });
  }
  if (input.devServed) {
    for (const rel of DEV_CACHE_DIRS) {
      rows.push({ section: 'plannedAppPaths', path: join(input.appDir, rel), kind: 'dev-cache', owner, to, onlyFrom, recursive: true, note });
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
      // An App Home is only ever created by the Home Resolver (with its root-owned parents).
      if (row.kind === 'app-home') { out.skipped.push(`${row.path}: no such App Home`); continue; }
      try { mkdirSync(row.path, { mode: row.kind === 'dev-cache' ? 0o700 : 0o755 }); out.created.push(row.path); st = lstatSync(row.path); }
      catch (err) { out.skipped.push(`${row.path}: cannot create (${(err as NodeJS.ErrnoException).code ?? 'error'})`); continue; }
    }
    if (st.isSymbolicLink()) { out.skipped.push(`${row.path}: a symbolic link, never followed`); continue; }
    if (!st.isDirectory()) { out.skipped.push(`${row.path}: not a directory`); continue; }
    const r = chownTree(row.path, target, {
      recursive: row.recursive, ...(row.exclude?.length ? { exclude: new Set(row.exclude) } : {}), ...(row.onlyFrom ? { onlyFrom: row.onlyFrom } : {}),
    });
    out.changed += r.changed;
    out.skipped.push(...r.skipped);
  }
  return out;
}

/** One entry's owner and mode before a change (the ownership journal, P5-2). */
export interface OwnershipJournalEntry { path: string; uid: number; gid: number; mode: number }

export interface ChownTreeOptions {
  recursive: boolean;
  /** Directory names skipped at any depth (e.g. `node_modules`). */
  exclude?: ReadonlySet<string>;
  /** Called before each change with the entry's previous owner and mode. */
  journal?: (e: OwnershipJournalEntry) => void;
  /** The top directory's mode afterwards (e.g. 0o700 for a Private Home). */
  topMode?: number;
  /** `g+rX` on every entry and setgid on directories (own app source, P5-2). */
  groupReadable?: boolean;
  /**
   * Only entries owned by this uid change (left alone otherwise: an owner
   * someone chose on purpose); their group becomes the target's only when it
   * is this gid. The run-as migration (identity/runAsOwnership.ts).
   */
  onlyFrom?: { uid: number; gid: number };
}

/** The owner an entry gets: the target, or (with `onlyFrom`) unchanged when it is not the previous identity's. */
function newOwner(st: { uid: number; gid: number }, t: LinuxIdentity, opts: ChownTreeOptions): { uid: number; gid: number } | null {
  if (!opts.onlyFrom) return { uid: t.uid, gid: t.gid };
  if (st.uid !== opts.onlyFrom.uid) return null;
  return { uid: t.uid, gid: st.gid === opts.onlyFrom.gid ? t.gid : st.gid };
}

export interface ChownTreeResult { changed: number; skipped: string[] }

/**
 * Hands `path` (a real directory) and, when `recursive`, everything under it
 * to `target`. Walks through directory file descriptors
 * (`/proc/self/fd/<fd>/<name>`, `O_NOFOLLOW`), so no path component can be
 * swapped for a symlink between the check and the change; symlinks are never
 * followed (their own owner changes); the walk stays on one filesystem; a
 * regular file with more than one link is skipped and reported. Children
 * first: nothing is handed over before its contents are done.
 */
export function chownTree(path: string, target: LinuxIdentity, opts: ChownTreeOptions): ChownTreeResult {
  const out: ChownTreeResult = { changed: 0, skipped: [] };
  let fd: number;
  try { fd = openSync(path, DIR_FLAGS); } catch (err) { out.skipped.push(`${path}: cannot open (${(err as NodeJS.ErrnoException).code ?? 'error'})`); return out; }
  try {
    const dev = fstatSync(fd).dev;
    if (opts.recursive) walk(fd, path, dev, target, opts, out, 0);
    changeFd(fd, path, target, opts, true, out);
    if (opts.topMode !== undefined) {
      const st = fstatSync(fd);
      // Only a top directory that is now the target's (with `onlyFrom`, one left alone keeps its mode too).
      if ((st.mode & 0o7777) !== opts.topMode && st.uid === target.uid) {
        opts.journal?.({ path, uid: st.uid, gid: st.gid, mode: st.mode & 0o7777 });
        fchmodSync(fd, opts.topMode);
      }
    }
  } finally { closeSync(fd); }
  return out;
}

function wantedMode(mode: number, dir: boolean, opts: ChownTreeOptions): number {
  if (!opts.groupReadable) return mode & 0o7777;
  let m = (mode & 0o7777) | 0o040;
  if (dir || (mode & 0o100)) m |= 0o010;
  if (dir) m |= 0o2000;
  return m;
}

function changeFd(fd: number, shown: string, t: LinuxIdentity, opts: ChownTreeOptions, dir: boolean, out: ChownTreeResult): void {
  const st = fstatSync(fd);
  const to = newOwner(st, t, opts);
  if (!to) return;
  const mode = wantedMode(st.mode, dir, opts);
  const owner = st.uid !== to.uid || st.gid !== to.gid;
  if (!owner && mode === (st.mode & 0o7777)) return;
  opts.journal?.({ path: shown, uid: st.uid, gid: st.gid, mode: st.mode & 0o7777 });
  if (owner) fchownSync(fd, to.uid, to.gid);
  // chown clears setgid on some filesystems: set the mode after it.
  if (opts.groupReadable) fchmodSync(fd, mode);
  out.changed++;
}

function walk(dirFd: number, shown: string, dev: number, t: LinuxIdentity, opts: ChownTreeOptions, out: ChownTreeResult, depth: number): void {
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
      if (opts.exclude?.has(name)) continue;
      let fd: number;
      try { fd = openSync(p, DIR_FLAGS); } catch { out.skipped.push(`${join(shown, name)}: changed while walking`); continue; }
      try {
        walk(fd, join(shown, name), dev, t, opts, out, depth + 1);
        changeFd(fd, join(shown, name), t, opts, true, out);
      } finally { closeSync(fd); }
      continue;
    }
    const to = newOwner(st, t, opts);
    if (!to) continue;
    if (st.isFile() && st.nlink > 1) {
      if (st.uid !== to.uid || st.gid !== to.gid) out.skipped.push(`${join(shown, name)}: a file with ${st.nlink} links, left as it is`);
      continue;
    }
    if (st.isFile() || st.isSymbolicLink() || !opts.groupReadable) {
      const mode = st.isSymbolicLink() ? st.mode & 0o7777 : wantedMode(st.mode, false, opts);
      const owner = st.uid !== to.uid || st.gid !== to.gid;
      if (!owner && mode === (st.mode & 0o7777)) continue;
      if (st.isFile()) {
        // Through an O_NOFOLLOW descriptor: the entry can't be swapped for a link meanwhile.
        let f: number;
        try { f = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { out.skipped.push(`${join(shown, name)}: changed while walking`); continue; }
        try {
          const fst = fstatSync(f);
          if (!fst.isFile() || fst.nlink > 1) { out.skipped.push(`${join(shown, name)}: changed while walking`); continue; }
          changeFd(f, join(shown, name), t, opts, false, out);
        } finally { closeSync(f); }
        continue;
      }
      // lchown: a symlink's own owner, never its target.
      opts.journal?.({ path: join(shown, name), uid: st.uid, gid: st.gid, mode: st.mode & 0o7777 });
      try { lchownSync(p, to.uid, to.gid); out.changed++; } catch { out.skipped.push(`${join(shown, name)}: cannot change its owner`); }
    }
  }
}
