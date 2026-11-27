/**
 * Patch series: a customization kept as an ordered list of git patches on top
 * of a base commit, in a small git repository of its own (the patch repo).
 *
 *   <patch repo>/
 *     aura-patches.json        v: 2 (JSON; the old aura-patches.yaml is read until the next save migrates it), target, base { repository, commit, path?, release? },
 *                              patches[{ file, subject, sha256, enabled }]
 *     patches/0001-<slug>.patch  `git format-patch` output, applied in order
 *
 * v2 (Phase 7): a target (an app or the system), each patch's sha256 and an
 * enabled flag; the series digest (digest.ts) is what an approval binds. A
 * file without `v` is v1 (`app: <id>`) and reads as v2 (target app, sha256
 * computed, enabled); every save writes v2. Every patch is validated
 * (validate.ts) on save and before it is applied.
 *
 * One library for both kinds of patch (D53): app patches (`aura dev patch …`,
 * repo: the app-data volume's aura/patches/<installationId>, bound at
 * /mnt/aura/patches/<appId>) and, later, system patches
 * (/data/patches/system/). It only knows git and the series file; where the
 * repo lives, who approves and how a patched tree is installed belong to the
 * caller.
 *
 * A base with `path` is a subdirectory of its repository (a system app in the
 * AuraOS monorepo): the tree at `commit:path` becomes a deterministic local
 * root commit, so patches are relative to the app root while the clone keeps
 * the full history for three-way merges.
 *
 * Git runs here, in this process's environment — with the caller's
 * credentials for clone and push. Never throws on a patch that does not
 * apply: that is a result (`applySeries` names the patch).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { MOUNT_ROOT_PATH, PATCHES_DIR_NAME, WORK_DIR_NAME } from '../app-manager/contracts.js';
import { amApply } from './apply.js';
import { seriesDigest, sha256Hex } from './digest.js';
import { formatSeriesText, LEGACY_SERIES_FILE, normalizeSeriesDoc, PATCHES_DIR, SERIES_FILE } from './seriesFile.js';

export { LEGACY_SERIES_FILE, PATCHES_DIR, SERIES_FILE };
import type { ApplyResult, PatchTarget, Series, SeriesBase, SeriesPatch } from './types.js';
import { validatePatch, type PatchValidation } from './validate.js';

/** The app a series patches, or null for a system series. */
export const seriesAppId = (s: Series): string | null => (s.target.kind === 'app' ? s.target.appId : null);

export class SeriesError extends Error {}

// Nobody can answer a credential prompt here.
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };

/**
 * Tests only: a local root for patch repos (`<root>/<installationId>`)
 * instead of the one the shell binds into the Terminal at
 * `/mnt/aura/patches/<appId>` (the app-data volume's `aura/patches/<installationId>`).
 */
export const patchesOverride = (): string | null => process.env['AURA_PATCHES_DIR'] || null;

/**
 * Git refuses a repo another user owns ("dubious ownership"). The shell
 * creates workspace and patch-repo directories (as root, on the app-data
 * volume) that the Terminal's git then works in, and either side may open a
 * patch repo the other made. Exactly these trees are trusted, each by its own
 * path on the command line (`-c safe.directory=<top>`: protected config,
 * written nowhere): a workspace or patch repo bound into a Terminal
 * (`/mnt/aura/work/<app>`, `/mnt/aura/patches/<app>`), the same dirs in the
 * shell (`<dataDir>/aura/workspaces/...`, `<dataDir>/aura/patches/...`), the
 * system patch store (`<dataDir>/patches/system`, 7b), and the tests'
 * override root. Any other repo keeps git's check.
 */
export function safeDirectoryArgs(dir: string): string[] {
  const top = resolve(dir);
  const data = process.env['AURA_DATA_DIR'] ?? '/data';
  const override = patchesOverride();
  const roots = [
    join(MOUNT_ROOT_PATH, WORK_DIR_NAME), join(MOUNT_ROOT_PATH, PATCHES_DIR_NAME),
    join(data, 'aura', 'workspaces'), join(data, 'aura', 'patches'), join(data, 'patches', 'system'),
    ...(override ? [override] : []),
  ];
  return roots.some((r) => top.startsWith(`${resolve(r)}/`)) ? ['-c', `safe.directory=${top}`] : [];
}

function git(cwd: string, args: string[], opts: { timeout?: number; env?: NodeJS.ProcessEnv } = {}): string {
  return execFileSync('git', [...safeDirectoryArgs(cwd), '-C', cwd, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'], timeout: opts.timeout ?? 60_000, env: opts.env ?? GIT_ENV, maxBuffer: 64 * 1024 * 1024,
  }).toString();
}

function tryGit(cwd: string, args: string[]): string | null {
  try { return git(cwd, args).trim() || null; } catch { return null; }
}

/** The last line of a failed git call's stderr, for messages. */
export function gitError(err: unknown): string {
  const e = err as { stderr?: Buffer | string; message?: string };
  const text = (e.stderr ? e.stderr.toString() : '') || e.message || String(err);
  return text.trim().split('\n').filter(Boolean).slice(-3).join(' ');
}

/** `-c user.*` for a commit when git has no identity configured (fresh containers). */
function identityArgs(cwd: string): string[] {
  return tryGit(cwd, ['config', 'user.email'])
    ? []
    : ['-c', 'user.name=Aura', '-c', 'user.email=aura@aura.local'];
}

// ─── series file ────────────────────────────────────────────────────────────

export function parseSeries(text: string): Series {
  let doc: unknown;
  try { doc = parse(text); } catch (err) { throw new SeriesError(`${SERIES_FILE}: ${(err as Error).message}`); }
  try { return normalizeSeriesDoc(doc); } catch (err) { throw new SeriesError((err as Error).message); }
}

/** The series file text: always v2, written as JSON (which is YAML): seriesFile.ts. */
export const formatSeries = (s: Series): string => formatSeriesText(s);

/** The series in a patch repo, at `rev` (a commit) or in the work tree. null: no series yet. */
export function readSeries(repoDir: string, rev?: string): Series | null {
  // aura-patches.json (7b on); before the one-time migration, the old aura-patches.yaml (full YAML parser).
  for (const name of [SERIES_FILE, LEGACY_SERIES_FILE]) {
    if (rev) {
      const text = tryGitRaw(repoDir, ['show', `${rev}:${name}`]);
      if (text !== null) return parseSeries(text);
      continue;
    }
    const p = join(repoDir, name);
    if (existsSync(p)) return parseSeries(readFileSync(p, 'utf-8'));
  }
  return null;
}

function tryGitRaw(cwd: string, args: string[]): string | null {
  try { return git(cwd, args); } catch { return null; }
}

export type LoadedPatch = SeriesPatch & { content: string; sha256: string; enabled: boolean };

/**
 * The patch files of a series, as text, from the repo at `rev` (or the work
 * tree), each with its sha256. A recorded sha256 that does not match the file
 * is refused: the series was changed outside `saveSeries`.
 */
export function readPatches(repoDir: string, series: Series, rev?: string): LoadedPatch[] {
  return series.patches.map((p) => {
    const content = rev ? tryGitRaw(repoDir, ['show', `${rev}:${p.file}`]) : readFileOr(join(repoDir, p.file));
    if (content === null) throw new SeriesError(`${p.file} is listed in ${SERIES_FILE} but missing${rev ? ` at ${rev.slice(0, 12)}` : ''}`);
    const sha256 = sha256Hex(content);
    if (p.sha256 && p.sha256 !== sha256) throw new SeriesError(`${p.file} does not match its sha256 in ${SERIES_FILE}`);
    return { ...p, content, sha256, enabled: p.enabled !== false };
  });
}

/** A series at `rev` with its patches and digest: what an activation of `rev` binds. */
export function loadSeries(repoDir: string, rev: string): { series: Series; patches: LoadedPatch[]; digest: string } | null {
  const series = readSeries(repoDir, rev);
  if (!series) return null;
  const patches = readPatches(repoDir, series, rev);
  return { series, patches, digest: seriesDigest({ target: series.target, base: series.base, patches }) };
}

/**
 * Validate each patch for `target` (validate.ts); throws a SeriesError naming
 * every refused patch. Returns each patch's result (flags for the approval).
 */
export function assertPatchesValid(target: PatchTarget, patches: Array<Pick<SeriesPatch, 'file'> & { content: string }>): PatchValidation[] {
  const results = patches.map((p) => validatePatch(p.content, { target }));
  const bad = results.flatMap((r, i) => r.refused.map((f) => `${patches[i]!.file}: ${f.message}`));
  if (bad.length) throw new SeriesError(`refused patch content: ${bad.join('; ')}`);
  return results;
}

function readFileOr(p: string): string | null {
  try { return readFileSync(p, 'utf-8'); } catch { return null; }
}

// ─── repositories ───────────────────────────────────────────────────────────

/**
 * `git init -b main` plus one commit of everything in `dir` (honouring its
 * .gitignore). Used for a new app (`aura dev new`) and a new patch repo.
 * A dir that already is a repo is left alone. Returns the commit, or null
 * when the dir already was a repo.
 */
export function initRepo(dir: string, message: string): string | null {
  if (existsSync(join(dir, '.git'))) return null;
  mkdirSync(dir, { recursive: true });
  try {
    git(dir, ['init', '-q', '-b', 'main']);
    git(dir, ['add', '-A']);
    git(dir, [...identityArgs(dir), 'commit', '-q', '--allow-empty', '-m', message]);
    return git(dir, ['rev-parse', 'HEAD']).trim();
  } catch (err) {
    rmSync(join(dir, '.git'), { recursive: true, force: true });
    throw new SeriesError(`git init in ${dir} failed: ${gitError(err)}`);
  }
}

/**
 * The commit to put a work tree on for `base`, in `repoDir` (a clone that has
 * `base.commit`): the commit itself, or — with `base.path` — a root commit of
 * that subtree. The synthetic commit has fixed metadata, so the same base
 * gives the same hash in every clone.
 */
export function baseCommitIn(repoDir: string, base: SeriesBase): string {
  const commit = tryGit(repoDir, ['rev-parse', '-q', '--verify', `${base.commit}^{commit}`]);
  if (!commit) throw new SeriesError(`base commit ${base.commit.slice(0, 12)} is not in ${base.repository ?? repoDir}`);
  if (!base.path) return commit;
  const tree = tryGit(repoDir, ['rev-parse', '-q', '--verify', `${commit}:${base.path}`]);
  if (!tree) throw new SeriesError(`${base.path} does not exist at ${commit.slice(0, 12)}`);
  const fixed = {
    ...GIT_ENV,
    GIT_AUTHOR_NAME: 'Aura', GIT_AUTHOR_EMAIL: 'aura@aura.local', GIT_AUTHOR_DATE: '1970-01-01T00:00:00Z',
    GIT_COMMITTER_NAME: 'Aura', GIT_COMMITTER_EMAIL: 'aura@aura.local', GIT_COMMITTER_DATE: '1970-01-01T00:00:00Z',
  };
  return git(repoDir, ['commit-tree', tree, '-m', `aura base: ${commit}:${base.path}`], { env: fixed }).trim();
}

/**
 * Clone `base.repository` into `dir` (empty or missing) and check out the
 * base, detached. Full history, so `git am --3way` finds the blobs a patch
 * was made against. Returns the local base commit (see baseCommitIn).
 */
export function checkoutBase(dir: string, base: SeriesBase, opts: { timeout?: number } = {}): string {
  if (!base.repository) throw new SeriesError('the base has no repository to clone');
  mkdirSync(dir, { recursive: true });
  try {
    execFileSync('git', ['clone', '-q', '--no-checkout', base.repository, dir],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: opts.timeout ?? 600_000, env: GIT_ENV });
  } catch (err) {
    throw new SeriesError(`could not clone ${base.repository}: ${gitError(err)}`);
  }
  // A commit that is on no branch (e.g. only tagged) may need its own fetch.
  if (!tryGit(dir, ['rev-parse', '-q', '--verify', `${base.commit}^{commit}`])) {
    try { git(dir, ['fetch', '-q', 'origin', base.commit], { timeout: opts.timeout ?? 600_000 }); } catch { /* reported below */ }
  }
  const commit = baseCommitIn(dir, base);
  git(dir, ['checkout', '-q', '--detach', commit]);
  return commit;
}

// ─── save and apply ─────────────────────────────────────────────────────────

export interface ExportedPatch { file: string; subject: string; content: string; enabled?: boolean }

/**
 * The commits `baseCommit..HEAD` of `workTree` as patch files, in order
 * (`git format-patch`, without the commit hash or version signature so the
 * same change gives the same file).
 */
export function exportPatches(workTree: string, baseCommit: string): ExportedPatch[] {
  const out = mkdtempSync(join(tmpdir(), 'aura-patches-'));
  try {
    git(workTree, ['format-patch', '-q', '--zero-commit', '--no-signature', '--no-numbered', '-o', out, `${baseCommit}..HEAD`]);
    return readdirSync(out).filter((f) => f.endsWith('.patch')).sort().map((f) => {
      const content = readFileSync(join(out, f), 'utf-8');
      return { file: `${PATCHES_DIR}/${f}`, subject: subjectOf(content) ?? f, content };
    });
  } catch (err) {
    throw new SeriesError(`git format-patch failed: ${gitError(err)}`);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** The Subject of a format-patch file, without `[PATCH]`, unfolded. */
function subjectOf(patch: string): string | null {
  const m = /^Subject: (.*(?:\n[ \t].*)*)/m.exec(patch);
  return m ? m[1]!.replace(/\n[ \t]/g, ' ').replace(/^\[PATCH[^\]]*\]\s*/, '').trim() : null;
}

export interface SaveResult {
  /** Patch repo commit holding this series. */
  commit:  string;
  /** false: the series was already saved exactly so; nothing was committed. */
  changed: boolean;
  series:  Series;
}

/**
 * Write `patches` as the series on `base` into the patch repo and commit the
 * patch files and the series file together (one commit = one revision of
 * the customization). Creates the repo on first use. Old patch files not in
 * the new series are removed.
 */
export function saveSeries(repoDir: string, input: { target: PatchTarget; base: SeriesBase; patches: ExportedPatch[]; message: string }): SaveResult {
  assertPatchesValid(input.target, input.patches);
  const series: Series = {
    v: 2, target: input.target, base: input.base,
    patches: input.patches.map(({ file, subject, content, enabled }) => ({ file, subject, sha256: sha256Hex(content), enabled: enabled !== false })),
  };
  mkdirSync(join(repoDir, PATCHES_DIR), { recursive: true });
  const fresh = !existsSync(join(repoDir, '.git'));
  if (fresh) git(repoDir, ['init', '-q', '-b', 'main']);
  for (const f of readdirSync(join(repoDir, PATCHES_DIR))) {
    if (f.endsWith('.patch')) rmSync(join(repoDir, PATCHES_DIR, f));
  }
  for (const p of input.patches) writeFileSync(join(repoDir, p.file), p.content);
  writeFileSync(join(repoDir, SERIES_FILE), formatSeries(series));
  // The one-time migration: the old YAML file goes in the same commit that writes the JSON one.
  const migrated = existsSync(join(repoDir, LEGACY_SERIES_FILE));
  if (migrated) rmSync(join(repoDir, LEGACY_SERIES_FILE));
  git(repoDir, ['add', '-A', '--', SERIES_FILE, PATCHES_DIR, ...(migrated ? [LEGACY_SERIES_FILE] : [])]);
  const staged = tryGitRaw(repoDir, ['diff', '--cached', '--name-only']);
  if (!fresh && !staged?.trim()) {
    return { commit: git(repoDir, ['rev-parse', 'HEAD']).trim(), changed: false, series };
  }
  try {
    git(repoDir, [...identityArgs(repoDir), 'commit', '-q', '-m', migrated ? `${input.message}\n\nMigrated ${LEGACY_SERIES_FILE} to ${SERIES_FILE} (7b).` : input.message]);
  } catch (err) {
    throw new SeriesError(`commit in ${repoDir} failed: ${gitError(err)}`);
  }
  return { commit: git(repoDir, ['rev-parse', 'HEAD']).trim(), changed: true, series };
}

/**
 * Apply patches in order onto the work tree's HEAD with `git am --3way`, one
 * commit per patch. Stops at the first patch that does not apply and names
 * it. That patch is backed out (HEAD = the patches before it), unless
 * `keepConflict`: then the work tree stays in the `git am` session with the
 * conflict markers, for someone to fix and `git am --continue`.
 */
export function applySeries(
  workTree: string, patches: Array<SeriesPatch & { content: string }>,
  opts: { keepConflict?: boolean; target?: PatchTarget } = {},
): ApplyResult {
  // Disabled patches stay in the series but are not applied; the rest are validated first.
  const active = patches.map((p, index) => ({ p, index })).filter(({ p }) => p.enabled !== false);
  assertPatchesValid(opts.target ?? { kind: 'app', appId: '' }, active.map(({ p }) => p));
  return amApply(workTree, patches, { keepConflict: opts.keepConflict, gitArgs: safeDirectoryArgs(workTree), env: GIT_ENV });
}

/**
 * A fresh tree of `base` + the series at `rev` of the patch repo, in `dir`:
 * what activation installs and an update tries on a new base. On a patch
 * that does not apply, the result names it and the tree is unusable.
 */
export function buildTree(
  dir: string, base: SeriesBase, patches: Array<SeriesPatch & { content: string }>, opts: { target?: PatchTarget } = {},
): ApplyResult & { baseCommit: string } {
  const baseCommit = checkoutBase(dir, base);
  return { ...applySeries(dir, patches, opts), baseCommit };
}
