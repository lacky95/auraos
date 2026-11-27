/**
 * The run-as migration (owner decision 5-main, "run-as reversible"): the
 * ownership half of `aura admin apps run-as <app> app|root`, in both
 * directions, through the reviewed ownership migration of streams A, I and H.
 * Nothing new: the rows are `appOwnershipSpecs` (appOwnership.ts), measured
 * by `buildOwnershipReport` (ownershipReport.ts) and applied, journaled, by
 * `runOwnershipApply` (ownershipApply.ts).
 *
 *   root -> app   the rows to the app uid; only root's entries change
 *   app -> root   first the journal of the migration that handed them to the
 *                 app restored exactly (entries the app uid still owns), then
 *                 what the app created since (still the app uid's) to root
 *
 * Only the installation's managed storage: its instance data directories,
 * its App Homes and its dev caches. Never a Private Home, a mount (`.mnt` is
 * never walked; a walk never crosses a filesystem), another app's data, or an
 * entry someone else owns (`onlyFrom`). No capability is added to read
 * anything: the files change owner instead.
 *
 * The plan is a dry run with a digest; the owner approves exactly that digest
 * (`fresh`), and the shell (appRunAs.ts) stops the app, applies, flips the
 * record and restarts what ran. A pending migration is on the installation
 * record (`runAsMigration`) from before the first change until the flip, so
 * an interrupted one blocks the app's start until it is recovered
 * (`runAsMigrationBlock`): the journal restored exactly.
 */
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { AppRunAsMigration } from '../app-hosts/contracts.js';
import { appOwnershipSpecs, type AppOwnershipInput } from './appOwnership.js';
import type { ApplyRow, JournalRestore } from './ownershipApply.js';
import { buildOwnershipReport, ownershipDigest, type OwnershipRow } from './ownershipReport.js';
import type { LinuxIdentity } from './types.js';

export type RunAsTarget = 'root' | 'app';

export interface RunAsOwnershipInput extends Omit<AppOwnershipInput, 'identity' | 'from' | 'instanceDirs'> {
  installationId: string;
  /** The runAs the flip goes to. */
  runAs: RunAsTarget;
  /** The identity its processes ran as, and the one they will run as (one of them root). */
  from: LinuxIdentity;
  to: LinuxIdentity;
  /**
   * The journal of the migration that handed the storage to `from` (a path
   * from `ownershipJournalPath`), if there is one: the flip back restores it.
   */
  previousJournal: string | null;
}

export interface RunAsOwnershipPlan {
  version: 1;
  appId: string;
  installationId: string;
  runAs: RunAsTarget;
  from: string;
  to: string;
  rows: OwnershipRow[];
  refused: Array<{ path: string; reason: string }>;
  findings: string[];
  /** The flip back: the earlier journal restored exactly first (its name, and its entries inside the rows). */
  restore: { journal: string; entries: number } | null;
  /**
   * `ownershipDigest` over everything above but the rows' counts and the
   * findings (D5): what the owner approves. Data the app writes since does
   * not change it; a changed row path, owner, mode, type, filesystem
   * identity, containment, refusal or restore does.
   */
  digest: string;
}

export interface RunAsOwnershipApply {
  rows: ApplyRow[];
  restore?: JournalRestore;
  /** Every existing row path: the bounds of a restore or a recovery. */
  within: string[];
}

const ids = (i: LinuxIdentity) => `${i.uid}:${i.gid}`;

/** The installation's managed storage paths a run-as migration may touch (for a recovery's bounds). */
export function runAsOwnershipPaths(input: Omit<RunAsOwnershipInput, 'runAs' | 'from' | 'to' | 'previousJournal'>): string[] {
  return appOwnershipSpecs({ ...input, identity: null }).map((r) => resolve(r.path));
}

/** The dry run: the rows with their counts, the restore, the digest. Read-only. */
export async function runAsOwnershipPlan(
  input: RunAsOwnershipInput, opts: { refuseRoots: readonly string[]; now?: () => number },
): Promise<{ plan: RunAsOwnershipPlan; apply: RunAsOwnershipApply }> {
  if ((input.from.uid === 0) === (input.to.uid === 0)) throw new Error('a run-as migration goes from root to an app identity or back');
  const specs = appOwnershipSpecs({ ...input, identity: input.to, from: input.from });
  const report = await buildOwnershipReport(specs, { refuseRoots: opts.refuseRoots, ...(opts.now ? { now: opts.now } : {}) });
  const rows = report.plannedAppPaths;
  const within = rows.filter((r) => r.exists).map((r) => r.path);
  const inside = (p: string) => within.some((w) => p === w || p.startsWith(`${w}/`));
  let restore: RunAsOwnershipPlan['restore'] = null;
  let journalRestore: JournalRestore | undefined;
  if (input.previousJournal && input.to.uid === 0) {
    let entries = 0;
    try {
      for (const line of readFileSync(input.previousJournal, 'utf-8').split('\n')) {
        if (!line) continue;
        try { if (inside(String((JSON.parse(line) as { path?: unknown }).path))) entries++; } catch { /* counted by the apply as malformed */ }
      }
      restore = { journal: basename(input.previousJournal), entries };
      journalRestore = { journal: input.previousJournal, within, owner: { uid: input.from.uid } };
    } catch {
      report.findings.push(`${basename(input.previousJournal)}: the journal of the earlier migration can't be read; the flip back hands the app's entries to root instead of restoring them exactly`);
    }
  }
  const refused = new Set(report.refused.map((r) => r.path));
  const apply: RunAsOwnershipApply = {
    rows: rows.flatMap((r) => (r.exists && r.from && r.root && !refused.has(r.path) ? [{
      path: r.path, kind: r.kind, to: { uid: input.to.uid, gid: input.to.gid }, recursive: r.recursive,
      ...(r.exclude ? { exclude: r.exclude } : {}), ...(r.mode ? { mode: r.mode } : {}),
      onlyFrom: { uid: input.from.uid, gid: input.from.gid },
      expect: { from: r.from, root: r.root },
    }] : [])),
    ...(journalRestore ? { restore: journalRestore } : {}),
    within,
  };
  const body = {
    version: 1 as const, appId: input.appId, installationId: input.installationId, runAs: input.runAs,
    from: ids(input.from), to: ids(input.to), rows, refused: report.refused, findings: report.findings, restore,
  };
  const { rows: _rows, findings: _findings, ...plan } = body;
  const digest = ownershipDigest({ rows }, plan);
  return { plan: { ...body, digest }, apply };
}

/**
 * The start gate: an installation with a pending run-as migration does not
 * start (its storage may be half handed over). Null when it may start.
 */
export function runAsMigrationBlock(appId: string, installation: { runAsMigration?: AppRunAsMigration }): string | null {
  const m = installation.runAsMigration;
  if (!m) return null;
  return `${appId}: its run-as change to ${m.to} did not finish (started ${new Date(m.startedAt).toISOString()}, journal ${m.journal}), `
    + 'so its data may belong partly to each identity: not started. Restore it with '
    + `\`aura admin apps run-as ${appId} --recover\` (your password), then run the change again.`;
}

/** Audit action of the run-as migration's recovery (the flip itself is `app.run-as-changed`). */
export const RUN_AS_MIGRATION_AUDIT_ACTIONS = {
  recovered: 'app.run-as-recovered',
} as const;
