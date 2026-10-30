import type { APIRoute } from 'astro';
import {
  getAppManager, manageScreenshots, resolveGitHubToken,
  loadSourcesConfig, OFFICIAL_INDEX_URL, OFFICIAL_STORE_REPO,
  ContextStore, GitHubError, SubmitError,
} from '@aura/core';
import { jsonResponse, errorResponse } from '../../../lib/appResponse.js';
// Namespace import: the running shell may cache a core build without newer exports.
import * as core from '@aura/core';
import { bustCatalog, DATA_DIR, listingTarget } from '../../../lib/nexusListing.js';

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
 *         storeRepo?, registry?, dryRun?, force? }
 *
 * `registry` names an OCI source: the screenshots then live in that
 * registry, in the app's listing artifact (core nexus/OciListing.ts) — a push
 * instead of a pull request, no GitHub involved.
 */
export const POST: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => ({})) as {
    appId?: string;
    action?: 'list' | 'add' | 'remove' | 'replace';
    source?: string; index?: number;
    storeRepo?: string; registry?: string; dryRun?: boolean; force?: boolean;
  };

  if (!body.appId) return errorResponse('missing `appId`', 400);
  const action = body.action ?? 'list';
  if (!['list', 'add', 'remove', 'replace'].includes(action)) {
    return errorResponse(`unknown action '${action}'`, 400);
  }

  if (body.registry) return ociScreenshots(body.appId, action as 'list' | 'add' | 'remove' | 'replace', body);

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

/** The OCI twin: same actions, the registry listing instead of a store PR. */
async function ociScreenshots(
  appId: string, action: 'list' | 'add' | 'remove' | 'replace',
  body: { registry?: string; source?: string; index?: number; dryRun?: boolean },
): Promise<Response> {
  const r = await listingTarget(body.registry, appId);
  if (r instanceof Response) {
    // Same envelope as the git path, so the CLI prints the reason.
    const j = await r.json().catch(() => ({})) as { error?: string; detail?: string };
    return jsonResponse({ ok: false, kind: 'oci', error: j.detail ?? j.error ?? `HTTP ${r.status}` }, r.status);
  }
  const messages: string[] = [];
  const storeRepo = `${r.target.host}/${r.target.repo}`;
  try {
    const result = core.manageOciScreenshots({
      target: r.target, appId, sourceName: r.sourceName, action,
      source: body.source, index: body.index, dataDir: DATA_DIR, dryRun: body.dryRun,
      onMessage: (m) => messages.push(m),
    });
    if (action !== 'list' && !body.dryRun && !result.unchanged) bustCatalog(r.sourceName);
    return jsonResponse({ ok: true, storeRepo, kind: 'oci', result, messages });
  } catch (err) {
    return jsonResponse({ ok: false, storeRepo, kind: 'oci', messages, error: ((err as Error).message ?? String(err)).split('\n')[0] }, 400);
  }
}

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
