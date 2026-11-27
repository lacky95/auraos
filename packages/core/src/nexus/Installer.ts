/**
 * Nexus installer. Takes a validated staging dir + the manifest pulled
 * from it, atomically lands the source at `apps/<id>/`, writes the
 * install record at `data/nexus/installed/<id>.json`, and lets the
 * AppRegistry's chokidar watcher pick up the new app.
 *
 * Atomicity and durability (Phase 7a, Q23, owner decision 1): the staged
 * tree moves to `apps/<id>.tmp.<ts>/` and is synced to disk; the app's
 * runtime data moves into it; then ONE `renameat2(RENAME_EXCHANGE)` swaps
 * it with `apps/<id>/` (the `aura-rename-exchange` helper, which also syncs
 * both parents); the old tree goes to trash. Every step is recorded first in
 * a journal (`data/nexus/journal/<id>.json`, synced), and `reconcile()` at
 * boot finishes or undoes an interrupted install: `apps/<id>` is always the
 * complete old tree (data back in place) or the complete new one (record
 * written). A filesystem that cannot exchange refuses installs (fail closed,
 * no two-rename fallback).
 *
 * The installer DOES NOT call into AppRegistry directly; the chokidar
 * watcher does that on its own when the new directory appears.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  closeSync, cpSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync,
  renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { AppManifest } from '../types/manifest.js';
import type { InstallRecord, ResolvedRef } from './types.js';
import type { ScopeId } from '../scopes/types.js';
import { APP_ID_PATTERN, isOriginId, readOriginId } from '../app-manager/AppIdentity.js';
import { readPublishMarker, type AppSourceInfo, type SourceMode } from './AppSource.js';
import type { FaultPoint } from '../release/faults.js';

/** The helper as the image builds it (Dockerfile, os/rename-exchange). */
export const RENAME_EXCHANGE_IMAGE_PATH = '/os/rename-exchange/aura-rename-exchange';
/** The helper's exit status for "this filesystem cannot do it". */
const EXCHANGE_UNSUPPORTED = 3;
export const INSTALL_NOT_ATOMIC = 'install-not-atomic';

/** Installs refused: the apps dir cannot be switched atomically. */
export class InstallAtomicityError extends Error {
  readonly code = INSTALL_NOT_ATOMIC;
}

export interface InstallerOpts {
  appsDir: string;
  dataDir: string;
  scope:   ScopeId;
  /** The exchange helper (default: the image's). Tests pass a built copy. */
  exchangeHelper?: string;
  /** Crash points (release/faults.ts); tests and the e2e VM only. */
  fault?: (point: FaultPoint) => void;
}

/** One install in flight, as the journal records it before each step. */
interface InstallJournal {
  v: 1;
  appId: string;
  phase: 'staging' | 'carry' | 'exchange' | 'switched';
  tmp: string;
  target: string;
  trash: string;
  /** apps/<id> existed (an update): the switch is an exchange, not a rename. */
  hadTarget: boolean;
  /** Runtime data entries moved from the old tree into tmp. */
  carried: string[];
  /** The inode of the new tree: after a crash, apps/<id> has it iff the switch happened. */
  newIno?: number;
  record?: InstallRecord;
  recordPath: string;
}

export class Installer {
  constructor(private opts: InstallerOpts) {}

  get appsDir(): string { return this.opts.appsDir; }

  /**
   * Move a validated staging dir into `apps/<id>/`, writing the install
   * record. If `apps/<id>/` already exists (update path), its runtime data
   * moves into the new copy (`carryOverRuntimeData`) and the rest of the old
   * dir is moved aside to `data/nexus/trash/<id>-<ts>/` so an undo window
   * exists.
   */
  async install(
    stagingDir: string, manifest: AppManifest, resolved: ResolvedRef,
    link: { remoteId?: string; detached?: boolean } = {},
    opts: { keepProvenance?: boolean; extra?: Pick<InstallRecord, 'patched'> } = {},
  ): Promise<InstallRecord> {
    this.assertAtomic();
    // Read before anything moves: the record this install replaces.
    const previous = this.getRecord(manifest.id);
    const targetDir = join(this.opts.appsDir, manifest.id);
    const ts = Date.now();
    const tmpDir = `${targetDir}.tmp.${ts}`;

    // Never replace a DIFFERENT app: the caller (NexusManager's identity
    // check) only gets here for the same artifact or an explicit choice, so
    // two different originIds under one id is a bug, not a decision.
    const have = readOriginId(join(targetDir, 'app.manifest.json'));
    if (have && manifest.originId && have !== manifest.originId) {
      throw new Error(`refusing to replace ${manifest.id}: it is a different app (originId ${have}, incoming ${manifest.originId})`);
    }
    const j: InstallJournal = {
      v: 1, appId: manifest.id, phase: 'staging', tmp: tmpDir, target: targetDir,
      trash: join(this.opts.dataDir, 'nexus', 'trash', `${manifest.id}-${ts}`),
      hadTarget: existsSync(targetDir), carried: [],
      recordPath: join(this.opts.dataDir, 'nexus', 'installed', `${manifest.id}.json`),
    };
    this.writeJournal(j);

    // 1. Staging → tmp (off the watched glob: `.tmp.*` is no app id), synced.
    mkdirSync(dirname(tmpDir), { recursive: true });
    moveOrSync(stagingDir, tmpDir);
    this.syncfs(tmpDir);
    this.opts.fault?.('installer:after-stage');

    // 2. An update must not wipe the user's data: in the global and user
    //    scopes it lives inside the app dir that is being replaced. Moved
    //    (journaled first) into the new tree; reconcile() moves it back.
    if (j.hadTarget) {
      j.phase = 'carry';
      j.carried = runtimeDataEntries(targetDir, manifest.id);
      this.writeJournal(j);
      carryOverRuntimeData(targetDir, tmpDir, manifest.id);
      fsyncDir(targetDir); fsyncDir(tmpDir);
      this.opts.fault?.('installer:after-carry');
    }

    // 3. The record the switch makes true, journaled with the switch.
    let record = buildInstallRecord(manifest, resolved, ts, this.opts.scope, link, upstreamOf(tmpDir, manifest));
    // A patched tree (Track P) is still the release it was built from: keep
    // where that came from, so the store still knows its source and updates.
    if (opts.keepProvenance && previous) {
      const { id, version, updatedAt } = record;
      record = { ...previous, id, version, updatedAt, scope: this.opts.scope };
    }
    // The owner's source-mode choice belongs to the installation, not the release.
    if (previous?.sourceMode) record.sourceMode = previous.sourceMode;
    // What a patched tree was built from (D68 reproducibility): only this install's, never carried over.
    delete record.patched;
    if (opts.extra?.patched) record.patched = opts.extra.patched;
    j.phase = 'exchange';
    j.newIno = statSync(tmpDir).ino;
    j.record = record;
    this.writeJournal(j);

    // 4. The switch: one atomic exchange (an update) or rename (a new app).
    //    This is the chokidar trigger point.
    this.exchange(tmpDir, targetDir, j.hadTarget);
    this.opts.fault?.('installer:after-exchange');
    j.phase = 'switched';
    this.writeJournal(j);

    // 5. Record, old tree to trash, journal gone.
    this.finish(j);
    return record;
  }

  // ── atomic switch: helper, journal, recovery ──────────────────────────────

  private probed: { ok: boolean; reason?: string } | null = null;

  /**
   * Whether installs can switch atomically here: the helper exists and the
   * apps dir's filesystem does RENAME_EXCHANGE. Probed once per installer.
   */
  probeAtomic(): { ok: boolean; reason?: string } {
    if (this.probed) return this.probed;
    const helper = this.opts.exchangeHelper ?? RENAME_EXCHANGE_IMAGE_PATH;
    mkdirSync(this.opts.appsDir, { recursive: true });
    const r = spawnSync(helper, ['probe', this.opts.appsDir], { encoding: 'utf8', timeout: 10_000 });
    if (r.error) {
      this.probed = { ok: false, reason: `the exchange helper ${helper} is missing (${(r.error as NodeJS.ErrnoException).code ?? r.error.message}): rebuild the AuraOS image` };
    } else if (r.status === EXCHANGE_UNSUPPORTED) {
      this.probed = { ok: false, reason: `the filesystem of ${this.opts.appsDir} does not support an atomic exchange (renameat2 RENAME_EXCHANGE): use ext4, xfs, btrfs or tmpfs` };
    } else if (r.status !== 0) {
      this.probed = { ok: false, reason: `the exchange probe on ${this.opts.appsDir} failed: ${(r.stderr || '').trim() || `exit ${String(r.status)}`}` };
    } else {
      this.probed = { ok: true };
    }
    return this.probed;
  }

  private assertAtomic(): void {
    const p = this.probeAtomic();
    if (!p.ok) throw new InstallAtomicityError(`${INSTALL_NOT_ATOMIC}: installs are refused: ${p.reason}`);
  }

  private helper(args: string[]): void {
    const helper = this.opts.exchangeHelper ?? RENAME_EXCHANGE_IMAGE_PATH;
    const r = spawnSync(helper, args, { encoding: 'utf8', timeout: 120_000 });
    if (r.error || r.status !== 0) {
      const why = r.error ? r.error.message : (r.stderr || '').trim() || `exit ${String(r.status)}`;
      throw r.status === EXCHANGE_UNSUPPORTED ? new InstallAtomicityError(`${INSTALL_NOT_ATOMIC}: ${why}`) : new Error(`${args[0]} failed: ${why}`);
    }
  }

  private exchange(tmp: string, target: string, hadTarget: boolean): void {
    this.helper([hadTarget ? 'exchange' : 'rename', tmp, target]);
  }

  /** Everything written under `dir`, durable (syncfs of its filesystem). */
  private syncfs(dir: string): void { this.helper(['syncfs', dir]); }

  private journalDir(): string { return join(this.opts.dataDir, 'nexus', 'journal'); }

  private writeJournal(j: InstallJournal): void {
    mkdirSync(this.journalDir(), { recursive: true });
    writeDurable(join(this.journalDir(), `${j.appId}.json`), JSON.stringify(j, null, 2));
  }

  private dropJournal(appId: string): void {
    try { unlinkSync(join(this.journalDir(), `${appId}.json`)); } catch { /* gone */ }
    fsyncDir(this.journalDir());
  }

  /** After the switch: the record, the old tree to trash, the journal removed. */
  private finish(j: InstallJournal): void {
    mkdirSync(dirname(j.recordPath), { recursive: true });
    if (j.record) writeDurable(j.recordPath, JSON.stringify(j.record, null, 2));
    this.opts.fault?.('installer:after-record');
    if (j.hadTarget && existsSync(j.tmp)) {
      if (readdirSafe(j.tmp).length === 0) {
        // Only data was left (an uninstall keeps it): nothing to keep in trash.
        rmSync(j.tmp, { recursive: true, force: true });
      } else {
        mkdirSync(dirname(j.trash), { recursive: true });
        moveOrCopy(j.tmp, j.trash);
        fsyncDir(dirname(j.trash));
      }
      fsyncDir(dirname(j.tmp));
    }
    this.dropJournal(j.appId);
  }

  /**
   * Boot recovery: finish or undo every install a crash interrupted. Before
   * the switch: the carried data goes back into apps/<id> and the new tree
   * is deleted (the old app, complete). After it: the record is written and
   * the old tree goes to trash (the new app, complete). Never throws for one
   * journal; returns what happened to each.
   */
  reconcile(): Array<{ appId: string; outcome: 'undone' | 'completed' | 'failed'; detail?: string }> {
    const out: Array<{ appId: string; outcome: 'undone' | 'completed' | 'failed'; detail?: string }> = [];
    for (const name of readdirSafe(this.journalDir())) {
      if (!name.endsWith('.json')) continue;
      let j: InstallJournal;
      try { j = JSON.parse(readFileSync(join(this.journalDir(), name), 'utf8')) as InstallJournal; }
      catch (err) { out.push({ appId: basename(name, '.json'), outcome: 'failed', detail: `unreadable journal: ${(err as Error).message}` }); continue; }
      try {
        if (!APP_ID_PATTERN.test(j.appId) || j.target !== join(this.opts.appsDir, j.appId) || dirname(j.tmp) !== this.opts.appsDir
          || !basename(j.tmp).startsWith(`${j.appId}.tmp.`)) {
          throw new Error('journal paths do not belong to this scope');
        }
        const switched = j.phase === 'switched'
          || (j.phase === 'exchange' && j.newIno !== undefined && existsSync(j.target) && statSync(j.target).ino === j.newIno);
        if (switched) {
          this.finish(j);
          out.push({ appId: j.appId, outcome: 'completed' });
          continue;
        }
        // Not switched: the old tree is in place; its data goes back.
        if (existsSync(j.tmp)) {
          for (const entry of j.carried) {
            const from = join(j.tmp, entry), to = join(j.target, entry);
            if (existsSync(from) && !existsSync(to) && existsSync(j.target)) renameSync(from, to);
          }
          if (existsSync(j.target)) fsyncDir(j.target);
          rmSync(j.tmp, { recursive: true, force: true });
          fsyncDir(dirname(j.tmp));
        }
        this.dropJournal(j.appId);
        out.push({ appId: j.appId, outcome: 'undone' });
      } catch (err) {
        out.push({ appId: j.appId, outcome: 'failed', detail: (err as Error).message });
      }
    }
    return out;
  }

  /**
   * Uninstall: move the app's code to trash, drop the install record.
   * Preserves the app's data unless `purge: true`: its runtime data
   * (`runtimeDataEntries`) stays in `apps/<id>/` — without
   * `app.manifest.json` that dir is no app — and a reinstall that passes the
   * restore check carries it over; per-app data at `data/apps/<id>/` stays too.
   *
   * `purge` is "Delete app data": nothing is moved to trash, and the app's
   * earlier trash copies and set-aside data are deleted as well.
   */
  async uninstall(appId: string, opts: { purge?: boolean } = {}): Promise<void> {
    if (opts.purge) {
      this.purge(appId);
      return;
    }
    const appDir = join(this.opts.appsDir, appId);
    if (existsSync(appDir)) {
      const trashRoot = join(this.opts.dataDir, 'nexus', 'trash');
      mkdirSync(trashRoot, { recursive: true });
      const dest = join(trashRoot, `${appId}-${Date.now()}`);
      const keep = runtimeDataEntries(appDir, appId);
      if (keep.length === 0) {
        moveOrCopy(appDir, dest);
      } else {
        mkdirSync(dest, { recursive: true });
        for (const name of readdirSafe(appDir)) {
          if (!keep.includes(name)) moveOrCopy(join(appDir, name), join(dest, name));
        }
      }
    }

    const recordPath = join(this.opts.dataDir, 'nexus', 'installed', `${appId}.json`);
    if (existsSync(recordPath)) rmSync(recordPath);
  }

  /** Delete the app dir, its per-app data, its trash entries, its set-aside data and its record. */
  private purge(appId: string): void {
    if (!APP_ID_PATTERN.test(appId)) throw new Error(`refusing to purge: invalid app id ${JSON.stringify(appId)}`);
    removeContained(this.opts.appsDir, appId);
    removeContained(join(this.opts.dataDir, 'apps'), appId);
    const trashRoot = join(this.opts.dataDir, 'nexus', 'trash');
    for (const name of readdirSafe(trashRoot)) {
      if (isTrashEntryOf(name, appId)) removeContained(trashRoot, name);
    }
    removeContained(this.retainedRoot(), appId);
    removeContained(join(this.opts.dataDir, 'nexus', 'installed'), `${appId}.json`);
  }

  private retainedRoot(): string { return join(this.opts.dataDir, 'nexus', 'retained'); }

  private retainedDir(appId: string, installationId: string): string {
    if (!APP_ID_PATTERN.test(appId) || !isOriginId(installationId)) {
      throw new Error(`invalid retained-data path: ${appId}/${installationId}`);
    }
    return join(this.retainedRoot(), appId, installationId);
  }

  /** Whether `apps/<id>/` holds only what a keep-data uninstall left behind. */
  hasRetainedData(appId: string): boolean {
    const appDir = join(this.opts.appsDir, appId);
    return !existsSync(join(appDir, 'app.manifest.json')) && runtimeDataEntries(appDir, appId).length > 0;
  }

  /**
   * Set retained data aside for its installation, because the app being
   * installed under this id is not entitled to it. Moved, never deleted.
   */
  setAsideRetainedData(appId: string, installationId: string): void {
    const appDir = join(this.opts.appsDir, appId);
    const entries = runtimeDataEntries(appDir, appId);
    if (entries.length === 0) return;
    const dest = this.retainedDir(appId, installationId);
    if (existsSync(dest)) throw new Error(`retained data of ${appId} is already set aside for ${installationId}`);
    mkdirSync(dest, { recursive: true });
    for (const name of entries) moveOrCopy(join(appDir, name), join(dest, name));
  }

  /** Put data set aside earlier back, once its installation passed the restore check. */
  restoreRetainedData(appId: string, installationId: string): void {
    const src = this.retainedDir(appId, installationId);
    if (!existsSync(src)) return;
    const appDir = join(this.opts.appsDir, appId);
    const names = readdirSafe(src);
    const clash = names.find((name) => existsSync(join(appDir, name)));
    if (clash) throw new Error(`cannot restore ${appId}: ${clash} already exists`);
    mkdirSync(appDir, { recursive: true });
    for (const name of names) moveOrCopy(join(src, name), join(appDir, name));
    removeContained(join(this.retainedRoot(), appId), installationId);
  }

  /**
   * The tree an install moved aside for `record` (its rollback tree): the
   * trash entry named for the same timestamp as the record's `updatedAt`.
   * Null when the install replaced nothing.
   */
  previousTree(record: InstallRecord): string | null {
    const dir = join(this.opts.dataDir, 'nexus', 'trash', `${record.id}-${Date.parse(record.updatedAt)}`);
    return existsSync(dir) ? dir : null;
  }

  /** The newest trash entry of an app (the latest tree an install or uninstall moved aside), or null. */
  newestTrash(appId: string): string | null {
    const trashRoot = join(this.opts.dataDir, 'nexus', 'trash');
    const newest = readdirSafe(trashRoot).filter((n) => isTrashEntryOf(n, appId))
      .sort((a, b) => Number(b.slice(appId.length + 1)) - Number(a.slice(appId.length + 1)))[0];
    return newest ? join(trashRoot, newest) : null;
  }

  /** Record the owner's source-mode choice (`aura dev open`) on the install record. */
  setSourceMode(appId: string, mode: SourceMode): InstallRecord {
    // The raw file, not getRecord(): its read-time defaults must not be written back.
    const recordPath = join(this.opts.dataDir, 'nexus', 'installed', `${appId}.json`);
    let record: InstallRecord;
    try { record = JSON.parse(readFileSync(recordPath, 'utf-8')) as InstallRecord; }
    catch { throw new Error(`${appId} has no install record in scope ${this.opts.scope}`); }
    record.sourceMode = mode;
    writeFileSync(recordPath, JSON.stringify(record, null, 2));
    return record;
  }

  /** Lookup the install record for an app, or null. */
  getRecord(appId: string): InstallRecord | null {
    const recordPath = join(this.opts.dataDir, 'nexus', 'installed', `${appId}.json`);
    if (!existsSync(recordPath)) return null;
    try {
      const r = JSON.parse(readFileSync(recordPath, 'utf-8')) as InstallRecord;
      // Backward compat: records written before scopes default to 'system'.
      if (!r.scope) r.scope = 'system';
      return r;
    } catch {
      return null;
    }
  }

  /** List every install record on disk. */
  listRecords(): InstallRecord[] {
    const dir = join(this.opts.dataDir, 'nexus', 'installed');
    if (!existsSync(dir)) return [];
    const out: InstallRecord[] = [];
    for (const file of readdirSafe(dir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const r = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as InstallRecord;
        if (!r.scope) r.scope = 'system';
        out.push(r);
      } catch { /* skip corrupt */ }
    }
    return out;
  }
}

/** `<appId>-<timestamp>`, the exact name the installer gives a trash entry. */
export function isTrashEntryOf(name: string, appId: string): boolean {
  return name.startsWith(`${appId}-`) && /^\d+$/.test(name.slice(appId.length + 1));
}

/**
 * Delete exactly `<root>/<name>`, which must be a direct child of `root`.
 * Refuses separators, dot segments and NUL. A symlink is unlinked, never
 * followed. Returns whether anything was removed.
 */
export function removeContained(root: string, name: string): boolean {
  if (!name || name === '.' || name === '..' || /[/\\\0]/.test(name)) {
    throw new Error(`refusing to delete unsafe path segment: ${JSON.stringify(name)}`);
  }
  if (!existsSync(root)) return false;
  const realRoot = realpathSync(root);
  const target = join(realRoot, name);
  if (dirname(target) !== realRoot) throw new Error(`refusing to delete outside ${realRoot}: ${target}`);
  try { lstatSync(target); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
  rmSync(target, { recursive: true, force: true });
  return true;
}

function readdirSafe(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

/**
 * The entries of an app dir that are runtime state, not code. In the global
 * and user scopes an app's dir is also its data dir: each instance keeps
 * `<appId>/` or `<appId>-<n>/` there (AppManager: `<scope data>/apps/<appId>/
 * <instanceId>`), sidecar volumes live in `.sidecars/`, and `.data/` is the
 * app's own. A release never contains them (PublishFiles' deny list).
 */
export function runtimeDataEntries(appDir: string, appId: string): string[] {
  const instanceDir = new RegExp(`^${appId.replace(/\./g, '\\.')}(-\\d+)?$`);
  return readdirSafe(appDir).filter((name) => name === '.sidecars' || name === '.data' || instanceDir.test(name));
}

/**
 * Move an app's runtime data from the copy being replaced into the new one.
 * Moved, not copied: a rename keeps the directory itself, so a running
 * instance keeps writing to the same data (now inside the new copy) instead
 * of into the trash. The user's data wins over anything a bundle shipped
 * under the same name. Returns what was carried over.
 */
export function carryOverRuntimeData(oldDir: string, newDir: string, appId: string): string[] {
  const moved: string[] = [];
  for (const name of runtimeDataEntries(oldDir, appId)) {
    const dst = join(newDir, name);
    if (existsSync(dst)) rmSync(dst, { recursive: true, force: true });
    moveOrCopy(join(oldDir, name), dst);
    moved.push(name);
  }
  return moved;
}

/** Write a file so it survives a crash: temp file, fsync, rename, fsync the dir. */
function writeDurable(path: string, data: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  const fd = openSync(tmp, 'w', 0o644);
  try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
  fsyncDir(dirname(path));
}

/** fsync a directory (its entries: renames and creations in it are durable). */
function fsyncDir(dir: string): void {
  let fd: number | null = null;
  try { fd = openSync(dir, 'r'); fsyncSync(fd); } catch { /* gone or not a dir */ } finally { if (fd !== null) closeSync(fd); }
}

/** The staging tree into `dst` (missing): a rename on one filesystem, else a copy. */
function moveOrSync(src: string, dst: string): void {
  try { renameSync(src, dst); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    rsyncOrCp(src, dst);
  }
}

function rsyncOrCp(src: string, dst: string): void {
  try {
    execFileSync('rsync', ['-a', `${src}/`, `${dst}/`], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch {
    cpSync(src, dst, { recursive: true });
  }
}

/** Move a directory, falling back to copy+delete when `rename(2)` fails
 *  (cross-device, busy mount, etc.). The destination MUST NOT exist yet. */
function moveOrCopy(src: string, dst: string): void {
  try {
    renameSync(src, dst);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EXDEV' || code === 'EBUSY' || code === 'EPERM') {
      cpSync(src, dst, { recursive: true });
      rmSync(src, { recursive: true, force: true });
    } else {
      throw err;
    }
  }
}

/** Where the installed release's source lives: its manifest's `repository`
 *  (publish stamps branch + commit there), else its publish marker. */
function upstreamOf(appDir: string, m: AppManifest): AppSourceInfo | undefined {
  const marker = readPublishMarker(appDir)?.source;
  if (m.repository) {
    const commit = m.repository.commit || undefined;
    return {
      repository: m.repository.url,
      ...(m.repository.branch ? { branch: m.repository.branch } : {}),
      ...(commit ? { commit } : {}),
      ...(commit && marker?.commit === commit && marker.dirty ? { dirty: true } : {}),
    };
  }
  return marker?.repository ? marker : undefined;
}

function buildInstallRecord(
  m: AppManifest, r: ResolvedRef, ts: number, scope: ScopeId,
  link: { remoteId?: string; detached?: boolean }, upstream?: AppSourceInfo,
): InstallRecord {
  const iso = new Date(ts).toISOString();
  return {
    id:          m.id,
    version:     m.version,
    source:      r.source,
    ref:         r.rawRef,
    digest:      r.digest,
    channel:     r.channel ?? null,
    installedAt: iso,
    updatedAt:   iso,
    scope,
    ...(r.sourceName ? { sourceName: r.sourceName } : {}),
    ...(m.originId ? { originId: m.originId } : {}),
    ...(link.remoteId && link.remoteId !== m.id ? { remoteId: link.remoteId } : {}),
    ...(link.detached ? { detached: true } : {}),
    ...(upstream ? { upstream } : {}),
  };
}
