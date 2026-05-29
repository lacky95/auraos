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
  cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync,
  rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { AppManifest } from '../types/manifest.js';
import type { InstallRecord, ResolvedRef } from './types.js';
import type { ScopeId } from '../scopes/types.js';

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
   * record. If `apps/<id>/` already exists (update path), the old dir is
   * moved aside to `data/nexus/trash/<id>-<ts>/` first so an undo window
   * exists.
   */
  async install(stagingDir: string, manifest: AppManifest, resolved: ResolvedRef): Promise<InstallRecord> {
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
    if (existsSync(targetDir)) {
      const trashRoot = join(this.opts.dataDir, 'nexus', 'trash');
      mkdirSync(trashRoot, { recursive: true });
      moveOrCopy(targetDir, join(trashRoot, `${manifest.id}-${ts}`));
    }

    // 3. Atomic rename — this is the chokidar trigger. tmpDir lives
    //    alongside targetDir under appsDir so the rename is in-fs.
    renameSync(tmpDir, targetDir);

    // 4. Write the install record. Stored under data/, NOT in the app
    //    dir (keeps the app dir reproducible across publishes).
    const record = buildInstallRecord(manifest, resolved, ts, this.opts.scope);
    const recordPath = join(this.opts.dataDir, 'nexus', 'installed', `${manifest.id}.json`);
    mkdirSync(dirname(recordPath), { recursive: true });
    writeFileSync(recordPath, JSON.stringify(record, null, 2));

    return record;
  }

  /**
   * Uninstall: move the app dir to trash, drop the install record.
   * Preserves per-app data at `data/apps/<id>/` unless `purge: true`.
   */
  async uninstall(appId: string, opts: { purge?: boolean } = {}): Promise<void> {
    const appDir = join(this.opts.appsDir, appId);
    if (existsSync(appDir)) {
      const trashRoot = join(this.opts.dataDir, 'nexus', 'trash');
      mkdirSync(trashRoot, { recursive: true });
      moveOrCopy(appDir, join(trashRoot, `${appId}-${Date.now()}`));
    }

    const recordPath = join(this.opts.dataDir, 'nexus', 'installed', `${appId}.json`);
    if (existsSync(recordPath)) rmSync(recordPath);

    if (opts.purge) {
      const appData = join(this.opts.dataDir, 'apps', appId);
      if (existsSync(appData)) rmSync(appData, { recursive: true, force: true });
    }
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

function readdirSafe(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
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

function buildInstallRecord(m: AppManifest, r: ResolvedRef, ts: number, scope: ScopeId): InstallRecord {
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
  };
}
