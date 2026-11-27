/**
 * The one-shot migration of local grant edits into the settings overlay (Phase 6 stream O).
 *
 * Before the overlay, `aura cap grant` on a system app rewrote its tracked
 * `apps/<id>/app.manifest.json`, and the old CLI wrote `.aura/capabilities.yaml` (+ `.bak`) in
 * the checkout. This turns those edits into overlay ops and gives the tree back clean:
 *
 *   report (read-only)  per system app: the difference between the manifest on disk and
 *                       `git show HEAD:…`, the overlay ops it becomes (tools, services[].tools,
 *                       permissions) and every OTHER field that differs; the release
 *                       registry's local edits and its untracked `.bak`; a digest over all of it.
 *   apply <digest>      exactly the reported state (else `digest-mismatch`): writes the ops
 *                       (merged onto the app's overlay), restores a tracked manifest only when
 *                       nothing but those three fields differs, moves the `.bak` aside into
 *                       the overlay dir. A modified tracked registry is reported only: the owner
 *                       adds its entries with `aura cap registry add` (sealed, approved; SF-2).
 *
 * Idempotent: once applied, the report is empty, except for manifests that keep other local
 * changes (still reported; applying their ops again changes nothing). Developer Mode only (a
 * checkout with git); a release has no `.git` and nothing to migrate. Who may run it, and the
 * audit (`overlay.migrated`), are the caller's (`/api/admin/overlay`).
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { layout, APP_ID_RE } from './paths.js';
import {
  mergeManifestOverlays, overlayFromDiff, readManifestOverlay, writeManifestOverlay, type ManifestOverlay,
} from '../app-manager/manifestOverlay.js';

export const OVERLAY_MIGRATION_VERSION = 1;
/** The only fields the overlay carries: a report whose `fields` stays within these is fully migratable. */
export const OVERLAY_FIELDS = ['tools', 'services[].tools', 'permissions'] as const;

export interface OverlayMigrationOptions {
  /** The checkout (`/workspace`). */
  repoRoot: string;
  /** Its system apps (`/workspace/apps`). */
  systemAppsDir: string;
  /** The data root (`/data`): the overlay lives under it. */
  dataRoot: string;
}

export interface OverlayMigrationApp {
  appId: string;
  /** Repo-relative manifest path. */
  manifest: string;
  /** The ops the local edit becomes (null: none of the three fields differs). */
  ops: ManifestOverlay | null;
  /** Of `OVERLAY_FIELDS`, those that differ. */
  fields: string[];
  /** Every other differing field (`services` = a template changed beyond its tools; `formatting` = same JSON, other text). */
  otherFields: string[];
  /** Restore the tracked file on apply: only when nothing but the overlay fields (or formatting) differs. */
  restore: boolean;
}

export interface OverlayMigrationRegistry {
  /** Repo-relative path. */
  file: string;
  tracked: boolean;
  /** Capability names relative to the release registry at HEAD. */
  added: string[];
  changed: string[];
  removed: string[];
  /** `move-aside`: the untracked backup goes to the overlay dir; `report-only`: the owner re-adds entries (`aura cap registry add`). */
  action: 'move-aside' | 'report-only';
}

export interface OverlayMigrationReport {
  v: 1;
  /** `developer`: a git checkout; `release`: nothing to migrate. */
  mode: 'developer' | 'release';
  head: string | null;
  apps: OverlayMigrationApp[];
  registry: OverlayMigrationRegistry[];
  /** Union of the overlay fields the apps touch: the migration moves only these. */
  fields: string[];
  /** Union of the other fields (kept in place, reported). */
  otherFields: string[];
  /** Over everything above: `apply` takes it. */
  digest: string;
}

export interface OverlayMigrationResult {
  applied: true;
  /** Apps whose overlay was written. */
  overlays: string[];
  /** Apps whose tracked manifest was restored. */
  restored: string[];
  /** Files moved aside (repo-relative → absolute target). */
  movedAside: Array<{ file: string; to: string }>;
}

export class OverlayMigrationError extends Error {
  constructor(readonly code: 'digest-mismatch' | 'not-a-checkout', message: string) {
    super(message);
    this.name = 'OverlayMigrationError';
  }
}

const REGISTRY_FILE = '.aura/capabilities.yaml';
const REGISTRY_BACKUP = '.aura/capabilities.yaml.bak';

function git(repoRoot: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', repoRoot, '-c', `safe.directory=${repoRoot}`, ...args], {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024,
    });
  } catch { return null; }
}

/** Stable JSON (sorted keys) for comparisons and the digest. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

function compareManifest(head: Record<string, unknown>, disk: Record<string, unknown>): { fields: string[]; otherFields: string[] } {
  const fields: string[] = [];
  const otherFields: string[] = [];
  const keys = [...new Set([...Object.keys(head), ...Object.keys(disk)])].sort();
  for (const k of keys) {
    if (canonical(head[k]) === canonical(disk[k])) continue;
    if (k === 'tools' || k === 'permissions') { fields.push(k); continue; }
    if (k === 'services' && Array.isArray(head[k]) && Array.isArray(disk[k])) {
      const hs = head[k] as unknown[], ds = disk[k] as unknown[];
      const strip = (l: unknown[]) => l.map((s) => (s && typeof s === 'object' ? { ...(s as object), tools: undefined } : s));
      if (canonical(strip(hs)) !== canonical(strip(ds))) otherFields.push('services');
      const tools = (l: unknown[]) => l.map((s) => (s && typeof s === 'object' ? (s as Record<string, unknown>)['tools'] : undefined));
      if (canonical(tools(hs)) !== canonical(tools(ds))) fields.push('services[].tools');
      continue;
    }
    otherFields.push(k);
  }
  return { fields, otherFields };
}

function registryNames(text: string | null): Record<string, string> {
  if (text === null) return {};
  try {
    const doc = parseYaml(text) as { capabilities?: Record<string, unknown> } | null;
    return Object.fromEntries(Object.entries(doc?.capabilities ?? {}).map(([n, d]) => [n, canonical(d)]));
  } catch { return {}; }
}

function registryRow(file: string, tracked: boolean, headText: string | null, diskText: string): OverlayMigrationRegistry {
  const head = registryNames(headText);
  const disk = registryNames(diskText);
  return {
    file, tracked,
    added: Object.keys(disk).filter((n) => !(n in head)).sort(),
    changed: Object.keys(disk).filter((n) => n in head && head[n] !== disk[n]).sort(),
    removed: Object.keys(head).filter((n) => !(n in disk)).sort(),
    action: tracked ? 'report-only' : 'move-aside',
  };
}

/** What the migration would do. Read-only. */
export function overlayMigrationReport(opts: OverlayMigrationOptions): OverlayMigrationReport {
  const headRev = git(opts.repoRoot, ['rev-parse', 'HEAD'])?.trim() || null;
  const apps: OverlayMigrationApp[] = [];
  const registry: OverlayMigrationRegistry[] = [];
  if (headRev) {
    const ids = existsSync(opts.systemAppsDir)
      ? readdirSync(opts.systemAppsDir, { withFileTypes: true }).filter((e) => e.isDirectory() && APP_ID_RE.test(e.name)).map((e) => e.name).sort()
      : [];
    for (const appId of ids) {
      const abs = join(opts.systemAppsDir, appId, 'app.manifest.json');
      if (!existsSync(abs)) continue;
      const rel = relative(opts.repoRoot, abs);
      const headText = git(opts.repoRoot, ['show', `HEAD:${rel}`]);
      if (headText === null) continue; // not tracked: an app of this checkout only, nothing to restore
      const diskText = readFileSync(abs, 'utf-8');
      if (diskText === headText) continue;
      let head: Record<string, unknown>, disk: Record<string, unknown>;
      try { head = JSON.parse(headText) as Record<string, unknown>; disk = JSON.parse(diskText) as Record<string, unknown>; }
      catch { apps.push({ appId, manifest: rel, ops: null, fields: [], otherFields: ['unparsable'], restore: false }); continue; }
      const { fields, otherFields } = compareManifest(head, disk);
      if (fields.length === 0 && otherFields.length === 0) otherFields.push('formatting');
      apps.push({
        appId, manifest: rel, ops: overlayFromDiff(head, disk), fields, otherFields,
        restore: otherFields.every((f) => f === 'formatting'),
      });
    }
    const regAbs = join(opts.repoRoot, REGISTRY_FILE);
    const regHead = git(opts.repoRoot, ['show', `HEAD:${REGISTRY_FILE}`]);
    if (existsSync(regAbs) && regHead !== null) {
      const text = readFileSync(regAbs, 'utf-8');
      if (text !== regHead) registry.push(registryRow(REGISTRY_FILE, true, regHead, text));
    }
    const bakAbs = join(opts.repoRoot, REGISTRY_BACKUP);
    if (existsSync(bakAbs) && git(opts.repoRoot, ['ls-files', '--error-unmatch', REGISTRY_BACKUP]) === null) {
      registry.push(registryRow(REGISTRY_BACKUP, false, regHead, readFileSync(bakAbs, 'utf-8')));
    }
  }
  const fields = [...new Set(apps.flatMap((a) => a.fields))].sort();
  const otherFields = [...new Set(apps.flatMap((a) => a.otherFields))].sort();
  const body = { v: OVERLAY_MIGRATION_VERSION, mode: headRev ? 'developer' : 'release', head: headRev, apps, registry, fields, otherFields } as const;
  return { ...body, digest: createHash('sha256').update(canonical(body)).digest('hex') };
}

/** Where a moved-aside file goes: beside the overlay that replaces it. */
export function migratedDir(dataRoot: string): string {
  return join(dirname(layout(dataRoot).overlayCapabilities), 'migrated');
}

function moveFile(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  try { renameSync(from, to); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    copyFileSync(from, to);
    rmSync(from);
  }
}

/** Apply exactly the report whose digest the owner reviewed. */
export function applyOverlayMigration(opts: OverlayMigrationOptions, digest: string): OverlayMigrationResult {
  const report = overlayMigrationReport(opts);
  if (report.mode !== 'developer') throw new OverlayMigrationError('not-a-checkout', 'this install runs from a release: there is nothing to migrate');
  if (report.digest !== digest) {
    throw new OverlayMigrationError('digest-mismatch', `the state changed since the report (now ${report.digest}); review the new report`);
  }
  const overlayApps = layout(opts.dataRoot).overlayApps;
  const result: OverlayMigrationResult = { applied: true, overlays: [], restored: [], movedAside: [] };
  for (const a of report.apps) {
    if (a.ops) {
      writeManifestOverlay(overlayApps, a.appId, mergeManifestOverlays(readManifestOverlay(overlayApps, a.appId), a.ops));
      result.overlays.push(a.appId);
    }
    if (a.restore) {
      const headText = git(opts.repoRoot, ['show', `HEAD:${a.manifest}`]);
      if (headText !== null) {
        writeFileSync(join(opts.repoRoot, a.manifest), headText);
        result.restored.push(a.appId);
      }
    }
  }
  for (const r of report.registry) {
    if (r.action !== 'move-aside') continue;
    const to = join(migratedDir(opts.dataRoot), `${r.file.split('/').pop()}.${new Date().toISOString().replace(/[:.]/g, '-')}`);
    moveFile(join(opts.repoRoot, r.file), to);
    result.movedAside.push({ file: r.file, to });
  }
  return result;
}
