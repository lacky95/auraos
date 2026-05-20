/**
 * Git fetcher — v1's primary install path. Shells out to git for two
 * operations:
 *   1. `git ls-remote` to resolve a branch/tag name into a commit SHA
 *      (used by the resolver so the install record carries an exact
 *      digest, not a moving reference).
 *   2. `git clone --depth=1 [--branch <ref>]` to populate the staging dir.
 *
 * Removes the `.git/` directory from the staged dir before handing off to
 * the installer — apps shouldn't ship their VCS metadata into `apps/<id>/`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export interface GitRef {
  /** https URL (the resolver prepends https:// to bare github.com/user/foo). */
  url: string;
  /** Branch, tag or commit. Optional — defaults to remote's HEAD. */
  ref?: string;
}

/**
 * Resolve a Git ref to a concrete commit SHA. Returns null if the ref
 * can't be resolved (caller decides whether to error or fall back).
 */
export function resolveGitCommit(g: GitRef): string | null {
  try {
    // `git ls-remote <url> <ref>` lists matching refs as `<sha>\t<refname>`.
    // Omitting <ref> dumps everything; the line tagged `HEAD` is the
    // default branch's tip.
    const args = ['ls-remote', g.url];
    if (g.ref) args.push(g.ref);
    const out = execFileSync('git', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
    }).toString().trim();
    if (!out) return null;
    // First non-empty line — first token is the SHA.
    const line = out.split('\n')[0]!;
    return line.split(/\s+/)[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Clone the ref shallowly into stagingDir. Falls back to a regular clone
 * if the shallow path fails (some hosts disable shallow on tags).
 */
export async function fetchGit(g: GitRef, stagingDir: string): Promise<void> {
  // git clone --depth 1 [--branch <ref>] <url> <stagingDir>
  const args = ['clone', '--depth', '1'];
  if (g.ref) args.push('--branch', g.ref);
  args.push(g.url, stagingDir);
  try {
    execFileSync('git', args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
  } catch (err) {
    // Some hosts won't shallow-clone a tag. Retry without --depth.
    if (existsSync(stagingDir)) rmSync(stagingDir, { recursive: true, force: true });
    const fallbackArgs = ['clone'];
    if (g.ref) fallbackArgs.push('--branch', g.ref);
    fallbackArgs.push(g.url, stagingDir);
    try {
      execFileSync('git', fallbackArgs, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 240_000 });
    } catch (err2) {
      throw new Error(`[NexusGitFetcher] clone failed for ${g.url}${g.ref ? '#' + g.ref : ''}: ${(err2 as Error).message}`);
    }
  }
  // Strip the .git dir — apps ship without VCS metadata.
  const gitDir = join(stagingDir, '.git');
  if (existsSync(gitDir)) rmSync(gitDir, { recursive: true, force: true });
}
