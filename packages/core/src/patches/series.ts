/**
 * Patch series: a customization kept as an ordered list of git patches on top
 * of a base commit, in a small git repository of its own (the patch repo).
 *
 *   <patch repo>/
 *     aura-patches.yaml        app, base { repository, commit, path? }, patches[]
 *     patches/0001-<slug>.patch  `git format-patch` output, applied in order
 *
 * One library for both kinds of patch (D53): app patches (`aura dev patch …`,
 * repo at /data/patches/<installationId>/) and, later, system patches
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
import { basename, join, resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { MOUNT_ROOT_PATH, WORK_DIR_NAME } from '../app-manager/MountManager.js';

export const SERIES_FILE = 'aura-patches.yaml';
export const PATCHES_DIR = 'patches';

const BaseSchema = z.object({
  /** Clone URL of the upstream repo (absent: a base only this machine has). */
  repository: z.string().min(1).optional(),
  /** Upstream commit the series applies to. */
  commit:     z.string().regex(/^[0-9a-f]{7,64}$/, 'a commit hash'),
  /** Subdirectory of the repo that is the app (monorepo apps). */
  path:       z.string().min(1).refine((p) => !p.startsWith('/') && !p.split('/').includes('..'), 'a relative path').optional(),
});

const PatchSchema = z.object({
  file:    z.string().regex(/^patches\/[^/]+\.patch$/, 'patches/<name>.patch'),
  subject: z.string(),
});

export const SeriesSchema = z.object({
  app:     z.string().min(1),
  base:    BaseSchema,
  patches: z.array(PatchSchema).default([]),
});

export type SeriesBase  = z.infer<typeof BaseSchema>;
export type SeriesPatch = z.infer<typeof PatchSchema>;
export type Series      = z.infer<typeof SeriesSchema>;

export class SeriesError extends Error {}

// Nobody can answer a credential prompt here.
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };

/** Where app patch repos live (`aura dev`, one per installation). */
export const patchesRoot = (): string => process.env['AURA_PATCHES_DIR'] ?? '/data/patches';

/**
 * Git refuses a repo another user owns ("dubious ownership"). The shell
 * creates workspace directories (as root, on the app-data volume) that the
 * Terminal's git then works in, and either side may open a patch repo the
 * other made. Exactly these trees are trusted, each by its own path on the
 * command line (`-c safe.directory=<top>`: protected config, written nowhere):
 * a patch repo, a workspace bound into a Terminal (`/mnt/aura/work/<app>`)
 * and a workspace in the shell (`<dataDir>/aura/workspaces/...`). Any other
 * repo keeps git's check.
 */
export function safeDirectoryArgs(dir: string): string[] {
  const top = resolve(dir);
  const roots = [patchesRoot(), join(MOUNT_ROOT_PATH, WORK_DIR_NAME), join(process.env['AURA_DATA_DIR'] ?? '/data', 'aura', 'workspaces')];
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
  const r = SeriesSchema.safeParse(doc);
  if (!r.success) {
    throw new SeriesError(`${SERIES_FILE}: ${r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
  }
  return r.data;
}

export function formatSeries(s: Series): string {
  const base: SeriesBase = {
    ...(s.base.repository ? { repository: s.base.repository } : {}),
    commit: s.base.commit,
    ...(s.base.path ? { path: s.base.path } : {}),
  };
  return stringify({ app: s.app, base, patches: s.patches.map((p) => ({ file: p.file, subject: p.subject })) });
}

/** The series in a patch repo, at `rev` (a commit) or in the work tree. null: no series yet. */
export function readSeries(repoDir: string, rev?: string): Series | null {
  if (rev) {
    const text = tryGitRaw(repoDir, ['show', `${rev}:${SERIES_FILE}`]);
    return text === null ? null : parseSeries(text);
  }
  const p = join(repoDir, SERIES_FILE);
  return existsSync(p) ? parseSeries(readFileSync(p, 'utf-8')) : null;
}

function tryGitRaw(cwd: string, args: string[]): string | null {
  try { return git(cwd, args); } catch { return null; }
}

/** The patch files of a series, as text, from the repo at `rev` (or the work tree). */
export function readPatches(repoDir: string, series: Series, rev?: string): Array<SeriesPatch & { content: string }> {
  return series.patches.map((p) => {
    const content = rev ? tryGitRaw(repoDir, ['show', `${rev}:${p.file}`]) : readFileOr(join(repoDir, p.file));
    if (content === null) throw new SeriesError(`${p.file} is listed in ${SERIES_FILE} but missing${rev ? ` at ${rev.slice(0, 12)}` : ''}`);
    return { ...p, content };
  });
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

export interface ExportedPatch extends SeriesPatch { content: string }

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
export function saveSeries(repoDir: string, input: { app: string; base: SeriesBase; patches: ExportedPatch[]; message: string }): SaveResult {
  const series: Series = { app: input.app, base: input.base, patches: input.patches.map(({ file, subject }) => ({ file, subject })) };
  mkdirSync(join(repoDir, PATCHES_DIR), { recursive: true });
  const fresh = !existsSync(join(repoDir, '.git'));
  if (fresh) git(repoDir, ['init', '-q', '-b', 'main']);
  for (const f of readdirSync(join(repoDir, PATCHES_DIR))) {
    if (f.endsWith('.patch')) rmSync(join(repoDir, PATCHES_DIR, f));
  }
  for (const p of input.patches) writeFileSync(join(repoDir, p.file), p.content);
  writeFileSync(join(repoDir, SERIES_FILE), formatSeries(series));
  git(repoDir, ['add', '-A', '--', SERIES_FILE, PATCHES_DIR]);
  const staged = tryGitRaw(repoDir, ['diff', '--cached', '--name-only']);
  if (!fresh && !staged?.trim()) {
    return { commit: git(repoDir, ['rev-parse', 'HEAD']).trim(), changed: false, series };
  }
  try {
    git(repoDir, [...identityArgs(repoDir), 'commit', '-q', '-m', input.message]);
  } catch (err) {
    throw new SeriesError(`commit in ${repoDir} failed: ${gitError(err)}`);
  }
  return { commit: git(repoDir, ['rev-parse', 'HEAD']).trim(), changed: true, series };
}

export type ApplyResult =
  | { ok: true; applied: number; head: string }
  | {
      ok: false;
      applied: number;
      /** The first patch that does not apply, 0-based in the series. */
      failed: SeriesPatch & { index: number };
      /** Files with conflicts (three-way merge), when git named them. */
      conflicts: string[];
      message: string;
      /** true: the work tree was left mid-`git am` for repair (`keepConflict`). */
      inProgress: boolean;
    };

/**
 * Apply patches in order onto the work tree's HEAD with `git am --3way`, one
 * commit per patch. Stops at the first patch that does not apply and names
 * it. That patch is backed out (HEAD = the patches before it), unless
 * `keepConflict`: then the work tree stays in the `git am` session with the
 * conflict markers, for someone to fix and `git am --continue`.
 */
export function applySeries(workTree: string, patches: Array<SeriesPatch & { content: string }>, opts: { keepConflict?: boolean } = {}): ApplyResult {
  const dir = mkdtempSync(join(tmpdir(), 'aura-apply-'));
  const id = identityArgs(workTree);
  try {
    for (let i = 0; i < patches.length; i++) {
      const p = patches[i]!;
      const file = join(dir, basename(p.file));
      writeFileSync(file, p.content);
      try {
        git(workTree, [...id, 'am', '-q', '--3way', '--keep-cr', file]);
      } catch (err) {
        const conflicts = (tryGitRaw(workTree, ['diff', '--name-only', '--diff-filter=U']) ?? '').split('\n').filter(Boolean);
        const message = gitError(err);
        if (!opts.keepConflict) tryGit(workTree, [...id, 'am', '--abort']);
        return { ok: false, applied: i, failed: { ...p, index: i }, conflicts, message, inProgress: !!opts.keepConflict };
      }
    }
    return { ok: true, applied: patches.length, head: git(workTree, ['rev-parse', 'HEAD']).trim() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A fresh tree of `base` + the series at `rev` of the patch repo, in `dir`:
 * what activation installs and an update tries on a new base. On a patch
 * that does not apply, the result names it and the tree is unusable.
 */
export function buildTree(dir: string, base: SeriesBase, patches: Array<SeriesPatch & { content: string }>): ApplyResult & { baseCommit: string } {
  const baseCommit = checkoutBase(dir, base);
  return { ...applySeries(dir, patches), baseCommit };
}
