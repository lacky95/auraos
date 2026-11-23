/**
 * Nexus installer. Takes a validated staging dir + the manifest pulled
 * from it, atomically lands the source at `apps/<id>/`, writes the
 * install record at `data/nexus/installed/<id>.json`, and lets the
 * AppRegistry's chokidar watcher pick up the new app.
 *
 * Atomicity: rsync into `apps/<id>.tmp.<ts>/`, then `rename(2)`. The
 * rename is the chokidar trigger point — a partial dir never appears.
 *
 * The installer DOES NOT call into AppRegistry directly; the chokidar
 * watcher does that on its own when the new directory appears.
 */
import { execFileSync } from 'node:child_process';
import {
  cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync,
  renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { AppManifest } from '../types/manifest.js';
import type { InstallRecord, ResolvedRef } from './types.js';
import type { ScopeId } from '../scopes/types.js';
import { APP_ID_PATTERN, isOriginId, readOriginId } from '../app-manager/AppIdentity.js';
import { readPublishMarker, type AppSourceInfo } from './AppSource.js';

export interface InstallerOpts {
  appsDir: string;
  dataDir: string;
  scope:   ScopeId;
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
  ): Promise<InstallRecord> {
    const targetDir = join(this.opts.appsDir, manifest.id);
    const ts = Date.now();
    const tmpDir = `${targetDir}.tmp.${ts}`;

    // 1. Sync staging → tmp (still off the watched glob, since the
    //    watcher matches `apps/*/app.manifest.json` and .tmp.* isn't
    //    a real app id).
    mkdirSync(dirname(tmpDir), { recursive: true });
    rsyncOrCp(stagingDir, tmpDir);

    // 2. If a previous version exists, move it aside. `apps/` and
    //    `data/` may live on different mounts (bind mounts vs the
    //    container's own fs), in which case `rename(2)` fails with
    //    EXDEV — fall back to cp+rm.
    // Never replace a DIFFERENT app: the caller (NexusManager's identity
    // check) only gets here for the same artifact or an explicit choice, so
    // two different originIds under one id is a bug, not a decision.
    const have = readOriginId(join(targetDir, 'app.manifest.json'));
    if (have && manifest.originId && have !== manifest.originId) {
      rmSync(tmpDir, { recursive: true, force: true });
      throw new Error(`refusing to replace ${manifest.id}: it is a different app (originId ${have}, incoming ${manifest.originId})`);
    }
    if (existsSync(targetDir)) {
      // An update must not wipe the user's data: in the global and user
      // scopes it lives inside the app dir that is being replaced.
      carryOverRuntimeData(targetDir, tmpDir, manifest.id);
      if (readdirSafe(targetDir).length === 0) {
        // Only data was left (an uninstall keeps it): nothing to keep in trash.
        rmSync(targetDir, { recursive: true, force: true });
      } else {
        const trashRoot = join(this.opts.dataDir, 'nexus', 'trash');
        mkdirSync(trashRoot, { recursive: true });
        moveOrCopy(targetDir, join(trashRoot, `${manifest.id}-${ts}`));
      }
    }

    // 3. Atomic rename — this is the chokidar trigger. tmpDir lives
    //    alongside targetDir under appsDir so the rename is in-fs.
    renameSync(tmpDir, targetDir);

    // 4. Write the install record. Stored under data/, NOT in the app
    //    dir (keeps the app dir reproducible across publishes).
    const record = buildInstallRecord(manifest, resolved, ts, this.opts.scope, link, upstreamOf(targetDir, manifest));
    const recordPath = join(this.opts.dataDir, 'nexus', 'installed', `${manifest.id}.json`);
    mkdirSync(dirname(recordPath), { recursive: true });
    writeFileSync(recordPath, JSON.stringify(record, null, 2));

    return record;
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
