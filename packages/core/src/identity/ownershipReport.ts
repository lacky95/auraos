/**
 * The dry-run ownership report (Phase 5 stream I, P5-2, D70). Read-only:
 * it walks the candidate paths with `lstat` and never changes, opens or reads
 * a file. Stream H applies exactly the planned rows of an approved digest
 * (5-main, `ownership-apply`); this module never chowns anything.
 *
 *   planned            Private Homes and the user's workspaces, to the user's uid
 *   plannedUserPaths   targeted rows that replace session capabilities (P5-2):
 *                      the Developer Mode tree, patch repositories, own app source
 *   plannedAppPaths    per installation, applied with its `runAs` flip (P5-3)
 *   reportOnly         shown, never changed (closed sources, sidecar volumes)
 *   refused            what no row may ever cover: a blanket chown (D70)
 *
 * The caller (the shell) names the candidate rows; this module measures them
 * and decides what is refused. Symlinks are never followed, a row's own path
 * must not be a symlink, and a walk stays on its row's filesystem.
 * Deterministic: rows are sorted, and the digest covers every row's
 * security-relevant facts (owner decision D5, 2026-11-27): its path, kind,
 * planned owner and mode, the top entry's filesystem identity (dev:ino),
 * owner and mode, whether it exists, whether root-owned entries exist, the
 * refusals (blanket roots, symbolic links) and the containment findings.
 * Not `generatedAt` and not the counts: ordinary content and byte-count
 * changes (an app writing between the dry run and the apply) keep the
 * digest; a changed identity, owner, mode, symlink or containment changes
 * it. The apply recomputes it right before applying (ownershipApply.ts).
 */
import { createHash } from 'node:crypto';
import { lstat, opendir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export type OwnershipSection = 'planned' | 'plannedUserPaths' | 'plannedAppPaths' | 'reportOnly';

/** One candidate row, as the shell names it. */
export interface OwnershipRowSpec {
  section: OwnershipSection;
  path: string;
  kind: string;
  /** The principal the row is for: a user id or an installation id. */
  owner?: string;
  /** The target owner; null while its identity is not allocated (shown, never applicable). */
  to: { uid: number; gid: number } | null;
  /** Only entries owned by this uid change (appOwnership.ts `chownTree`); the rest keep their owner. */
  onlyFrom?: { uid: number; gid: number };
  /** Octal, e.g. `0700`; or a symbolic note such as `g+rX, setgid dirs`. */
  mode?: string;
  recursive: boolean;
  /** Directory names skipped at any depth (e.g. `node_modules`). */
  exclude?: readonly string[];
  /** When the row applies, e.g. `when Developer Mode is on`. */
  only?: string;
  note?: string;
  /** Count root-owned entries under `.git` apart (`rootOwnedGit`), for the Developer Mode tree. */
  splitGit?: boolean;
}

export interface OwnershipRow {
  path: string;
  kind: string;
  owner?: string;
  /** The top directory's current `uid:gid`; null when the path does not exist. */
  from: string | null;
  /** The top entry's filesystem identity `dev:ino` and its mode (octal); absent when the path does not exist. */
  fsId?: string;
  topMode?: string;
  to: string | null;
  /** Only entries owned by this `uid:gid`'s uid change; the rest keep their owner. */
  onlyFrom?: string;
  mode?: string;
  recursive: boolean;
  exclude?: string[];
  only?: string;
  note?: string;
  exists: boolean;
  /** Entries walked (files, directories, links). */
  entries: number;
  files: number;
  bytes: number;
  /** Entries whose owner differs from `to` (what an apply would change). */
  toChange: number;
  /** Entries owned by uid 0. */
  rootOwned: number;
  /** `splitGit` rows: root-owned entries under `.git`, which `rootOwned` then leaves out. */
  rootOwnedGit?: number;
  /** The walk stopped at the entry limit; the counts are lower bounds. */
  truncated?: true;
}

export interface OwnershipReport {
  version: 1;
  generatedAt: string;
  /** sha256 over every row's security-relevant facts (`ownershipDigest`; not the counts, not `generatedAt`): what an apply approves. */
  digest: string;
  planned: OwnershipRow[];
  plannedUserPaths: OwnershipRow[];
  plannedAppPaths: OwnershipRow[];
  reportOnly: OwnershipRow[];
  refused: Array<{ path: string; reason: string }>;
  /** Findings worth the owner's attention (by path; never file contents). */
  findings: string[];
}

export interface OwnershipReportOptions {
  /** Paths no row may be (a blanket chown, D70): e.g. `/`, `/data`, `/data/aura`. */
  refuseRoots: readonly string[];
  now?: () => number;
  /** Per row; default 2,000,000. */
  maxEntries?: number;
}

const DEFAULT_MAX_ENTRIES = 2_000_000;

interface Walked {
  exists: boolean;
  from: string | null;
  fsId: string | null;
  topMode: string | null;
  entries: number;
  files: number;
  bytes: number;
  toChange: number;
  rootOwned: number;
  rootOwnedGit: number;
  truncated: boolean;
  symlinkRoot: boolean;
}

async function walk(spec: OwnershipRowSpec, maxEntries: number): Promise<Walked> {
  const out: Walked = {
    exists: false, from: null, fsId: null, topMode: null, entries: 0, files: 0, bytes: 0, toChange: 0, rootOwned: 0, rootOwnedGit: 0,
    truncated: false, symlinkRoot: false,
  };
  let top;
  try { top = await lstat(spec.path); } catch { return out; }
  out.exists = true;
  out.from = `${top.uid}:${top.gid}`;
  out.fsId = `${top.dev}:${top.ino}`;
  out.topMode = (top.mode & 0o7777).toString(8).padStart(4, '0');
  if (top.isSymbolicLink()) { out.symlinkRoot = true; return out; }
  const exclude = new Set(spec.exclude ?? []);
  const count = (st: { uid: number; gid: number; size: number; isFile(): boolean }, inGit: boolean) => {
    out.entries++;
    if (st.isFile()) { out.files++; out.bytes += st.size; }
    if (spec.to && (st.uid !== spec.to.uid || st.gid !== spec.to.gid) && (!spec.onlyFrom || st.uid === spec.onlyFrom.uid)) out.toChange++;
    if (st.uid === 0) {
      if (spec.splitGit && inGit) out.rootOwnedGit++;
      else out.rootOwned++;
    }
  };
  count(top, false);
  if (!spec.recursive || !top.isDirectory()) return out;
  const dev = top.dev;
  const stack: Array<{ dir: string; inGit: boolean }> = [{ dir: spec.path, inGit: false }];
  while (stack.length) {
    const { dir, inGit } = stack.pop()!;
    let handle;
    try { handle = await opendir(dir); } catch { continue; }
    for await (const ent of handle) {
      if (out.entries >= maxEntries) { out.truncated = true; break; }
      if (ent.isDirectory() && exclude.has(ent.name)) continue;
      const p = join(dir, ent.name);
      let st;
      try { st = await lstat(p); } catch { continue; }
      const git = inGit || (dir === spec.path && ent.name === '.git');
      count(st, git);
      // Never follow a link, never cross into another filesystem (a mount).
      if (st.isDirectory() && !st.isSymbolicLink() && st.dev === dev) stack.push({ dir: p, inGit: git });
    }
    if (out.truncated) break;
  }
  return out;
}

/** Absolute, without a trailing separator (`resolve` drops it). */
const norm = (p: string) => resolve(p);

/** Measures `specs` and builds the report. Never writes. */
export async function buildOwnershipReport(specs: readonly OwnershipRowSpec[], opts: OwnershipReportOptions): Promise<OwnershipReport> {
  const now = opts.now ?? Date.now;
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const refuseRoots = new Set(opts.refuseRoots.map(norm));
  const report: OwnershipReport = {
    version: 1, generatedAt: new Date(now()).toISOString(), digest: '',
    planned: [], plannedUserPaths: [], plannedAppPaths: [], reportOnly: [], refused: [], findings: [],
  };
  for (const root of [...refuseRoots].sort()) report.refused.push({ path: root, reason: 'no blanket chown (D70)' });
  const seen = new Set<string>();
  for (const spec of [...specs].sort((a, b) => a.section.localeCompare(b.section) || a.path.localeCompare(b.path))) {
    const path = norm(spec.path);
    if (refuseRoots.has(path)) continue; // listed under `refused` already
    const key = `${spec.section}|${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const w = await walk({ ...spec, path }, maxEntries);
    if (w.symlinkRoot) {
      report.refused.push({ path, reason: 'the path is a symbolic link: never followed' });
      continue;
    }
    const row: OwnershipRow = {
      path, kind: spec.kind,
      ...(spec.owner ? { owner: spec.owner } : {}),
      from: w.from,
      ...(w.fsId ? { fsId: w.fsId } : {}),
      ...(w.topMode ? { topMode: w.topMode } : {}),
      to: spec.to ? `${spec.to.uid}:${spec.to.gid}` : null,
      ...(spec.onlyFrom ? { onlyFrom: `${spec.onlyFrom.uid}:${spec.onlyFrom.gid}` } : {}),
      ...(spec.mode ? { mode: spec.mode } : {}),
      recursive: spec.recursive,
      ...(spec.exclude?.length ? { exclude: [...spec.exclude].sort() } : {}),
      ...(spec.only ? { only: spec.only } : {}),
      ...(spec.note ? { note: spec.note } : {}),
      exists: w.exists, entries: w.entries, files: w.files, bytes: w.bytes, toChange: w.toChange, rootOwned: w.rootOwned,
      ...(spec.splitGit ? { rootOwnedGit: w.rootOwnedGit } : {}),
      ...(w.truncated ? { truncated: true as const } : {}),
    };
    report[spec.section].push(row);
    if (w.truncated) report.findings.push(`${path}: more than ${maxEntries} entries; the counts are lower bounds${TRUNCATED_MARK}`);
    if (spec.section !== 'reportOnly' && !spec.to && w.exists) report.findings.push(`${path}: its identity is not allocated yet, so the row is not applicable`);
  }
  // A recursive row that covers another row (of any section) would chown it too: a planned
  // row over a report-only one changes what must stay, two planned rows disagree. Report both.
  const all = (['planned', 'plannedUserPaths', 'plannedAppPaths', 'reportOnly'] as const)
    .flatMap((section) => report[section].map((row) => ({ section, row })));
  for (const a of all) {
    if (a.section === 'reportOnly' || !a.row.recursive) continue;
    for (const b of all) {
      if (a === b) continue;
      const inside = b.row.path.startsWith(`${a.row.path}/`);
      if (inside || (b.row.path === a.row.path && a.section !== b.section)) {
        report.findings.push(`${b.row.path} (${b.section}) ${inside ? 'lies inside' : 'is also'} ${a.row.path} (${a.section})`);
      }
    }
  }
  report.digest = ownershipDigest({
    planned: report.planned, plannedUserPaths: report.plannedUserPaths, plannedAppPaths: report.plannedAppPaths,
    reportOnly: report.reportOnly, refused: report.refused, findings: report.findings,
  });
  return report;
}

/** Marks the count-only finding (a truncated walk), which the digest leaves out. */
const TRUNCATED_MARK = ' (truncated)';

/**
 * A row as the digest binds it (D5): every field but the counts. Root-owned
 * entries count only as present or not, so a root writer adding files keeps
 * the digest while a tree that had none and now has one changes it.
 */
export function ownershipRowBinding(row: OwnershipRow): Record<string, unknown> {
  const { entries: _e, files: _f, bytes: _b, toChange: _t, rootOwned, rootOwnedGit, truncated: _x, ...facts } = row;
  return { ...facts, hasRootOwned: rootOwned + (rootOwnedGit ?? 0) > 0 };
}

/** The digest of an ownership plan (D5): `rows` sections bound by `ownershipRowBinding`, other fields as they are; count-only findings left out. */
export function ownershipDigest(body: Record<string, unknown>): string {
  const bound = Object.fromEntries(Object.entries(body).map(([k, v]) => {
    if (k === 'findings' && Array.isArray(v)) return [k, (v as string[]).filter((f) => !f.endsWith(TRUNCATED_MARK))];
    if (Array.isArray(v) && v.every((r) => r && typeof r === 'object' && 'entries' in r && 'path' in r)) {
      return [k, (v as OwnershipRow[]).map(ownershipRowBinding)];
    }
    return [k, v];
  }));
  return createHash('sha256').update(JSON.stringify(bound)).digest('hex');
}
