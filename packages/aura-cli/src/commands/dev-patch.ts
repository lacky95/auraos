/**
 * Change an installed app as a patch series (Track P, app-side).
 *
 *   aura dev patch start [app] [--base <ref>] [--new]
 *        a writable workspace at /mnt/aura/work/<app>: the upstream base plus
 *        the saved series, one commit per patch
 *   aura dev patch save -m <msg>     commit work in the workspace, then save the
 *        series (patches/NNNN-*.patch + aura-patches.yaml, one commit) into the
 *        patch repo /data/patches/<installationId>/
 *   aura dev patch list [app]        the series, the saved and the active revision
 *   aura dev patch remote [url]      the patch repo's remote (`--push` to share)
 *   aura dev patch activate [rev]    a fresh tree of base + series at <rev>,
 *        installed through the system (owner approval), restarted, rolled back
 *        when it does not come up
 *   aura dev update [app] [--ref]    the series on a new upstream; a patch that
 *        no longer applies is named, the owner notified, and nothing is installed
 *   aura dev patch clean [app] [--keep N] [--force]  delete old workspaces:
 *        never the bound one or the newest N; one in use in another Terminal
 *        or with unsaved work only with --force (which says what is lost)
 *
 * Activate and update build in one scratch workspace per user and
 * installation (its number in the patch repo's config), emptied each time.
 *
 * The series library is core patches/series.ts; the system routes are in
 * dev-source.ts. Git runs here, with this Terminal's credentials.
 */
import type { Command } from 'commander';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  applySeries, baseCommitIn, buildTree, exportPatches, gitError, readPatches, readSeries, safeDirectoryArgs, saveSeries,
  SeriesError, type ApplyResult, type Series, type SeriesBase,
} from '@aura/core';
import { api } from '../lib/client.js';
import { color, fail, info, ok, warn } from '../lib/format.js';
import { installWithChoices } from './nexus.js';
import type { RestartResult } from './app.js';
import {
  ACTIVE_REF, appFromArgOrCwd, bindWorkspace, cleanWorkspaces, detachWorkspace, findWorkspace, getAppSource, gitOut,
  patchRepoDir, readWorkspaceMarker, refuseBuiltIn, upstreamBase, writeWorkspaceMarker, type AppSourceView, type WorkspaceMarker,
} from './dev-source.js';

const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

function git(cwd: string, args: string[], timeout = 120_000): string {
  return execFileSync('git', [...safeDirectoryArgs(cwd), '-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'], timeout, env: GIT_ENV }).toString().trim();
}

function identity(cwd: string): string[] {
  return gitOut(cwd, ['config', 'user.email']) ? [] : ['-c', 'user.name=Aura', '-c', 'user.email=aura@aura.local'];
}

function seriesAt(repo: string, rev?: string): Series | null {
  if (!existsSync(join(repo, '.git'))) return null;
  try { return readSeries(repo, rev ?? 'HEAD'); }
  catch (err) { return fail((err as Error).message); }
}

function isEmptyDir(d: string): boolean {
  try { return readdirSync(d).length === 0; } catch { return true; }
}

function describeFailure(r: Extract<ApplyResult, { ok: false }>): string {
  const n = String(r.failed.index + 1).padStart(4, '0');
  return `patch ${n} "${r.failed.subject}" (${r.failed.file}) does not apply`
    + (r.conflicts.length ? ` — conflicts in ${r.conflicts.join(', ')}` : '')
    + (r.message ? color.dim(`\n    ${r.message}`) : '');
}

// ─── start ──────────────────────────────────────────────────────────────────

export interface StartResult { path: string; n: number; created: boolean; marker: WorkspaceMarker; apply: ApplyResult | null }

/**
 * Bind a workspace of `app` into this Terminal and, when it is empty, fill it:
 * clone the base, check it out, apply the saved series (stopping at a conflict
 * for the user to resolve). `base`: another upstream ref to start from (repair
 * after an update).
 */
export async function startWorkspace(app: string, opts: { base?: string; new?: boolean } = {}): Promise<StartResult> {
  const v = await getAppSource(app);
  refuseBuiltIn(v);
  const repo = patchRepoDir(v.installationId);
  const series = seriesAt(repo);
  const upstream = upstreamBase(v);
  const from: SeriesBase | null = series?.base ?? upstream;
  if (!from?.repository) {
    fail(`${v.appId} does not say where its source lives (no upstream repository${v.upstream?.commit ? '' : ' or commit'}) — `
      + 'its author publishes with `aura dev publish --repo <url>`; until then it cannot be patched');
  }
  let ws = await bindWorkspace(v.appId, opts.new ? { new: true } : {});
  // The build workspace of activate/update is no place to edit: a fresh one instead.
  if (readWorkspaceMarker(ws.path)?.scratch) ws = await bindWorkspace(v.appId, { new: true });
  const existing = readWorkspaceMarker(ws.path);
  if (existing) {
    if (opts.base) fail(`workspace ${ws.n} already exists at ${ws.path} — pass --new for a fresh one on ${opts.base}`);
    return { path: ws.path, n: ws.n, created: false, marker: existing, apply: null };
  }
  if (!isEmptyDir(ws.path)) fail(`${ws.path} is not empty and is no patch workspace — pass --new for a fresh one`);

  const target: SeriesBase = { ...from!, commit: opts.base ?? from!.commit };
  let baseCommit: string;
  try {
    execFileSync('git', ['clone', '-q', '--no-checkout', target.repository!, ws.path],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 600_000, env: GIT_ENV });
    // A ref (branch, tag) becomes the commit it names now.
    const real = gitOut(ws.path, ['rev-parse', '-q', '--verify', `${target.commit}^{commit}`])
      ?? gitOut(ws.path, ['rev-parse', '-q', '--verify', `origin/${target.commit}^{commit}`]);
    if (!real) fail(`'${target.commit}' is not a commit, tag or branch of ${target.repository}`);
    target.commit = real!;
    baseCommit = baseCommitIn(ws.path, target);
    git(ws.path, ['checkout', '-q', '-B', 'patches', baseCommit]);
  } catch (err) {
    if (err instanceof SeriesError) fail(err.message);
    throw err;
  }
  const patchesRev = series ? gitOut(repo, ['rev-parse', 'HEAD']) : null;
  const marker: WorkspaceMarker = { appId: v.appId, installationId: v.installationId, n: ws.n, base: target, baseCommit, patchesRev };
  writeWorkspaceMarker(ws.path, marker);
  const apply = series?.patches.length
    ? applySeries(ws.path, readPatches(repo, series, 'HEAD'), { keepConflict: true })
    : null;
  return { path: ws.path, n: ws.n, created: true, marker, apply };
}

// ─── save ───────────────────────────────────────────────────────────────────

export interface SavedPatches { repo: string; commit: string; changed: boolean; files: string[] }

/** Commit pending work in the workspace (with `message`), then save the series into the patch repo. */
export function saveWorkspace(wsRoot: string, message?: string): SavedPatches {
  const marker = readWorkspaceMarker(wsRoot);
  if (!marker) fail(`${wsRoot} is not a patch workspace`);
  if (marker!.scratch) fail(`${wsRoot} is the build workspace of activate/update — edit in your own (aura dev patch start)`);
  if (existsSync(join(wsRoot, '.git', 'rebase-apply'))) {
    fail('a patch is still being applied here — resolve the conflict, `git add` the files and run `git am --continue` (or `git am --skip` to drop it), then save');
  }
  if (gitOut(wsRoot, ['status', '--porcelain'])) {
    if (!message) fail('there are uncommitted changes — pass -m "<what changed>" to commit them as a patch');
    git(wsRoot, ['add', '-A']);
    git(wsRoot, [...identity(wsRoot), 'commit', '-q', '-m', message!]);
  }
  const patches = exportPatches(wsRoot, marker!.baseCommit);
  const repo = patchRepoDir(marker!.installationId);
  const subjects = patches.map((p) => p.subject);
  const r = saveSeries(repo, {
    app: marker!.appId, base: marker!.base, patches,
    message: message ?? `Save ${patches.length} patch${patches.length === 1 ? '' : 'es'}${subjects.length ? `: ${subjects[subjects.length - 1]}` : ''}`,
  });
  writeWorkspaceMarker(wsRoot, { ...marker!, patchesRev: r.commit });
  return { repo, commit: r.commit, changed: r.changed, files: patches.map((p) => p.file) };
}

// ─── clean ──────────────────────────────────────────────────────────────────

/**
 * What deleting this workspace would lose, compared with the patch repo: an
 * `am` in progress, uncommitted changes, commits whose patches are not the
 * saved ones it was made from or last saved as. Empty: nothing (an empty
 * dir, the scratch build workspace, or saved work). A non-empty dir that is
 * no patch workspace counts as unknown work.
 */
export function unsavedWork(wsRoot: string, repo: string): string[] {
  if (isEmptyDir(wsRoot)) return [];
  const marker = readWorkspaceMarker(wsRoot);
  if (!marker) return ['files that are no patch workspace'];
  if (marker.scratch) return [];
  const lost: string[] = [];
  if (existsSync(join(wsRoot, '.git', 'rebase-apply'))) lost.push('a patch being applied (git am)');
  const status = gitOut(wsRoot, ['status', '--porcelain']);
  if (status) {
    // `XY path`; gitOut trims, so the first line may have lost X's space.
    const files = status.split('\n').map((l) => l.replace(/^\s*\S{1,2}\s+/, ''));
    lost.push(`uncommitted changes in ${files.slice(0, 5).join(', ')}${files.length > 5 ? ` and ${files.length - 5} more` : ''}`);
  }
  let mine: Array<{ content: string }>;
  try { mine = exportPatches(wsRoot, marker.baseCommit); }
  catch { return [...lost, 'commits that could not be read']; }
  let saved: Array<{ content: string }> = [];
  try {
    const series = marker.patchesRev && existsSync(join(repo, '.git')) ? readSeries(repo, marker.patchesRev) : null;
    saved = series ? readPatches(repo, series, marker.patchesRev!) : [];
  } catch { saved = []; }
  const same = mine.length === saved.length && mine.every((p, i) => p.content === saved[i]!.content);
  if (!same) lost.push(`${mine.length} commit(s) whose patches are not saved in ${repo}`);
  return lost;
}

export interface CleanResult {
  deleted: number[]; kept: number[];
  /** Candidates kept because they are in use elsewhere or hold unsaved work (deleted with --force). */
  held: Array<{ n: number; why: string[] }>;
  force: boolean;
}

/**
 * `dev patch clean`: ask the system for the candidates, inspect each one not
 * in use here (bound briefly into this Terminal), then delete the safe ones —
 * or, with `force`, all of them, after `onLoss` was told what goes.
 */
export async function cleanApp(app: string, opts: { keep?: number; force?: boolean; onLoss?: (held: CleanResult['held']) => void } = {}): Promise<CleanResult> {
  const v = await getAppSource(app);
  const repo = patchRepoDir(v.installationId);
  const dry = await cleanWorkspaces(v.appId, { keep: opts.keep, dryRun: true });
  const held: CleanResult['held'] = dry.inUse.map((n) => ({ n, why: ['bound in another Terminal'] }));
  const inspect = dry.candidates.filter((n) => !dry.inUse.includes(n));
  try {
    for (const n of inspect) {
      const ws = await bindWorkspace(v.appId, { n });
      const why = unsavedWork(ws.path, repo);
      if (why.length) held.push({ n, why });
    }
  } finally {
    if (inspect.length) await rebind(v);
  }
  held.sort((a, b) => a.n - b.n);
  const force = opts.force === true;
  if (force && held.length) opts.onLoss?.(held);
  const heldNs = held.map((h) => h.n);
  const r = await cleanWorkspaces(v.appId, {
    keep: opts.keep, force, delete: force ? dry.candidates : dry.candidates.filter((n) => !heldNs.includes(n)),
  });
  return { deleted: r.deleted, kept: r.kept, held: force ? held.filter((h) => !r.deleted.includes(h.n)) : held, force };
}

// ─── activate / update ──────────────────────────────────────────────────────

export type ActivateOutcome =
  | { status: 'installed'; rev: string; restarted: string | null; workspace: number }
  | { status: 'rolled-back'; rev: string; reason: string }
  | { status: 'not-approved' | 'failed'; reason: string }
  | { status: 'needs-repair'; failure: Extract<ApplyResult, { ok: false }>; base: SeriesBase; name?: string };

interface ActivateResponse { ok?: boolean; error?: string; message?: string; running?: string[]; rollbackTree?: string | null; overlay?: boolean }

/** R4 with the approval and identity questions answered (nexus.ts installWithChoices). */
async function activateRoute(appId: string, body: Record<string, unknown>): Promise<ActivateResponse | null> {
  return await installWithChoices(`/api/apps/${encodeURIComponent(appId)}/activate`, body, {}, 'install') as ActivateResponse | null;
}

/**
 * Install workspace `n` (already holding base + series at `rev`), mark `rev`
 * active, restart running instances and health-check by that restart; a
 * restart that fails rolls back to the previous tree.
 */
export async function installWorkspace(v: AppSourceView, n: number, rev: string): Promise<ActivateOutcome> {
  const res = await activateRoute(v.appId, { workspace: n });
  if (!res) return { status: 'not-approved', reason: 'the owner did not approve the activation' };
  if (!res.ok) return { status: 'failed', reason: res.message ?? res.error ?? 'activation failed' };
  const repo = patchRepoDir(v.installationId);
  const previous = gitOut(repo, ['rev-parse', '-q', '--verify', ACTIVE_REF]);
  git(repo, ['update-ref', ACTIVE_REF, rev]);
  if (!res.running?.length) return { status: 'installed', rev, restarted: null, workspace: n };
  if (v.appId === 'com.aura.terminal' && process.env['APP_ID'] === 'com.aura.terminal') {
    warn('restarting the Terminal ends this session — run `aura restart app com.aura.terminal` when ready');
    return { status: 'installed', rev, restarted: null, workspace: n };
  }
  try {
    const r = await api.post<RestartResult>(`/api/apps/${encodeURIComponent(v.appId)}/restart`);
    return { status: 'installed', rev, restarted: r.instanceId, workspace: n };
  } catch (err) {
    const reason = (err as Error).message.split('\n')[0]!;
    const back = await activateRoute(v.appId, { rollback: true });
    if (back?.ok) {
      try { await api.post(`/api/apps/${encodeURIComponent(v.appId)}/restart`); } catch { /* reported below */ }
      git(repo, previous ? ['update-ref', ACTIVE_REF, previous] : ['update-ref', '-d', ACTIVE_REF]);
    }
    return { status: 'rolled-back', rev, reason: back?.ok ? reason : `${reason}; the rollback failed too: ${back?.message ?? back?.error ?? 'not approved'}` };
  }
}

/** The patch-repo config key of this user's scratch workspace number. */
const scratchKey = (v: AppSourceView) => `aura.${v.user ?? 'default'}.scratch`;

/**
 * This user's scratch workspace, bound and emptied: the one recorded in the
 * patch repo's config while it still exists and is not the workspace being
 * edited here, else a new one (recorded).
 */
async function scratchWorkspace(v: AppSourceView) {
  const repo = patchRepoDir(v.installationId);
  const known = Number(gitOut(repo, ['config', '--get', scratchKey(v)]));
  const reuse = Number.isInteger(known) && v.workspaces.includes(known) && known !== v.workspace?.n;
  const ws = await bindWorkspace(v.appId, reuse ? { n: known } : { new: true });
  if (reuse && !readWorkspaceMarker(ws.path)?.scratch && !isEmptyDir(ws.path)) {
    // Recorded, but someone made it a working workspace since: leave it alone.
    return bindScratch(v, repo, await bindWorkspace(v.appId, { new: true }));
  }
  return bindScratch(v, repo, ws);
}

function bindScratch(v: AppSourceView, repo: string, ws: Awaited<ReturnType<typeof bindWorkspace>>) {
  // Its contents, not the directory: that is the bind's mount point.
  for (const name of readdirSync(ws.path)) rmSync(join(ws.path, name), { recursive: true, force: true });
  if (existsSync(join(repo, '.git'))) git(repo, ['config', scratchKey(v), String(ws.n)]);
  return ws;
}

/** `base` + the series' patches, built in the scratch workspace. The bound workspace is restored afterwards by the caller. */
async function candidate(v: AppSourceView, base: SeriesBase, patches: Parameters<typeof applySeries>[1], rev: string | null) {
  const ws = await scratchWorkspace(v);
  let built: ReturnType<typeof buildTree>;
  try {
    built = buildTree(ws.path, base, patches);
  } catch (err) {
    if (err instanceof SeriesError) fail(err.message);
    throw err;
  }
  writeWorkspaceMarker(ws.path, {
    appId: v.appId, installationId: v.installationId, n: ws.n, base, baseCommit: built.baseCommit, patchesRev: rev, scratch: true,
  });
  return { ws, built };
}

/** Bind back the workspace this Terminal had, or detach the scratch one. */
async function rebind(v: AppSourceView): Promise<void> {
  await (v.workspace ? bindWorkspace(v.appId, { n: v.workspace.n }) : detachWorkspace(v.appId)).catch(() => undefined);
}

/** `dev patch activate [rev]`: base + series at `rev` (default: the last save), built fresh and installed. */
export async function activateRevision(app: string, rev?: string): Promise<ActivateOutcome> {
  const v = await getAppSource(app);
  refuseBuiltIn(v);
  const repo = patchRepoDir(v.installationId);
  const commit = existsSync(join(repo, '.git')) ? gitOut(repo, ['rev-parse', '-q', '--verify', `${rev ?? 'HEAD'}^{commit}`]) : null;
  if (!commit) fail(rev ? `'${rev}' is not a revision of ${repo}` : `nothing saved for ${v.appId} yet — aura dev patch start, change, aura dev patch save`);
  const series = seriesAt(repo, commit!)!;
  const active = gitOut(repo, ['rev-parse', '-q', '--verify', ACTIVE_REF]);
  if (active && active !== commit && !isAncestor(repo, active, commit!)) {
    warn(`the active revision ${active.slice(0, 12)} is not part of ${commit!.slice(0, 12)} — this replaces it`);
  }
  if (v.upstream?.commit && v.upstream.commit !== series.base.commit) {
    warn(`the series is based on ${series.base.commit.slice(0, 12)}, the install on ${v.upstream.commit.slice(0, 12)} — after an upstream update use aura dev update`);
  }
  const { ws, built } = await candidate(v, series.base, readPatches(repo, series, commit!), commit!);
  try {
    if (!built.ok) return { status: 'needs-repair', failure: built, base: series.base };
    return await installWorkspace(v, ws.n, commit!);
  } finally {
    await rebind(v);
  }
}

function isAncestor(repo: string, a: string, b: string): boolean {
  try { git(repo, ['merge-base', '--is-ancestor', a, b]); return true; } catch { return false; }
}

/** The commit `ref` names in `repository` now (ls-remote; a hash passes through). */
export function resolveRemoteRef(repository: string, ref: string): string {
  if (/^[0-9a-f]{40}$/.test(ref)) return ref;
  let out: string;
  try {
    out = execFileSync('git', ['ls-remote', repository, ref, `refs/heads/${ref}`, `refs/tags/${ref}^{}`, `refs/tags/${ref}`],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, env: GIT_ENV }).toString();
  } catch (err) {
    return fail(`could not read ${repository}: ${gitError(err)}`);
  }
  const lines = out.split('\n').filter(Boolean).map((l) => l.split('\t') as [string, string]);
  const pick = lines.find(([, r]) => r.endsWith('^{}')) ?? lines[0];
  if (!pick) fail(`'${ref}' is not a branch or tag of ${repository}`);
  return pick![0];
}

/**
 * `dev update`: put the saved series on a new upstream commit. Builds base +
 * patches fresh; a patch that does not apply is named and NOTHING is
 * installed. Otherwise the re-based series is saved (new base, refreshed
 * patch files) and that revision activated.
 */
export async function updateSeries(app: string, opts: { ref?: string; activate?: boolean } = {}): Promise<ActivateOutcome | { status: 'current'; commit: string } | { status: 'saved'; rev: string }> {
  const v = await getAppSource(app);
  refuseBuiltIn(v);
  const repo = patchRepoDir(v.installationId);
  const series = seriesAt(repo);
  if (!series?.patches.length) fail(`${v.appId} has no saved patches — update it with aura nexus app update ${v.appId}`);
  const base = series!.base;
  if (!base.repository) fail('the series has no upstream repository to update from');
  // The new upstream: --ref; a system app's is the release checkout the system reports; else the branch tip.
  const target = opts.ref
    ? resolveRemoteRef(base.repository!, opts.ref)
    : (v.scope === 'system' || v.overlay) && v.upstream?.commit
      ? v.upstream.commit
      : resolveRemoteRef(base.repository!, v.upstream?.branch ?? 'HEAD');
  if (target === base.commit) return { status: 'current', commit: target };
  const newBase: SeriesBase = { ...base, commit: target };
  const { ws, built } = await candidate(v, newBase, readPatches(repo, series!, 'HEAD'), gitOut(repo, ['rev-parse', 'HEAD']));
  try {
    if (!built.ok) return { status: 'needs-repair', failure: built, base: newBase, name: v.name };
    // Patch files regenerated on the new base (context lines moved), one commit.
    const r = saveSeries(repo, {
      app: series!.app, base: newBase, patches: exportPatches(ws.path, built.baseCommit),
      message: `Update base ${base.commit.slice(0, 12)} → ${target.slice(0, 12)}`,
    });
    if (opts.activate === false) return { status: 'saved', rev: r.commit };
    return await installWorkspace(v, ws.n, r.commit);
  } finally {
    await rebind(v);
  }
}

const repairCommand = (appId: string, base: SeriesBase) => `aura dev patch start ${appId} --new --base ${base.commit.slice(0, 12)}`;

/**
 * Tell the owner an update left a patch in need of repair (D7): a
 * notification in the desktop through the notifications API, sent with this
 * Terminal's instance token. Best effort: the CLI output says it all too.
 */
export async function notifyNeedsRepair(appId: string, out: Extract<ActivateOutcome, { status: 'needs-repair' }>): Promise<boolean> {
  const f = out.failure;
  const n = String(f.failed.index + 1).padStart(4, '0');
  const app = out.name && out.name !== appId ? `${out.name} (${appId})` : appId;
  try {
    await api.post('/api/notifications', {
      title: `Patch needs repair: ${out.name ?? appId}`,
      text: [
        `${app}: patch ${n} "${f.failed.subject}" (${f.failed.file}) no longer applies to upstream ${out.base.commit.slice(0, 12)}.`,
        f.conflicts.length ? `Conflicts in ${f.conflicts.join(', ')}.` : '',
        'Nothing was installed; the current version keeps running.',
        `Repair in a Terminal: ${repairCommand(appId, out.base)}, fix the conflict, git am --continue, aura dev patch save, aura dev patch activate.`,
      ].filter(Boolean).join(' '),
      priority: 'high',
    });
    return true;
  } catch (err) {
    warn(`could not notify the owner: ${(err as Error).message.split('\n')[0]}`);
    return false;
  }
}

function reportOutcome(appId: string, out: Awaited<ReturnType<typeof updateSeries>>): void {
  switch (out.status) {
    case 'current':     info(`the series already is on ${out.commit.slice(0, 12)} — nothing to do`); return;
    case 'saved':       ok(`series saved on the new base as ${out.rev.slice(0, 12)} — activate with aura dev patch activate`); return;
    case 'installed':
      ok(`activated ${out.rev.slice(0, 12)} (workspace ${out.workspace})${out.restarted ? `, restarted as ${out.restarted}` : ''}`);
      return;
    case 'rolled-back': process.exitCode = 1; warn(`activated ${out.rev.slice(0, 12)} but it did not come up (${out.reason}) — rolled back to the previous tree`); return;
    case 'not-approved':
    case 'failed':      process.exitCode = 1; warn(`not activated: ${out.reason}`); return;
    case 'needs-repair':
      process.exitCode = 1;
      warn(`needs repair: ${describeFailure(out.failure)}`);
      info(`nothing was installed; ${appId} keeps running as it is.`);
      info(`repair: ${color.cyan(repairCommand(appId, out.base))}, fix the conflict, git am --continue, aura dev patch save, then activate`);
  }
}

// ─── commands ───────────────────────────────────────────────────────────────

export function registerDevPatch(dev: Command): void {
  const patch = dev.command('patch').description('Change an installed app as a versioned patch series (workspace, save, activate).');

  patch
    .command('start [app]')
    .option('--base <ref>', 'Start from this upstream commit, tag or branch instead of the series\' base (repair after an update)')
    .option('--new',        'A fresh workspace even when one exists')
    .description('Bind a writable workspace of the app into this Terminal: its upstream base plus the saved patches.')
    .action(async (app: string | undefined, o: { base?: string; new?: boolean }) => {
      const r = await startWorkspace(appFromArgOrCwd(app), o);
      if (!r.created) ok(`workspace ${r.n} is bound at ${color.bold(r.path)}`);
      else ok(`workspace ${r.n} at ${color.bold(r.path)} — base ${r.marker.base.commit.slice(0, 12)}${r.apply?.ok ? ` + ${r.apply.applied} saved patch(es)` : ''}`);
      if (r.apply && !r.apply.ok) {
        warn(describeFailure(r.apply));
        info(`resolve it in ${r.path}: fix the files, git add them, git am --continue (or git am --skip to drop the patch)`);
      }
      info(`edit and test there, then: ${color.cyan('aura dev patch save -m "<what changed>"')} and ${color.cyan('aura dev patch activate')}`);
    });

  patch
    .command('save')
    .option('-m, --message <msg>', 'Commit message for uncommitted changes (the patch subject)')
    .option('-C, --workspace <dir>', 'The workspace (default: the one this directory is in)')
    .description('Commit the workspace and save its patches + aura-patches.yaml as one commit in the patch repo.')
    .action((o: { message?: string; workspace?: string }) => {
      const ws = findWorkspace(o.workspace ?? process.cwd());
      if (!ws) fail('not in a patch workspace — cd to /mnt/aura/work/<app> (aura dev patch start <app>)');
      const r = saveWorkspace(ws!.root, o.message);
      if (!r.changed) { info(`nothing new — the series is saved as ${r.commit.slice(0, 12)}`); return; }
      ok(`saved ${r.files.length} patch(es) as ${r.commit.slice(0, 12)} in ${r.repo}`);
      for (const f of r.files) console.log(`  ${f}`);
      info(`install it: ${color.cyan('aura dev patch activate')}`);
    });

  patch
    .command('list [app]')
    .alias('ls')
    .option('--json', 'Print JSON')
    .description('The saved series: base, patches, the saved and the active revision, the remote.')
    .action(async (app: string | undefined, o: { json?: boolean }) => {
      const v = await getAppSource(appFromArgOrCwd(app));
      const repo = patchRepoDir(v.installationId);
      const series = seriesAt(repo);
      const head = series ? gitOut(repo, ['rev-parse', 'HEAD']) : null;
      const active = series ? gitOut(repo, ['rev-parse', '-q', '--verify', ACTIVE_REF]) : null;
      const remote = series ? gitOut(repo, ['remote', 'get-url', 'origin']) : null;
      if (o.json) { console.log(JSON.stringify({ appId: v.appId, repo, head, active, remote, series }, null, 2)); return; }
      if (!series) { info(`no patches saved for ${v.appId} (${repo})`); return; }
      console.log(`${color.bold(v.appId)}  ${color.dim(repo)}`);
      console.log(`  base:   ${series.base.repository ?? ''} @ ${series.base.commit.slice(0, 12)}${series.base.path ? ` (${series.base.path})` : ''}`);
      series.patches.forEach((p) => console.log(`  ${p.file}  ${color.dim(p.subject)}`));
      console.log(`  saved:  ${head?.slice(0, 12)}   active: ${active ? active.slice(0, 12) : color.dim('(none)')}${active && active !== head ? color.yellow('  (not activated yet)') : ''}`);
      console.log(`  remote: ${remote ?? color.dim('(none — aura dev patch remote <url>)')}`);
    });

  patch
    .command('remote [url]')
    .option('--push', 'Push the patch repo to its remote (your git credentials)')
    .option('--app <app>', 'The app (default: from this directory)')
    .description('Show or set the patch repo\'s remote, to share the customization; --push pushes it.')
    .action(async (url: string | undefined, o: { push?: boolean; app?: string }) => {
      const v = await getAppSource(appFromArgOrCwd(o.app));
      const repo = patchRepoDir(v.installationId);
      if (!existsSync(join(repo, '.git'))) fail(`no patches saved for ${v.appId} yet`);
      if (url) {
        if (url.startsWith('-')) fail('invalid url');
        git(repo, ['remote', gitOut(repo, ['remote', 'get-url', 'origin']) === null ? 'add' : 'set-url', 'origin', url]);
        ok(`remote of ${repo}: ${url}`);
      } else if (!o.push) {
        console.log(gitOut(repo, ['remote', 'get-url', 'origin']) ?? color.dim('(none)'));
      }
      if (o.push) {
        try { git(repo, ['push', '-u', 'origin', 'main'], 300_000); }
        catch (err) { fail(`push failed: ${gitError(err)}`); }
        ok('pushed main');
      }
    });

  patch
    .command('clean [app]')
    .option('--keep <n>', 'How many of the newest workspaces to keep, besides the bound one', '3')
    .option('--force',    'Also delete workspaces in use in another Terminal or holding unsaved work (says what is lost first)')
    .description('Delete your old patch workspaces of the app: never the one bound here or the newest N; in-use or unsaved ones only with --force.')
    .action(async (app: string | undefined, o: { keep: string; force?: boolean }) => {
      const keep = Number(o.keep);
      if (!Number.isInteger(keep) || keep < 0) fail('--keep takes a whole number from 0');
      const r = await cleanApp(appFromArgOrCwd(app), {
        keep, force: o.force === true,
        onLoss: (held) => {
          warn('--force: this work is lost with them:');
          for (const h of held) console.log(`  workspace ${h.n}: ${h.why.join('; ')}`);
        },
      });
      if (r.deleted.length) ok(`deleted workspace(s) ${r.deleted.join(', ')}`);
      else info('nothing deleted');
      console.log(`  kept: ${r.kept.join(', ') || color.dim('(none)')}`);
      if (r.held.length) {
        console.log('  kept (in use / unsaved):');
        for (const h of r.held) console.log(`    ${h.n}: ${h.why.join('; ')}`);
        if (!r.force) info(`save the work (aura dev patch save), or pass ${color.cyan('--force')} to delete them anyway`);
      }
    });

  patch
    .command('activate [rev]')
    .option('--app <app>', 'The app (default: from this directory)')
    .description('Build base + the series at <rev> (default: the last save) fresh, install it (owner approval), restart, roll back on failure.')
    .action(async (rev: string | undefined, o: { app?: string }) => {
      const appId = appFromArgOrCwd(o.app);
      reportOutcome(appId, await activateRevision(appId, rev));
    });

  dev
    .command('update [app]')
    .option('--ref <ref>',    'Upstream commit, tag or branch to move to (default: the upstream branch tip; system apps: the running release)')
    .option('--no-activate',  'Only save the series on the new base')
    .description('Apply the saved patches to a new upstream and activate; a patch that no longer applies is named and nothing is installed.')
    .action(async (app: string | undefined, o: { ref?: string; activate?: boolean }) => {
      const appId = appFromArgOrCwd(app);
      const out = await updateSeries(appId, o);
      reportOutcome(appId, out);
      if (out.status === 'needs-repair' && await notifyNeedsRepair(appId, out)) info('the owner was notified');
    });
}
