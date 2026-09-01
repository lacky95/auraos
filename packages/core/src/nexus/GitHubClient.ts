/**
 * The minimum of GitHub's REST API needed to open a store submission PR,
 * plus the token resolution that feeds it.
 *
 * No octokit: four endpoints and a fork poll do not justify a dependency, and
 * `fetch` is global on Node 22. This matches how the rest of Nexus talks to
 * the network (`CatalogAggregator` uses bare `fetch` too).
 *
 * ── On auth ──────────────────────────────────────────────────────────────
 * `gh` is used ONLY as a way to obtain a token, never as an implementation.
 * The obvious reading of "use gh if it's there" is to shell out to `gh pr
 * create` on one path and call REST on the other — two code paths, two sets of
 * failure modes, and a bug that reproduces on only one machine. Since `gh auth
 * token` simply prints the token it already holds, taking it and using the
 * same REST path everywhere collapses that to one implementation with two
 * sources for a string.
 *
 * `gh` could not do more than this anyway: `gh auth login` is an interactive
 * browser/device flow that cannot run inside an API route, and `gh` is not in
 * the AuraOS image — it is opt-in toolchain (`aura cap install gh`).
 */

import { execFileSync } from 'node:child_process';

const API = 'https://api.github.com';

export interface GitHubRepoInfo {
  owner:          string;
  repo:           string;
  defaultBranch:  string;
  /** True when the authenticated user may push directly (owner mode). */
  canPush:        boolean;
}

export interface TokenResolution {
  token:  string;
  /** Where it came from, for `nexus store status` and error messages. */
  origin: 'gh' | 'context';
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Remediation to print — kept with the error so callers cannot forget it. */
    readonly hint?: string,
  ) { super(message); this.name = 'GitHubError'; }
}

/**
 * Read a token from `gh`, if `gh` is installed AND already authenticated.
 * Returns null otherwise — an unauthenticated or absent `gh` is not an error,
 * it just means we fall through to Aura Context.
 */
export function tokenFromGh(): string | null {
  try {
    const out = execFileSync('gh', ['auth', 'token'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
      encoding: 'utf8',
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Resolve a token: `gh` first (zero setup for anyone who already uses it),
 * then the `GITHUB_TOKEN` Aura Context entry.
 *
 * `readContextToken` is injected rather than imported so this module stays free
 * of ContextStore — it is the piece a future UI would reuse, and ContextStore
 * is server-internal.
 */
export async function resolveGitHubToken(
  readContextToken: () => Promise<string | null>,
): Promise<TokenResolution> {
  const fromGh = tokenFromGh();
  if (fromGh) return { token: fromGh, origin: 'gh' };

  const fromContext = await readContextToken();
  if (fromContext) return { token: fromContext, origin: 'context' };

  throw new GitHubError(
    'no GitHub token available',
    0,
    'Either run `gh auth login` (if you use the GitHub CLI), '
    + 'or store a token with `aura nexus store login`. '
    + 'A fine-grained token needs Contents and Pull requests: read and write.',
  );
}

export class GitHubClient {
  constructor(private readonly token: string) {}

  private async call<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; data: T }> {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization:          `Bearer ${this.token}`,
        Accept:                 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent':           'AuraOS-Nexus',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });

    const text = await res.text();
    let data: unknown = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }

    if (!res.ok) {
      const msg = (data as { message?: string } | null)?.message ?? text.slice(0, 200);
      throw new GitHubError(`${method} ${path} → ${res.status}: ${msg}`, res.status, hintFor(res, path));
    }
    return { status: res.status, data: data as T };
  }

  /** The authenticated login — needed for the PR head ref in fork mode. */
  async whoami(): Promise<string> {
    const { data } = await this.call<{ login: string }>('GET', '/user');
    return data.login;
  }

  /**
   * Repo metadata plus whether we can push to it.
   *
   * `permissions` is only present on an AUTHENTICATED request. A missing
   * object therefore means the token did not apply — treat that as an auth
   * failure rather than quietly concluding "not my repo, so fork", which would
   * turn a bad token into a confusing fork attempt against someone else's
   * account.
   */
  async repoInfo(owner: string, repo: string): Promise<GitHubRepoInfo> {
    const { data } = await this.call<{
      default_branch: string;
      permissions?: { push?: boolean };
    }>('GET', `/repos/${owner}/${repo}`);

    if (!data.permissions) {
      throw new GitHubError(
        `no permissions returned for ${owner}/${repo} — the request was not authenticated`,
        401,
        'The token was rejected or is missing repository access.',
      );
    }
    return {
      owner, repo,
      defaultBranch: data.default_branch,
      canPush:       data.permissions.push === true,
    };
  }

  /** Does a repo exist and can we see it? */
  async repoExists(owner: string, repo: string): Promise<boolean> {
    try {
      await this.call('GET', `/repos/${owner}/${repo}`);
      return true;
    } catch (err) {
      if (err instanceof GitHubError && err.status === 404) return false;
      throw err;
    }
  }

  /**
   * Fork `owner/repo` into the authenticated account and wait for it to be
   * usable. Forking is asynchronous on GitHub's side, so a fork that 202s is
   * not yet clonable; polling is the documented approach.
   */
  async ensureFork(owner: string, repo: string, login: string): Promise<void> {
    if (await this.repoExists(login, repo)) return;
    await this.call('POST', `/repos/${owner}/${repo}/forks`);
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 2_000));
      if (await this.repoExists(login, repo)) return;
    }
    throw new GitHubError(
      `fork of ${owner}/${repo} did not become available in time`,
      0,
      'Forking is asynchronous; try again in a moment.',
    );
  }

  /** The open PR for a head ref, if one exists. */
  async findOpenPr(
    owner: string, repo: string, head: string,
  ): Promise<{ number: number; html_url: string } | null> {
    const { data } = await this.call<Array<{ number: number; html_url: string }>>(
      'GET', `/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(head)}`,
    );
    return data[0] ?? null;
  }

  async createPr(
    owner: string, repo: string,
    opts: { title: string; body: string; head: string; base: string },
  ): Promise<{ number: number; html_url: string }> {
    const { data } = await this.call<{ number: number; html_url: string }>(
      'POST', `/repos/${owner}/${repo}/pulls`, opts,
    );
    return data;
  }

  async updatePr(
    owner: string, repo: string, number: number,
    opts: { title?: string; body?: string },
  ): Promise<{ number: number; html_url: string }> {
    const { data } = await this.call<{ number: number; html_url: string }>(
      'PATCH', `/repos/${owner}/${repo}/pulls/${number}`, opts,
    );
    return data;
  }
}

/** Turn the common HTTP failures into something a user can act on. */
function hintFor(res: Response, path: string): string | undefined {
  if (res.status === 401) {
    return 'The token is invalid or expired. Re-run `gh auth login`, or replace it with `aura nexus store login`.';
  }
  if (res.status === 403) {
    if (res.headers.get('x-ratelimit-remaining') === '0') {
      const reset = res.headers.get('x-ratelimit-reset');
      const when = reset ? new Date(Number(reset) * 1000).toISOString() : 'shortly';
      return `GitHub rate limit reached; it resets at ${when}.`;
    }
    return 'The token lacks the scopes this needs: Contents and Pull requests, read and write '
      + '(classic tokens: `public_repo`). Forking also needs access to your own account.';
  }
  if (res.status === 404 && path.startsWith('/repos/')) {
    return 'The repository does not exist, or the token cannot see it.';
  }
  return undefined;
}

/** Split an `owner/repo` (or a full GitHub URL) into its parts. */
export function parseRepoSlug(slug: string): { owner: string; repo: string } {
  const cleaned = slug
    .trim()
    .replace(/^git@github\.com:/, '')
    .replace(/^https?:\/\/(www\.)?github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
  const parts = cleaned.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`'${slug}' is not an owner/repo slug (e.g. lacky95/auraos-store)`);
  }
  return { owner: parts[0], repo: parts[1] };
}
