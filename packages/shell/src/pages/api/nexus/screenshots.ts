import type { APIRoute } from 'astro';
import {
  getAppManager, manageScreenshots, resolveGitHubToken,
  loadSourcesConfig, OFFICIAL_INDEX_URL, OFFICIAL_STORE_REPO,
  ContextStore, GitHubError, SubmitError,
} from '@aura/core';
import { jsonResponse, errorResponse } from '../../../lib/appResponse.js';

const OS_API_BASE = process.env['OS_API_BASE'] ?? 'http://localhost:3000';

/**
 * Add, replace, remove or list the screenshots on a store listing.
 *
 * Separate from the publish/submit flow on purpose: pictures change on their
 * own schedule, and pushing them through a version bump would mean either
 * re-publishing an unchanged app or overwriting metadata a maintainer edited
 * during review.
 *
 * Server-side for the same reason `submit` is: the fallback token lives in
 * ContextStore, which is deliberately not readable over the API.
 *
 * Body: { appId, action: 'list'|'add'|'remove'|'replace', source?, index?,
 *         storeRepo?, dryRun?, force? }
 */
export const POST: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => ({})) as {
    appId?: string;
    action?: 'list' | 'add' | 'remove' | 'replace';
    source?: string; index?: number;
    storeRepo?: string; dryRun?: boolean; force?: boolean;
  };

  if (!body.appId) return errorResponse('missing `appId`', 400);
  const action = body.action ?? 'list';
  if (!['list', 'add', 'remove', 'replace'].includes(action)) {
    return errorResponse(`unknown action '${action}'`, 400);
  }

  const { repo: storeRepo, indexUrl } = await resolveStore(body.storeRepo);
  const messages: string[] = [];

  try {
    // `list` and a dry run against a public store need no credential at all.
    let token: string | undefined;
    try {
      const t = await resolveGitHubToken(readContextToken);
      token = t.token;
    } catch (err) {
      if (action !== 'list' && !body.dryRun) throw err;
    }

    const result = await manageScreenshots({
      appId: body.appId,
      action,
      source: body.source,
      index:  body.index,
      storeRepo,
      indexUrl,
      token,
      dataDir: getAppManager().getDataDir(),
      dryRun:  body.dryRun,
      force:   body.force,
      onMessage: (m) => messages.push(m),
    });

    return jsonResponse({ ok: true, storeRepo, result, messages });
  } catch (err) {
    if (err instanceof SubmitError || err instanceof GitHubError) {
      return jsonResponse({
        ok: false, storeRepo, messages,
        error: err.message, hint: (err as { hint?: string }).hint,
      }, 400);
    }
    // identifyImage / assetUrl throw plain Errors with actionable messages —
    // those are for the user, not a 500 with a stack.
    return jsonResponse({ ok: false, storeRepo, messages, error: (err as Error).message }, 400);
  }
};

async function readContextToken(): Promise<string | null> {
  try {
    return (await new ContextStore(getAppManager().getDataDir()).get('GITHUB_TOKEN')) ?? null;
  } catch {
    return null;
  }
}

/** The store repo AND its index URL — assets are served from the index origin,
 *  so both come from the same source entry. */
async function resolveStore(override?: string): Promise<{ repo: string; indexUrl: string }> {
  try {
    const cfg = await loadSourcesConfig(OS_API_BASE);
    for (const s of cfg.sources) {
      if (s.kind !== 'git-index') continue;
      const g = s as { repo?: string; url?: string };
      if (override && g.repo !== override) continue;
      if (g.repo || g.url === OFFICIAL_INDEX_URL) {
        return { repo: override ?? g.repo ?? OFFICIAL_STORE_REPO, indexUrl: g.url ?? OFFICIAL_INDEX_URL };
      }
    }
  } catch { /* fall through */ }
  return { repo: override ?? OFFICIAL_STORE_REPO, indexUrl: OFFICIAL_INDEX_URL };
}
