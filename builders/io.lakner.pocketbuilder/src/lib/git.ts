/**
 * Reading a project's git state.
 *
 * Lives here rather than in the API route because the project page renders it
 * SERVER-SIDE. That matters: the panel used to depend entirely on client
 * JavaScript to populate itself, so anything that stopped that script — a
 * stale document, a hung request, a bundle that failed to load — left the user
 * staring at a loading message with no way out and no explanation. The server
 * already has everything needed to answer the question, so it answers it in
 * the HTML, and the client script becomes an enhancement (refresh, commit,
 * push) rather than a prerequisite.
 *
 * `POST /api/projects/git` and the page both call `readGitStatus`, so the two
 * can never disagree about what "status" means.
 */

import { git, type RunTarget } from './docker.ts';

export interface GitStatus {
  repo:   boolean;
  branch: string | null;
  files:  Array<{ code: string; path: string }>;
  remote: string | null;
  head:   string | null;
}

export interface GitStatusResult {
  status: GitStatus;
  /** Which transport answered — 'exec' (project running) or 'helper'. */
  via:    'exec' | 'helper';
  /** Set when git itself failed for a reason other than "not a repo". */
  error:  string | null;
}

const EMPTY: GitStatus = { repo: false, branch: null, files: [], remote: null, head: null };

/** Parse `git status --porcelain=v1 -b`. */
export function parseStatus(stdout: string): Pick<GitStatus, 'branch' | 'files'> {
  const lines = stdout.split('\n').filter(Boolean);
  let branch: string | null = null;
  const files: GitStatus['files'] = [];
  for (const line of lines) {
    if (line.startsWith('## ')) {
      // "## main...origin/main [ahead 1]" → "main"
      branch = line.slice(3).split('...')[0]!.split(' ')[0] ?? null;
      continue;
    }
    files.push({ code: line.slice(0, 2).trim() || '??', path: line.slice(3) });
  }
  return { branch, files };
}

export async function readGitStatus(target: RunTarget): Promise<GitStatusResult> {
  const st = await git(target, ['status', '--porcelain=v1', '-b'], 60_000);

  if (!st.ok) {
    // "Not a repository yet" is a state the UI renders, not an error.
    if (/not a git repository/i.test(st.stderr)) {
      return { status: EMPTY, via: st.via, error: null };
    }
    return { status: EMPTY, via: st.via, error: st.stderr.trim() || `git status exited ${st.code}` };
  }

  const { branch, files } = parseStatus(st.stdout);
  const [remote, head] = await Promise.all([
    git(target, ['remote', 'get-url', 'origin'], 30_000),
    git(target, ['log', '-1', '--pretty=%h %s'], 30_000),
  ]);

  return {
    status: {
      repo:   true,
      branch,
      files,
      remote: remote.ok ? remote.stdout.trim() : null,
      head:   head.ok ? head.stdout.trim() : null,
    },
    via:   st.via,
    error: null,
  };
}
