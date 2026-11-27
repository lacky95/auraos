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
 * Deterministic: rows are sorted, and the digest (`ownershipDigest`, owner
 * decision D5) covers what is security-relevant: each row's path, the facts
 * of its own path (`from` owner, `root`: type, mode, filesystem identity, and
 * where it really resolves to when that differs), and the planned change
 * (to, onlyFrom, mode, recursive, excludes, refusals). Not the counts
 * (entries, files, bytes, toChange, rootOwned): an app writing ordinary data
 * between the dry run and the apply does not invalidate the owner's review.
 * The apply checks the same facts again right before it changes anything
 * (`checkApplyRows`, ownershipApply.ts).
 */
import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { lstat, opendir, readlink, realpath } from 'node:fs/promises';
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

/** The security-relevant facts of a row's own path (D5): in the digest, checked again by the apply. */
export interface OwnershipRootFacts {
  type: 'directory' | 'file' | 'symlink' | 'other';
  /** Permission and special bits, octal (`0755`). */
  mode: string;
  /** The filesystem identity, `device:inode`: a path replaced or moved to another filesystem differs. */
  fsid: string;
  /** Where the path really resolves to, only when that differs from `path` (a component is a link). */
  real?: string;
}

/** The facts of `st` (an `lstat` with `bigint`, so no inode loses precision). Pure. */
export function rootFactsOf(st: BigIntStats, path: string, real: string): OwnershipRootFacts {
  const type = st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'other';
  return {
    type, mode: `0${(Number(st.mode) & 0o7777).toString(8).padStart(3, '0')}`, fsid: `${st.dev}:${st.ino}`,
    ...(real !== path ? { real } : {}),
  };
}

export interface OwnershipRow {
  path: string;
  kind: string;
  owner?: string;
  /** The top directory's current `uid:gid`; null when the path does not exist. */
  from: string | null;
  /** The facts of the path itself; null when it does not exist. */
  root: OwnershipRootFacts | null;
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
  /** `ownershipDigest`: the security-relevant facts and the planned change, not the counts. What an apply approves. */
  digest: string;
  planned: OwnershipRow[];
  plannedUserPaths: OwnershipRow[];
  plannedAppPaths: OwnershipRow[];
  reportOnly: OwnershipRow[];
  refused: Array<{ path: string; reason: string; target?: string }>;
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
  root: OwnershipRootFacts | null;
  /** A symlink root's target. */
  target?: string;
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
    exists: false, from: null, root: null, entries: 0, files: 0, bytes: 0, toChange: 0, rootOwned: 0, rootOwnedGit: 0,
    truncated: false, symlinkRoot: false,
  };
  let big;
  try { big = await lstat(spec.path, { bigint: true }); } catch { return out; }
  out.exists = true;
  out.from = `${big.uid}:${big.gid}`;
  let real = spec.path;
  try { real = await realpath(spec.path); } catch { /* gone meanwhile: the facts still differ from a later look */ }
  out.root = rootFactsOf(big, spec.path, real);
  if (big.isSymbolicLink()) {
    out.symlinkRoot = true;
    try { out.target = await readlink(spec.path); } catch { /* gone meanwhile */ }
    return out;
  }
  const top = {
    uid: Number(big.uid), gid: Number(big.gid), size: Number(big.size), dev: Number(big.dev),
    isFile: () => big.isFile(), isDirectory: () => big.isDirectory(),
  };
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
      report.refused.push({ path, reason: 'the path is a symbolic link: never followed', ...(w.target !== undefined ? { target: w.target } : {}) });
      continue;
    }
    const row: OwnershipRow = {
      path, kind: spec.kind,
      ...(spec.owner ? { owner: spec.owner } : {}),
      from: w.from,
      root: w.root,
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
    if (w.root?.real) report.findings.push(`${path}: resolves to ${w.root.real} (a component is a symbolic link); an apply refuses if that changes`);
    if (w.truncated) report.findings.push(`${path}: more than ${maxEntries} entries; the counts are lower bounds`);
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
  report.digest = ownershipDigest(
    { planned: report.planned, plannedUserPaths: report.plannedUserPaths, plannedAppPaths: report.plannedAppPaths, reportOnly: report.reportOnly },
    { refused: report.refused },
  );
  return report;
}

/** A row without its counts: what a digest covers of it. */
function digestRow(row: OwnershipRow): Omit<OwnershipRow, 'entries' | 'files' | 'bytes' | 'toChange' | 'rootOwned' | 'rootOwnedGit' | 'truncated'> {
  const { entries: _e, files: _f, bytes: _b, toChange: _t, rootOwned: _r, rootOwnedGit: _g, truncated: _x, ...facts } = row;
  return facts;
}

/**
 * The one digest of the ownership migration (the homes report and the run-as
 * plan, owner decision D5): sha256 over `plan` and the rows of each list
 * without their counts. So ordinary content and byte-count changes keep it;
 * a changed path, owner, mode, type, link, filesystem identity, containment
 * or planned change does not.
 */
export function ownershipDigest(rows: Record<string, readonly OwnershipRow[]>, plan: Record<string, unknown>): string {
  const lists = Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, v.map(digestRow)]));
  return createHash('sha256').update(JSON.stringify({ ...plan, ...lists })).digest('hex');
}
