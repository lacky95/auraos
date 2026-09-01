import type { APIRoute } from 'astro';
import {
  getAppManager, getNexusManager, submitToStore, resolveGitHubToken,
  loadSourcesConfig, OFFICIAL_INDEX_URL, OFFICIAL_STORE_REPO,
  ContextStore, GitHubError, SubmitError, GitHubClient, parseRepoSlug,
  type StoreEntryCtx,
} from '@aura/core';
import { jsonResponse, errorResponse } from '../../../lib/appResponse.js';

const OS_API_BASE = process.env['OS_API_BASE'] ?? 'http://localhost:3000';

/**
 * Submit an app to the curated store index by opening a pull request.
 *
 * Server-side rather than CLI-side because of the credential: the fallback
 * token lives in `ContextStore`, whose `get()` is server-internal by design and
 * whose values `/api/os/context` deliberately never returns. Reading it from
 * the CLI would mean either adding a secret-disclosing endpoint — a real
 * regression — or depending on `/run/context`, which only exists inside the
 * master container and not when the CLI runs from a sandbox.
 *
 * Body:
 *   {
 *     manifest:  AppManifest,          // read + validated CLI-side
 *     source:    { kind:'git'|'oci', ref: string, defaultBranch?: string },
 *     channel:   string,
 *     tag:       string,
 *     storeRepo?: string,              // owner/repo; default: the official store
 *     category?:  string,              // override an unmappable manifest category
 *     dryRun?, updateMetadata?, noCodeowners?, force?, acceptPolicy?: boolean
 *   }
 */
export const POST: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => ({})) as {
    manifest?: unknown;
    source?:   { kind?: 'git' | 'oci'; ref?: string; defaultBranch?: string };
    channel?:  string;
    tag?:      string;
    storeRepo?: string;
    category?:  string;
    dryRun?: boolean; updateMetadata?: boolean; noCodeowners?: boolean;
    force?: boolean; acceptPolicy?: boolean;
  };

  if (!body.manifest || typeof body.manifest !== 'object') {
    return errorResponse('missing `manifest`', 400);
  }
  if (!body.source?.kind || !body.source.ref) {
    return errorResponse('missing `source.kind` / `source.ref`', 400);
  }
  if (!body.tag) return errorResponse('missing `tag`', 400);

  const storeRepo = body.storeRepo ?? (await resolveStoreRepo());
  const messages: string[] = [];

  try {
    // A dry run against a public store needs no credential at all — that is
    // what makes it a useful pre-flight before anyone has set a token up. So
    // resolve the token lazily and tolerate its absence here.
    let token: string | undefined;
    try {
      const t = await resolveGitHubToken(readContextToken);
      token = t.token;
      messages.push(`token from ${t.origin === 'gh' ? 'gh auth' : 'Aura Context'}`);
    } catch (err) {
      if (!body.dryRun) throw err;
      messages.push('no GitHub token — dry run only');
    }

    const entryCtx: StoreEntryCtx = {
      source: body.source.kind === 'git'
        ? { kind: 'git', ref: body.source.ref, defaultBranch: body.source.defaultBranch }
        : { kind: 'oci', ref: body.source.ref },
      channel: body.channel ?? 'stable',
      tag:     body.tag,
      ...(body.category ? { categoryOverride: body.category } : {}),
    };

    const result = await submitToStore({
      manifest: body.manifest as Parameters<typeof submitToStore>[0]['manifest'],
      entryCtx,
      storeRepo,
      token,
      dataDir: getAppManager().getDataDir(),
      dryRun:         body.dryRun,
      updateMetadata: body.updateMetadata,
      noCodeowners:   body.noCodeowners,
      force:          body.force,
      acceptPolicy:   body.acceptPolicy,
      onMessage: (m) => messages.push(m),
    });

    return jsonResponse({ ok: true, storeRepo, result, messages });
  } catch (err) {
    // Keep the remediation attached to the failure. These errors carry hints
    // precisely so the CLI does not have to guess what to suggest.
    if (err instanceof SubmitError || err instanceof GitHubError) {
      return jsonResponse({
        ok: false, storeRepo, messages,
        error: err.message,
        hint:  (err as { hint?: string }).hint,
      }, 400);
    }
    return errorResponse((err as Error).message, 500);
  }
};

/**
 * Where submissions go and whether we can make one — `aura nexus store status`.
 *
 * Reports the token's ORIGIN, never the token. Knowing it came from `gh` versus
 * Aura Context is the difference between "run gh auth login" and "run aura
 * nexus store login" when something is wrong.
 */
export const GET: APIRoute = async () => {
  const storeRepo = await resolveStoreRepo();
  try {
    const { token, origin } = await resolveGitHubToken(readContextToken);
    const gh = new GitHubClient(token);
    const login = await gh.whoami();
    const { owner, repo } = parseRepoSlug(storeRepo);
    const info = await gh.repoInfo(owner, repo);
    return jsonResponse({
      storeRepo, tokenOrigin: origin, login,
      mode: info.canPush ? 'owner' : 'fork',
    });
  } catch (err) {
    return jsonResponse({
      storeRepo, tokenOrigin: null, login: null, mode: null,
      error: (err as Error).message,
      hint:  (err as { hint?: string }).hint,
    });
  }
};

/** The `GITHUB_TOKEN` Context entry, or null. Server-internal by design. */
async function readContextToken(): Promise<string | null> {
  try {
    const store = new ContextStore(getAppManager().getDataDir());
    return (await store.get('GITHUB_TOKEN')) ?? null;
  } catch {
    return null;
  }
}

/**
 * Which store to submit to.
 *
 * The fallback chain is load-bearing, not defensive: every instance seeded
 * before `repo` existed has an `official` source persisted WITHOUT it, so
 * looking only at the stored entry would break for exactly the installs that
 * have been running longest.
 */
async function resolveStoreRepo(): Promise<string> {
  try {
    const cfg = await loadSourcesConfig(OS_API_BASE);
    for (const s of cfg.sources) {
      if (s.kind !== 'git-index') continue;
      const withRepo = s as { repo?: string; url?: string };
      if (withRepo.repo) return withRepo.repo;
      if (withRepo.url === OFFICIAL_INDEX_URL) return OFFICIAL_STORE_REPO;
    }
  } catch { /* fall through to the constant */ }
  return OFFICIAL_STORE_REPO;
}

/** Referenced so the import is not dropped; the manager is what owns dataDir. */
void getNexusManager;
