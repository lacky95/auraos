/**
 * The ownership apply (Phase 5 stream H; P5-2, D70): the targeted chown the
 * dry-run ownership report (ownershipReport.ts) lists, for the digest the
 * owner approved, and nothing else.
 *
 *   - The report is rebuilt from the same candidate rows right before the
 *     apply; if its digest differs from the approved one (the tree or the
 *     rows changed), nothing is changed and the caller shows the new report.
 *   - Only `planned` (Private Homes, user workspaces) and `plannedUserPaths`
 *     (the Developer Mode tree, patch repositories, own app source) rows
 *     apply, and only those whose `only` condition the caller says holds.
 *     `plannedAppPaths` rows apply with each installation's `runAs` flip
 *     (P5-3), `reportOnly` rows never; a row without an allocated identity
 *     is skipped. Refused roots (`/`, `/data`, …) never apply: no blanket chown.
 *   - Every change is journaled first (path, previous uid, gid and mode, one
 *     JSON line each, 0600 under `/data/aura/state/ownership-journal/`), so
 *     `revertOwnershipJournal` restores the exact previous state.
 *
 * The walk is `chownTree` (appOwnership.ts): directory descriptors, no symlink
 * followed, one filesystem, hard-linked files left alone. It runs in a child
 * process (`runOwnershipApply`), so a multi-gigabyte home never blocks the
 * shell's event loop.
 */
import { execFile } from 'node:child_process';
import { closeSync, constants, fchmodSync, fchownSync, fstatSync, lchownSync, lstatSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chownTree, type OwnershipJournalEntry } from './appOwnership.js';
import type { OwnershipReport, OwnershipRow } from './ownershipReport.js';

export type ApplySection = 'planned' | 'plannedUserPaths';

/** One row the apply changes, as handed to the walker. */
export interface ApplyRow {
  path: string;
  kind: string;
  to: { uid: number; gid: number };
  recursive: boolean;
  exclude?: string[];
  /** Octal (`0700`) for the top directory, or `g+rX, setgid dirs`. */
  mode?: string;
}

export interface OwnershipApplyResult {
  digest: string;
  journal: string;
  rows: Array<{ path: string; kind: string; changed: number; skipped: number; skippedSample: string[] }>;
  /** Rows of the approved report that were not applied, and why. */
  notApplied: Array<{ path: string; kind: string; reason: string }>;
}

export class OwnershipApplyError extends Error {
  constructor(readonly code: 'digest-mismatch' | 'invalid', message: string) {
    super(message);
    this.name = 'OwnershipApplyError';
  }
}

/** Where the journals live, under the root data dir. */
export const ownershipJournalDir = (dataDir: string): string => join(dataDir, 'aura', 'state', 'ownership-journal');

const parseTo = (to: string | null): { uid: number; gid: number } | null => {
  const m = /^(\d+):(\d+)$/.exec(to ?? '');
  return m ? { uid: Number(m[1]), gid: Number(m[2]) } : null;
};

/**
 * The rows of `report` an apply would change. `holds(row)` answers a row's
 * `only` condition (e.g. Developer Mode is on); a row with an unmet one is
 * not applied. Pure.
 */
export function selectApplyRows(
  report: OwnershipReport, opts: { holds: (only: string) => boolean },
): { rows: ApplyRow[]; notApplied: OwnershipApplyResult['notApplied'] } {
  const rows: ApplyRow[] = [];
  const notApplied: OwnershipApplyResult['notApplied'] = [];
  const refused = new Set(report.refused.map((r) => r.path));
  for (const section of ['planned', 'plannedUserPaths'] as const) {
    for (const r of report[section] as OwnershipRow[]) {
      const to = parseTo(r.to);
      const skip = (reason: string) => notApplied.push({ path: r.path, kind: r.kind, reason });
      if (refused.has(r.path)) { skip('refused: no blanket chown (D70)'); continue; }
      if (!to) { skip('its identity is not allocated'); continue; }
      if (to.uid === 0) { skip('never to root'); continue; }
      if (!r.exists) { skip('does not exist'); continue; }
      if (r.only && !opts.holds(r.only)) { skip(`only ${r.only}`); continue; }
      if (r.toChange === 0 && !(r.mode && /^0[0-7]{3}$/.test(r.mode))) { skip('nothing to change'); continue; }
      rows.push({ path: r.path, kind: r.kind, to, recursive: r.recursive, ...(r.exclude ? { exclude: r.exclude } : {}), ...(r.mode ? { mode: r.mode } : {}) });
    }
  }
  return { rows, notApplied };
}

/** Applies `rows` in this process, journaling to `journal` (created 0600, never overwritten). */
export function applyOwnershipRows(rows: readonly ApplyRow[], journal: string): OwnershipApplyResult['rows'] {
  const fd = openSync(journal, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const out: OwnershipApplyResult['rows'] = [];
  try {
    const write = (e: OwnershipJournalEntry) => { writeSync(fd, `${JSON.stringify(e)}\n`); };
    for (const row of rows) {
      let st;
      try { st = lstatSync(row.path); } catch { out.push({ path: row.path, kind: row.kind, changed: 0, skipped: 1, skippedSample: ['missing'] }); continue; }
      if (st.isSymbolicLink() || !st.isDirectory()) { out.push({ path: row.path, kind: row.kind, changed: 0, skipped: 1, skippedSample: ['not a real directory'] }); continue; }
      const octal = row.mode && /^0[0-7]{3}$/.test(row.mode) ? parseInt(row.mode, 8) : undefined;
      const r = chownTree(row.path, { uid: row.to.uid, gid: row.to.gid }, {
        recursive: row.recursive,
        ...(row.exclude?.length ? { exclude: new Set(row.exclude) } : {}),
        journal: write,
        ...(octal !== undefined ? { topMode: octal } : {}),
        ...(row.mode && /g\+rX/.test(row.mode) ? { groupReadable: true } : {}),
      });
      out.push({ path: row.path, kind: row.kind, changed: r.changed, skipped: r.skipped.length, skippedSample: r.skipped.slice(0, 20) });
    }
  } finally { closeSync(fd); }
  return out;
}

/**
 * Restores every entry of a journal to its previous owner and mode, newest
 * first. Symlinks are never followed (`lchown`); an entry that is gone or no
 * longer the same kind is reported, not recreated.
 */
export function revertOwnershipJournal(journal: string): { restored: number; skipped: string[] } {
  const lines = readFileSync(journal, 'utf-8').split('\n').filter(Boolean);
  const out = { restored: 0, skipped: [] as string[] };
  for (const line of lines.reverse()) {
    let e: OwnershipJournalEntry;
    try { e = JSON.parse(line) as OwnershipJournalEntry; } catch { out.skipped.push('a malformed line'); continue; }
    let st;
    try { st = lstatSync(e.path); } catch { out.skipped.push(`${e.path}: gone`); continue; }
    try {
      if (st.isSymbolicLink()) { lchownSync(e.path, e.uid, e.gid); out.restored++; continue; }
      const fd = openSync(e.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        fchownSync(fd, e.uid, e.gid);
        if ((fstatSync(fd).mode & 0o7777) !== e.mode) fchmodSync(fd, e.mode);
      } finally { closeSync(fd); }
      out.restored++;
    } catch (err) { out.skipped.push(`${e.path}: ${(err as NodeJS.ErrnoException).code ?? 'error'}`); }
  }
  return out;
}

/**
 * Runs `applyOwnershipRows` in a child process (root, like the shell), so the
 * walk never blocks the event loop. Returns the journal path and per-row counts.
 */
export async function runOwnershipApply(
  dataDir: string, digest: string, rows: readonly ApplyRow[], opts: { now?: () => number; timeoutMs?: number } = {},
): Promise<{ journal: string; rows: OwnershipApplyResult['rows'] }> {
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new OwnershipApplyError('invalid', 'invalid digest');
  const dir = ownershipJournalDir(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date((opts.now ?? Date.now)()).toISOString().replace(/[:.]/g, '-');
  const journal = join(dir, `${stamp}-${digest.slice(0, 12)}.ndjson`);
  const stdout = await new Promise<string>((resolve, reject) => {
    // Resolved at the call: core is also bundled as CommonJS (the CLI), which never applies.
    const worker = fileURLToPath(new URL('./ownershipApplyWorker.js', import.meta.url));
    const child = execFile(process.execPath, [worker, journal], {
      timeout: opts.timeoutMs ?? 60 * 60_000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf-8',
    }, (err, out, errOut) => (err ? reject(new Error(`ownership apply failed: ${String(errOut || err.message).trim().slice(-500)}`)) : resolve(out)));
    child.stdin?.end(JSON.stringify(rows));
  });
  return { journal, rows: JSON.parse(stdout) as OwnershipApplyResult['rows'] };
}
