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
 *
 * The run-as migration (identity/runAsOwnership.ts) runs through the same
 * apply: its rows carry `onlyFrom`, and the flip back first restores an
 * earlier apply's journal exactly (`restore`, `restoreJournalEntries`).
 */
import { execFile } from 'node:child_process';
import {
  closeSync, constants, fchmodSync, fchownSync, fstatSync, lchownSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { coreWorkerPath } from '../system/workerPath.js';
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
  /** Only entries owned by this uid change (the run-as migration). */
  onlyFrom?: { uid: number; gid: number };
}

/**
 * Entries of an earlier journal restored exactly (owner and mode), newest
 * first, before the rows apply: the run-as flip back (runAsOwnership.ts) and
 * the recovery of an interrupted one.
 */
export interface JournalRestore {
  /** The earlier journal (a path from `ownershipJournalPath`). */
  journal: string;
  /** Only entries at or under these paths (the rows); any other line is skipped. */
  within: string[];
  /**
   * Only entries this uid still owns (as that apply left them): one someone
   * changed since keeps its owner. Null: every entry (a recovery).
   */
  owner: { uid: number } | null;
}

/** What the worker is handed. */
export interface ApplyRequest { rows: ApplyRow[]; restore?: JournalRestore }

export interface OwnershipApplyResult {
  digest: string;
  journal: string;
  rows: Array<{ path: string; kind: string; changed: number; skipped: number; skippedSample: string[] }>;
  /** `restore`: entries restored from the earlier journal, and what was left alone. */
  restored?: { restored: number; skipped: number; skippedSample: string[] };
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
      const onlyFrom = parseTo(r.onlyFrom ?? null);
      rows.push({
        path: r.path, kind: r.kind, to, recursive: r.recursive, ...(r.exclude ? { exclude: r.exclude } : {}), ...(r.mode ? { mode: r.mode } : {}),
        ...(onlyFrom ? { onlyFrom } : {}),
      });
    }
  }
  return { rows, notApplied };
}

/** Applies `rows` in this process, journaling to `journal` (created 0600, never overwritten). */
export function applyOwnershipRows(rows: readonly ApplyRow[], journal: string): OwnershipApplyResult['rows'] {
  return applyOwnershipRequest({ rows: [...rows] }, journal).rows;
}

/**
 * `applyOwnershipRows`, with `req.restore` first: that earlier journal's
 * entries, journaled too, so the whole apply reverts exactly.
 */
export function applyOwnershipRequest(req: ApplyRequest, journal: string): Pick<OwnershipApplyResult, 'rows' | 'restored'> {
  const fd = openSync(journal, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const out: OwnershipApplyResult['rows'] = [];
  let restored: OwnershipApplyResult['restored'];
  try {
    const write = (e: OwnershipJournalEntry) => { writeSync(fd, `${JSON.stringify(e)}\n`); };
    if (req.restore) {
      const r = restoreJournalEntries(req.restore, write);
      restored = { restored: r.restored, skipped: r.skipped.length, skippedSample: r.skipped.slice(0, 20) };
    }
    for (const row of req.rows) {
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
        ...(row.onlyFrom ? { onlyFrom: row.onlyFrom } : {}),
      });
      out.push({ path: row.path, kind: row.kind, changed: r.changed, skipped: r.skipped.length, skippedSample: r.skipped.slice(0, 20) });
    }
  } finally { closeSync(fd); }
  return { rows: out, ...(restored ? { restored } : {}) };
}

/**
 * Restores the entries of `r.journal` that lie inside `r.within` (and, with
 * `r.owner`, that uid still owns) to their previous owner and mode, newest
 * first, journaling each entry's current state to `write` first. Never
 * through a symlink: the entry's own link is `lchown`ed, and an entry whose
 * parent path is not its real path (a component swapped for a link) is
 * skipped. Gone entries are reported, not recreated.
 */
export function restoreJournalEntries(r: JournalRestore, write?: (e: OwnershipJournalEntry) => void): { restored: number; skipped: string[] } {
  const out = { restored: 0, skipped: [] as string[] };
  const within = r.within.map((w) => resolve(w));
  const inside = (p: string) => within.some((w) => p === w || p.startsWith(`${w}/`));
  for (const line of readFileSync(r.journal, 'utf-8').split('\n').filter(Boolean).reverse()) {
    let e: OwnershipJournalEntry;
    try { e = JSON.parse(line) as OwnershipJournalEntry; } catch { out.skipped.push('a malformed line'); continue; }
    if (typeof e.path !== 'string' || resolve(e.path) !== e.path || !inside(e.path)) { out.skipped.push(`${String(e.path)}: outside the rows`); continue; }
    if (![e.uid, e.gid, e.mode].every((n) => Number.isSafeInteger(n) && n >= 0)) { out.skipped.push(`${e.path}: a malformed entry`); continue; }
    try { if (realpathSync(dirname(e.path)) !== dirname(e.path)) { out.skipped.push(`${e.path}: its path goes through a link`); continue; } }
    catch { out.skipped.push(`${e.path}: gone`); continue; }
    let st;
    try { st = lstatSync(e.path); } catch { out.skipped.push(`${e.path}: gone`); continue; }
    if (r.owner && st.uid !== r.owner.uid) { out.skipped.push(`${e.path}: its owner changed since (kept)`); continue; }
    try {
      if (st.isSymbolicLink()) {
        write?.({ path: e.path, uid: st.uid, gid: st.gid, mode: st.mode & 0o7777 });
        lchownSync(e.path, e.uid, e.gid);
        out.restored++;
        continue;
      }
      const fd = openSync(e.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const cur = fstatSync(fd);
        if (r.owner && cur.uid !== r.owner.uid) { out.skipped.push(`${e.path}: its owner changed since (kept)`); continue; }
        if (cur.isFile() && cur.nlink > 1) { out.skipped.push(`${e.path}: a file with ${cur.nlink} links, left as it is`); continue; }
        if (cur.uid === e.uid && cur.gid === e.gid && (cur.mode & 0o7777) === e.mode) continue;
        write?.({ path: e.path, uid: cur.uid, gid: cur.gid, mode: cur.mode & 0o7777 });
        fchownSync(fd, e.uid, e.gid);
        if ((fstatSync(fd).mode & 0o7777) !== e.mode) fchmodSync(fd, e.mode);
      } finally { closeSync(fd); }
      out.restored++;
    } catch (err) { out.skipped.push(`${e.path}: ${(err as NodeJS.ErrnoException).code ?? 'error'}`); }
  }
  return out;
}

/**
 * The journal file an operator names for a revert (stream T's deploy recovery):
 * a bare journal name of this data dir's journal directory, never a path.
 * Null for anything else.
 */
export function ownershipJournalPath(dataDir: string, name: string): string | null {
  const base = String(name ?? '').split('/').pop() ?? '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(base) || base.includes('..')) return null;
  const p = join(ownershipJournalDir(dataDir), base);
  try {
    const st = lstatSync(p);
    return st.isFile() && !st.isSymbolicLink() ? p : null;
  } catch { return null; }
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
/** A new journal's path for an apply of `digest` (not created yet; the directory is). */
export function newOwnershipJournal(dataDir: string, digest: string, now: () => number = Date.now): string {
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new OwnershipApplyError('invalid', 'invalid digest');
  const dir = ownershipJournalDir(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
  return join(dir, `${stamp}-${digest.slice(0, 12)}.ndjson`);
}

export async function runOwnershipApply(
  dataDir: string, digest: string, rows: readonly ApplyRow[],
  opts: { now?: () => number; timeoutMs?: number; journal?: string; restore?: JournalRestore } = {},
): Promise<{ journal: string; rows: OwnershipApplyResult['rows']; restored?: OwnershipApplyResult['restored'] }> {
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new OwnershipApplyError('invalid', 'invalid digest');
  const journal = opts.journal ?? newOwnershipJournal(dataDir, digest, opts.now);
  if (dirname(journal) !== ownershipJournalDir(dataDir)) throw new OwnershipApplyError('invalid', 'a journal outside the journal directory');
  const stdout = await new Promise<string>((resolve, reject) => {
    // Resolved at the call: core is also bundled as CommonJS (the CLI), which never applies.
    let worker: string;
    try { worker = coreWorkerPath(import.meta.url, 'ownershipApplyWorker.js', 'ownership-apply'); }
    catch (err) { reject(new Error(`ownership apply failed: its worker script was not found (${(err as Error).message.split('\n')[0]})`)); return; }
    const child = execFile(process.execPath, [worker, journal], {
      timeout: opts.timeoutMs ?? 60 * 60_000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf-8',
    }, (err, out, errOut) => {
      if (!err) { resolve(out); return; }
      // The error line, not Node's source excerpt or stack (paths and messages only).
      const text = String(errOut || err.message).trim();
      reject(new Error(`ownership apply failed (worker ${worker}): ${(text.split('\n').find((l) => /Error\b/.test(l)) ?? text.slice(-300)).slice(0, 300)}`));
    });
    child.stdin?.end(JSON.stringify(opts.restore ? { rows: [...rows], restore: opts.restore } satisfies ApplyRequest : rows));
  });
  const out = JSON.parse(stdout) as { rows: OwnershipApplyResult['rows']; restored?: OwnershipApplyResult['restored'] } | OwnershipApplyResult['rows'];
  return Array.isArray(out) ? { journal, rows: out } : { journal, rows: out.rows, ...(out.restored ? { restored: out.restored } : {}) };
}
