/**
 * Where an app's source lives, and turning an installed app back into a git
 * checkout of it.
 *
 * Published bundles never carry `.git` (PublishFiles' deny list, and the git
 * fetcher strips it on install): history, remotes and anything ever committed
 * would ship to every installer. Instead a release says where it came from:
 *
 *   • `manifest.repository` — the author's declaration (opt-in): the repo the
 *     app is developed in. Publish stamps the branch and commit it was built
 *     from into the RELEASED manifest (`stampManifest`), so an installed app
 *     says exactly where it came from.
 *   • `.nexus-published.json` — written into every published bundle (git and
 *     OCI). Its `source` block records the repo and the exact commit the
 *     release was built from, and whether the tree had uncommitted changes.
 *   • OCI annotations `org.opencontainers.image.source` / `.revision` — the
 *     same pair, readable from the registry without pulling the bundle.
 *
 * `checkoutApp` uses that to make an installed app ready for development:
 * init `.git` in place, fetch the repo, and point HEAD at the release commit
 * without touching the app's files (only publish's stamp in app.manifest.json
 * is undone). An app with a `.git` is a dev checkout;
 * Nexus refuses to update or replace it unless forced (NexusManager).
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppManifest } from '../types/manifest.js';

/** Marker written into every published bundle (git work tree and OCI tarball). */
export const PUBLISH_MARKER = '.nexus-published.json';

/** The `source` block of the publish marker. */
export interface AppSourceInfo {
  /** Clone URL of the repo the release was built from. */
  repository?: string;
  /** Branch the author develops on (manifest.repository.branch, or the checked-out branch). */
  branch?:     string;
  /** Commit the release was built from. */
  commit?:     string;
  /** The tree had uncommitted changes, so `commit` is only the closest match. */
  dirty?:      boolean;
}

export interface PublishMarker {
  publishedBy:      'aura-nexus';
  publishedAt:      string;
  publishedVersion: string;
  source?:          AppSourceInfo;
}

// Runs inside the shell, where nobody can answer a prompt: a repo that needs
// credentials must fail at once instead of hanging until the timeout.
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

function git(cwd: string, args: string[], timeout = 15_000): string {
  return execFileSync('git', ['-C', cwd, ...args],
    { stdio: ['ignore', 'pipe', 'pipe'], timeout, env: GIT_ENV }).toString().trim();
}

function tryGit(cwd: string, args: string[], timeout?: number): string | null {
  try { return git(cwd, args, timeout) || null; } catch { return null; }
}

/**
 * Turn what an author writes (`gitlab.com/owner/repo`, an https URL, or
 * `git@host:owner/repo`) into something `git clone` takes. SSH stays SSH.
 */
export function cloneUrl(s: string): string {
  const t = s.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t) || /^[^@\s]+@[^:\s]+:/.test(t) || t.startsWith('/')) return t;
  return `https://${t.replace(/\/+$/, '')}${t.endsWith('.git') ? '' : '.git'}`;
}

/**
 * What a publish of `appPath` should record about its source. The repo is the
 * manifest's `repository.url`, else the local checkout's `origin`. Commit and
 * dirty only exist when `appPath` is inside a git work tree. Never throws.
 */
export function readAppSource(appPath: string, manifest: AppManifest): AppSourceInfo {
  const out: AppSourceInfo = {};
  const inTree = tryGit(appPath, ['rev-parse', '--is-inside-work-tree']) === 'true';
  const declared = manifest.repository?.url;
  const origin = inTree ? tryGit(appPath, ['remote', 'get-url', 'origin']) : null;
  const repo = declared ?? origin;
  if (repo) out.repository = cloneUrl(repo);
  // The branch actually published from; the declared one when detached.
  const branch = (inTree ? tryGit(appPath, ['symbolic-ref', '--short', '-q', 'HEAD']) : null)
    ?? manifest.repository?.branch;
  if (branch) out.branch = branch;
  if (inTree) {
    const commit = tryGit(appPath, ['rev-parse', 'HEAD']);
    if (commit) {
      out.commit = commit;
      // Only this app's part of the tree counts (monorepo apps).
      const status = tryGit(appPath, ['status', '--porcelain', '--', '.']);
      if (status) out.dirty = true;
    }
  }
  return out;
}

export function buildPublishMarker(manifest: AppManifest, source: AppSourceInfo, now = new Date()): PublishMarker {
  return {
    publishedBy:      'aura-nexus',
    publishedAt:      now.toISOString(),
    publishedVersion: manifest.version,
    ...(Object.keys(source).length ? { source } : {}),
  };
}

/**
 * The released `app.manifest.json`: when the app declares `repository` and the
 * publish knows its commit, `repository.branch` + `.commit` are set to it.
 * Edits the file's own JSON, not the parsed manifest, so no schema defaults
 * are written and key order and indentation are kept. null when there is
 * nothing to stamp.
 */
export function stampManifest(rawManifest: string, source: AppSourceInfo): string | null {
  if (!source.commit) return null;
  let doc: Record<string, unknown>;
  try { doc = JSON.parse(rawManifest) as Record<string, unknown>; } catch { return null; }
  const repo = doc['repository'];
  if (!repo || typeof repo !== 'object' || Array.isArray(repo)) return null;
  const r = repo as Record<string, unknown>;
  if (source.branch) r['branch'] = source.branch;
  r['commit'] = source.commit;
  const indent = /^([ \t]+)"/m.exec(rawManifest)?.[1] ?? '  ';
  return JSON.stringify(doc, null, indent) + (rawManifest.endsWith('\n') ? '\n' : '');
}

/** The publish marker of an installed (or staged) app, or null. */
export function readPublishMarker(appDir: string): PublishMarker | null {
  try {
    const m = JSON.parse(readFileSync(join(appDir, PUBLISH_MARKER), 'utf-8')) as PublishMarker;
    return m && typeof m === 'object' ? m : null;
  } catch {
    return null;
  }
}

/** An app dir that has its own `.git` — a dev checkout Nexus must not overwrite. */
export function isDevCheckout(appDir: string): boolean {
  return existsSync(join(appDir, '.git'));
}

export interface CheckoutStatus {
  repository: string | null;
  branch:     string | null;
  head:       string | null;
  /** Files that differ from HEAD (`git status --porcelain`), capped. */
  changes:    string[];
}

function checkoutStatus(appDir: string): CheckoutStatus {
  // Untrimmed: porcelain's first column is often a space (` M file`).
  let porcelain = '';
  try {
    porcelain = execFileSync('git', ['-C', appDir, 'status', '--porcelain'],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000, env: GIT_ENV }).toString();
  } catch { /* not a work tree */ }
  const changes = porcelain.split('\n').filter(Boolean);
  return {
    repository: tryGit(appDir, ['remote', 'get-url', 'origin']),
    branch:     tryGit(appDir, ['symbolic-ref', '--short', '-q', 'HEAD']),
    head:       tryGit(appDir, ['rev-parse', '--short', 'HEAD']),
    changes:    changes.slice(0, 50),
  };
}

export interface CheckoutOpts {
  /** Repo to use instead of what the app declares. */
  repository?: string;
  /** Commit, tag or branch to put HEAD on, instead of the release commit. */
  ref?:        string;
  /** Branch to create locally (default: the declared branch, else the remote's default). */
  branch?:     string;
}

export interface CheckoutResult extends CheckoutStatus {
  /** false: the app already was a checkout; nothing was changed. */
  created:  boolean;
  /** What HEAD was put on, and how it was chosen. */
  target?:  { ref: string; how: 'flag' | 'release-commit' | 'version-tag' | 'branch' };
  /** Where the repository came from. */
  repoFrom?: 'flag' | 'manifest' | 'release' | 'publish.repo';
  warnings: string[];
}

/**
 * Publish stamped `repository.branch`/`.commit` into the released manifest; the
 * repo keeps them empty. Put the repo's version back when that stamp is the
 * ONLY difference, so a fresh checkout is clean and the stamp never gets
 * committed. Any other edit to the manifest is left alone.
 */
function unstampManifest(appDir: string): void {
  const strip = (raw: string): string | null => {
    try {
      const doc = JSON.parse(raw) as Record<string, unknown>;
      const repo = doc['repository'];
      if (repo && typeof repo === 'object') {
        delete (repo as Record<string, unknown>)['commit'];
        delete (repo as Record<string, unknown>)['branch'];
      }
      return JSON.stringify(doc);
    } catch { return null; }
  };
  const committed = tryGitRaw(appDir, ['show', 'HEAD:app.manifest.json']);
  if (committed === null) return;
  let onDisk: string;
  try { onDisk = readFileSync(join(appDir, 'app.manifest.json'), 'utf-8'); } catch { return; }
  if (onDisk === committed) return;
  const a = strip(committed);
  if (a !== null && a === strip(onDisk)) writeFileSync(join(appDir, 'app.manifest.json'), committed);
}

function tryGitRaw(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000, env: GIT_ENV }).toString();
  } catch { return null; }
}

/** Which repo an installed app says it is developed in, and why. */
export function resolveAppRepository(
  manifest: AppManifest, marker: PublishMarker | null, flag?: string,
): { url: string; from: NonNullable<CheckoutResult['repoFrom']> } | null {
  if (flag) return { url: cloneUrl(flag), from: 'flag' };
  if (manifest.repository?.url) return { url: cloneUrl(manifest.repository.url), from: 'manifest' };
  if (marker?.source?.repository) return { url: cloneUrl(marker.source.repository), from: 'release' };
  // Older apps put their source repo here; it is the git-publish target, so
  // only a fallback.
  if (manifest.publish?.repo) return { url: cloneUrl(manifest.publish.repo), from: 'publish.repo' };
  return null;
}

/**
 * Make `appDir` a git checkout of its source repo, in place. The files are
 * left exactly as installed: `.git` is created, the repo fetched, and HEAD set
 * to the release commit (else the `v<version>` tag, else the branch tip) with
 * a mixed reset, so any difference between the release and that commit shows
 * up as local changes rather than being overwritten. The one file it may
 * write: app.manifest.json, back to the repo's version when publish's
 * repository stamp is all that differs. Idempotent: an app that
 * already has `.git` is only reported on.
 */
export function checkoutApp(appDir: string, manifest: AppManifest, opts: CheckoutOpts = {}): CheckoutResult {
  if (isDevCheckout(appDir)) {
    return { ...checkoutStatus(appDir), created: false, warnings: [] };
  }
  const marker = readPublishMarker(appDir);
  const repo = resolveAppRepository(manifest, marker, opts.repository);
  if (!repo) {
    throw new Error(`${manifest.id} does not say where its source lives — set "repository": { "url": … } in its manifest, or pass a repository`);
  }
  const warnings: string[] = [];
  if (repo.from === 'publish.repo') {
    warnings.push(`using publish.repo (${repo.url}) as the source repo — declare it as "repository" in the manifest`);
  }

  try {
    git(appDir, ['init', '-q']);
    git(appDir, ['remote', 'add', 'origin', repo.url]);
    try {
      git(appDir, ['fetch', '--tags', 'origin'], 300_000);
    } catch (err) {
      const msg = ((err as { stderr?: Buffer }).stderr?.toString() || (err as Error).message).trim().split('\n').pop();
      throw new Error(`could not fetch ${repo.url}: ${msg} (private repos need git credentials in the master container)`);
    }
    // origin/HEAD tells us the remote's default branch.
    tryGit(appDir, ['remote', 'set-head', 'origin', '--auto']);
    const remoteDefault = tryGit(appDir, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'])?.replace(/^origin\//, '') ?? null;
    const branch = opts.branch ?? manifest.repository?.branch ?? marker?.source?.branch ?? remoteDefault ?? 'main';
    // The release's commit: stamped into its manifest, else in its marker
    // (apps that do not declare `repository` but were published from a clone).
    const declared = manifest.repository?.commit || null;
    const released = declared
      ? { commit: declared, dirty: marker?.source?.commit === declared && !!marker.source.dirty }
      : marker?.source?.commit && (!marker.source.repository || cloneUrl(marker.source.repository) === repo.url)
        ? { commit: marker.source.commit, dirty: !!marker.source.dirty }
        : null;

    const has = (ref: string) => tryGit(appDir, ['rev-parse', '-q', '--verify', `${ref}^{commit}`]);
    let target: CheckoutResult['target'];
    let commit: string | null = null;
    if (opts.ref) {
      commit = has(opts.ref) ?? has(`origin/${opts.ref}`);
      if (!commit) throw new Error(`'${opts.ref}' is not a commit, tag or branch in ${repo.url}`);
      target = { ref: opts.ref, how: 'flag' };
    }
    if (!commit && released) {
      commit = has(released.commit);
      if (commit) {
        target = { ref: released.commit.slice(0, 12), how: 'release-commit' };
        if (released.dirty) warnings.push('the release was published with uncommitted changes — they show up as local changes');
      } else {
        warnings.push(`release commit ${released.commit.slice(0, 12)} is not in ${repo.url} (unpushed?)`);
      }
    }
    if (!commit) {
      const tag = `v${manifest.version}`;
      commit = has(`refs/tags/${tag}`);
      if (commit) target = { ref: tag, how: 'version-tag' };
    }
    if (!commit) {
      commit = has(`origin/${branch}`);
      if (!commit) throw new Error(`branch '${branch}' does not exist in ${repo.url}`);
      target = { ref: `origin/${branch}`, how: 'branch' };
      warnings.push(`no release commit or tag v${manifest.version} found — HEAD is on the tip of ${branch}; check the local changes`);
    }

    // Not `git checkout`: every installed file is untracked at this point and
    // checkout refuses to overwrite them. Point the branch at the commit and
    // rebuild only the index (mixed reset); the working tree is never written.
    git(appDir, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
    git(appDir, ['update-ref', `refs/heads/${branch}`, commit]);
    git(appDir, ['reset', '-q'], 60_000);
    unstampManifest(appDir);
    if (has(`origin/${branch}`)) tryGit(appDir, ['branch', '-q', `--set-upstream-to=origin/${branch}`, branch]);
    // The publish marker belongs to the release, not to the repo.
    try { appendFileSync(join(appDir, '.git', 'info', 'exclude'), `\n${PUBLISH_MARKER}\n`); } catch { /* cosmetic */ }
    return { ...checkoutStatus(appDir), created: true, target, repoFrom: repo.from, warnings };
  } catch (err) {
    // Leave the app as it was: no half-made checkout that blocks updates.
    rmSync(join(appDir, '.git'), { recursive: true, force: true });
    throw err;
  }
}
