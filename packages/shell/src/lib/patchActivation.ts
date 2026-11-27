/**
 * The series side of an app patch activation (Phase 7a, Q23 "approval
 * integrity" and "auditability"), for R4 (`POST /api/apps/<id>/activate`)
 * and R1's save record:
 *
 * - `preparedSeries`: the series at the revision the CLI names, read from
 *   the installation's patch repository (never from the request), validated
 *   patch by patch, and checked against the prepared tree: a clean work tree
 *   whose commits on the series' base are exactly the enabled patches, in
 *   order (git patch-id). Its `PatchBinding` goes into the install binding,
 *   so any change of base, revision, order, an enabled flag or a byte is a
 *   new approval. The dialog lines and the exact diff come from the same data.
 * - `auditPatch`: the patch lifecycle rows in the admin audit (no contents).
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as core from '@aura/core';
import type { PatchBinding } from '@aura/core';

/** The diff shown in the dialog is clipped to this many characters. */
export const DIALOG_DIFF_LIMIT = 256 * 1024;

export interface PreparedSeries {
  binding: PatchBinding;
  /** Dialog lines: base, revision, the ordered patches with flags, the diffstat. */
  lines: string[];
  /** The enabled patches, concatenated (clipped), for the dialog. */
  diff: string;
  patches: number;
}

export type SeriesError = { error: string; message: string; status: number };

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync('git', [...core.safeDirectoryArgs(cwd), '-C', cwd, ...args], {
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], timeout: 60_000, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, ...(input !== undefined ? { input } : {}),
  }).toString();
}

function tryGit(cwd: string, args: string[], input?: string): string | null {
  try { return git(cwd, args, input).trim(); } catch { return null; }
}

/** `+added -removed` of one patch's hunks. */
export function diffstat(content: string): { added: number; removed: number; files: number } {
  let added = 0, removed = 0, inHunk = false;
  for (const l of content.split('\n')) {
    if (l.startsWith('diff --git ')) { inHunk = false; continue; }
    if (l.startsWith('@@')) { inHunk = true; continue; }
    if (!inHunk) continue;
    if (l === '-- ') { inHunk = false; continue; }
    if (l.startsWith('+')) added++;
    else if (l.startsWith('-')) removed++;
  }
  return { added, removed, files: core.patchFiles(content).length };
}

/**
 * Whether `tree` is exactly base + the enabled patches: no uncommitted,
 * untracked or ignored files, the commit `n` below HEAD has the base's tree,
 * and the `n` commits on it have the patches' patch-ids, in order.
 */
export function verifyPreparedTree(tree: string, series: core.Series, enabled: Array<{ content: string; file: string }>): string | null {
  if (!existsSync(join(tree, '.git'))) return 'the prepared tree is not a patch workspace';
  const status = tryGit(tree, ['status', '--porcelain', '--ignored', '--untracked-files=all']);
  if (status === null) return 'the prepared tree could not be read';
  if (status) return `the prepared tree has changes that are not in the series: ${status.split('\n').slice(0, 3).join(', ')}`;
  const n = enabled.length;
  const want = series.base.path ? `${series.base.commit}:${series.base.path}` : `${series.base.commit}^{tree}`;
  const baseTree = tryGit(tree, ['rev-parse', '-q', '--verify', want]);
  const atBase = tryGit(tree, ['rev-parse', '-q', '--verify', `HEAD~${n}^{tree}`]);
  if (!baseTree || !atBase || baseTree !== atBase) return `the prepared tree is not the series' base ${series.base.commit.slice(0, 12)} plus ${n} patch${n === 1 ? '' : 'es'}`;
  const commits = (tryGit(tree, ['rev-list', '--reverse', `HEAD~${n}..HEAD`]) ?? '').split('\n').filter(Boolean);
  if (commits.length !== n) return `the prepared tree has ${commits.length} commits on the base, the series ${n} enabled patches`;
  const idOf = (patch: string) => (tryGit(tree, ['patch-id', '--stable'], patch) ?? '').split(' ')[0] ?? '';
  for (let i = 0; i < n; i++) {
    const have = idOf(git(tree, ['show', '--format=', commits[i]!]));
    const expect = idOf(enabled[i]!.content);
    if (!have || have !== expect) return `commit ${i + 1} of the prepared tree is not ${enabled[i]!.file}`;
  }
  return null;
}

/**
 * The series at `rev` of an installation's patch repository, validated and
 * checked against `tree`, as the binding and dialog of its activation.
 */
export function preparedSeries(opts: {
  dataDir: string; installationId: string; rev: unknown; appId: string; scope: 'global' | 'user'; tree: string; upstreamCommit?: string | null;
}): PreparedSeries | SeriesError {
  if (typeof opts.rev !== 'string' || !/^[0-9a-f]{7,64}$/.test(opts.rev)) {
    return { error: 'invalid-revision', message: 'pass rev: the patch repository revision the tree was built from', status: 400 };
  }
  const repo = join(opts.dataDir, core.patchRepoSubpath(opts.installationId));
  if (!existsSync(join(repo, '.git'))) return { error: 'no-patch-repo', message: `${opts.appId} has no patch repository`, status: 409 };
  const rev = tryGit(repo, ['rev-parse', '-q', '--verify', `${opts.rev}^{commit}`]);
  if (!rev) return { error: 'invalid-revision', message: `'${opts.rev}' is not a revision of the patch repository`, status: 404 };
  let loaded: ReturnType<typeof core.loadSeries>;
  try { loaded = core.loadSeries(repo, rev); }
  catch (err) { return { error: 'invalid-series', message: (err as Error).message, status: 422 }; }
  if (!loaded) return { error: 'invalid-series', message: `no series at ${rev.slice(0, 12)}`, status: 422 };
  const { series, patches, digest } = loaded;
  if (core.seriesAppId(series) !== opts.appId) {
    return { error: 'invalid-series', message: `the series at ${rev.slice(0, 12)} patches ${core.seriesAppId(series) ?? 'the system'}, not ${opts.appId}`, status: 422 };
  }
  const target: core.PatchTarget = { kind: 'app', appId: opts.appId, scope: opts.scope };
  const enabled = patches.filter((p) => p.enabled);
  let results: ReturnType<typeof core.assertPatchesValid>;
  try { results = core.assertPatchesValid(target, enabled); }
  catch (err) { return { error: 'patch-refused', message: (err as Error).message, status: 422 }; }
  const mismatch = verifyPreparedTree(opts.tree, series, enabled);
  if (mismatch) return { error: 'tree-mismatch', message: mismatch, status: 422 };

  const binding = core.patchBinding({ target: series.target, base: series.base, patches }, rev, { target });
  const lines: string[] = [];
  const up = opts.upstreamCommit;
  lines.push(`Base: ${series.base.commit.slice(0, 12)}${series.base.path ? `:${series.base.path}` : ''}${
    up ? (up === series.base.commit ? ' (the installed upstream)' : ` (NOT the installed upstream ${up.slice(0, 12)})`) : ''}`);
  lines.push(`Series revision: ${rev.slice(0, 12)} (digest ${digest.slice(0, 12)})`);
  lines.push(`Patches, applied in this order: ${enabled.length}${patches.length > enabled.length ? ` (${patches.length - enabled.length} disabled)` : ''}`);
  let total = { added: 0, removed: 0, files: 0 };
  let k = 0;
  for (const p of patches) {
    if (!p.enabled) { lines.push(`  – ${p.subject} [${p.sha256.slice(0, 8)}] (disabled, not applied)`); continue; }
    const st = diffstat(p.content);
    total = { added: total.added + st.added, removed: total.removed + st.removed, files: total.files + st.files };
    const flags = results[k++]!.flags.map((f) => f.message);
    lines.push(`  ${k}. ${p.subject} [${p.sha256.slice(0, 8)}] ${st.files} file${st.files === 1 ? '' : 's'}, +${st.added} −${st.removed}${flags.length ? `; flagged: ${flags.join('; ')}` : ''}`);
  }
  lines.push(`Diffstat: ${total.files} file change${total.files === 1 ? '' : 's'}, +${total.added} −${total.removed}`);
  const full = enabled.map((p) => p.content).join('\n');
  const diff = full.length > DIALOG_DIFF_LIMIT ? `${full.slice(0, DIALOG_DIFF_LIMIT)}\n… (clipped: ${full.length} characters in all; the series is in the patch repository at ${rev.slice(0, 12)})` : full;
  return { binding, lines, diff, patches: enabled.length };
}

export const isSeriesError = (x: PreparedSeries | SeriesError): x is SeriesError => 'error' in x;

type AuditBy = Parameters<core.AuthServices['audit']['record']>[0]['by'];

/** The audit actor of a principal: its user, else the system. */
export function auditActor(principal: core.AccessPrincipal): AuditBy {
  if (principal.kind === 'user') return core.userAttribution({ userId: principal.userId });
  if (principal.kind === 'instance' && principal.userId) return core.userAttribution({ userId: principal.userId });
  return { kind: 'system' };
}

/** One patch lifecycle row (core PATCH_AUDIT_ACTIONS). Never throws; never patch contents. */
export async function auditPatch(
  audit: Pick<core.AuthServices['audit'], 'record'>, by: AuditBy, action: core.PatchAuditAction, appId: string,
  outcome: 'ok' | 'failed', detail: Record<string, unknown>,
): Promise<void> {
  await audit.record({ by, action, target: `app:${appId}`, outcome, detail }).catch(() => undefined);
}
