import type { APIRoute } from 'astro';
import { join } from 'node:path';
// Namespace import: the running shell may cache a core build without newer exports.
import * as core from '@aura/core';

/**
 * Dev checkouts of installed apps — the engine behind `aura dev checkout`.
 *
 *   GET  ?appId=<id>[&scope=]   → { appId, scope, checkout, repository, upstream, … }
 *                                 whether the app is a checkout, and where its
 *                                 source would come from (nothing is changed)
 *   POST { appId, scope?, repository?, ref?, branch? }
 *        → make the installed app a git checkout of its source repo, in place
 *          (core nexus/AppSource.ts checkoutApp). The files are not touched;
 *          an app that already has .git is only reported on. The fetch runs
 *          in the app's own sandbox first (a running instance: its git, its
 *          granted tools, the shared HOME with the user's logins), then here.
 *          `fetchedIn` says where it worked.
 *
 * Bundles never ship .git; the repo comes from the manifest's `repository`,
 * the release's publish marker, or the request. Git runs here, in the master
 * container, with its credentials — a sandboxed CLI can't see other apps'
 * dirs (same reason as app-origin / manifest-edit). System apps live in the
 * AuraOS repo, which already is a checkout.
 */

interface Body {
  appId?:      string;
  scope?:      core.ScopeId;
  repository?: string;
  ref?:        string;
  branch?:     string;
}

type Target = { appId: string; scope: core.ScopeId; appDir: string; active: boolean } | Response;

function findApp(appId: unknown, scope: unknown): Target {
  if (typeof appId !== 'string' || !core.APP_ID_PATTERN.test(appId)) {
    return json({ error: 'invalid-app-id', message: 'pass appId (a reverse-domain id).' }, 400);
  }
  let mgr: ReturnType<typeof core.getAppManager>;
  try { mgr = core.getAppManager(); }
  catch (err) { return json({ error: 'app-manager-unavailable', message: (err as Error).message }, 503); }
  const scopes = mgr.getScopeDefinitions();
  if (scope !== undefined && !scopes.some((s) => s.id === scope)) {
    return json({ error: 'invalid-scope', message: `unknown scope '${String(scope)}'.` }, 400);
  }
  // The named scope's copy, else the active one.
  const id = scope ?? mgr.registry.getById(appId)?.scopeId;
  const def = scopes.find((s) => s.id === id);
  if (!def) return json({ error: 'not-found', message: `${appId} is not installed${scope ? ` in scope ${String(scope)}` : ''}.` }, 404);
  if (def.immutable) {
    return json({ error: 'system-app', message: `${appId} is a system app — it is developed in the AuraOS repo (/workspace).` }, 400);
  }
  const active = mgr.registry.getById(appId)?.scopeId === def.id;
  return { appId, scope: def.id, appDir: join(def.appsDir, appId), active };
}

function manifestOf(appDir: string): core.AppManifest | Response {
  try { return core.validateStagedDir(appDir); }
  catch (err) { return json({ error: 'invalid-manifest', message: (err as Error).message }, 422); }
}

export const GET: APIRoute = async ({ url }) => {
  const t = findApp(url.searchParams.get('appId'), url.searchParams.get('scope') ?? undefined);
  if (t instanceof Response) return t;
  const manifest = manifestOf(t.appDir);
  if (manifest instanceof Response) return manifest;
  const marker = core.readPublishMarker(t.appDir);
  const repo = core.resolveAppRepository(manifest, marker);
  // The commit checkout would use: stamped into the manifest, else the marker's.
  const declared = manifest.repository?.commit
    ? { repository: manifest.repository.url, branch: manifest.repository.branch, commit: manifest.repository.commit }
    : null;
  return json({
    appId: t.appId, scope: t.scope, appDir: t.appDir, version: manifest.version,
    checkout: core.isDevCheckout(t.appDir),
    repository: repo?.url ?? null, repositoryFrom: repo?.from ?? null,
    upstream: declared ?? marker?.source ?? null,
  });
};

export const POST: APIRoute = async ({ request }) => {
  let body: Body;
  try { body = await request.json() as Body; }
  catch { return json({ error: 'invalid-json' }, 400); }
  for (const k of ['repository', 'ref', 'branch'] as const) {
    const v = body[k];
    // Leading '-' would be read as a git option.
    if (v !== undefined && (typeof v !== 'string' || !v.trim() || v.startsWith('-'))) {
      return json({ error: 'invalid-body', message: `${k} must be a non-empty string not starting with '-'.` }, 400);
    }
  }
  const t = findApp(body.appId, body.scope);
  if (t instanceof Response) return t;
  const manifest = manifestOf(t.appDir);
  if (manifest instanceof Response) return manifest;
  // The app's own sandbox first: its git and the user's logins (shared HOME)
  // are what the app itself would fetch with. Only the active copy runs.
  const fetchVia: core.FetchPlace[] = [];
  if (t.active) {
    const appId = t.appId;
    fetchVia.push({
      label: `app ${appId}`,
      run: (args) => core.getAppManager().execInApp(appId, ['git', ...args],
        { env: { GIT_TERMINAL_PROMPT: '0' }, timeoutMs: 300_000 }),
    });
  }
  fetchVia.push(core.shellFetchPlace(t.appDir));
  try {
    const result = await core.checkoutApp(t.appDir, manifest, {
      ...(body.repository ? { repository: body.repository } : {}),
      ...(body.ref ? { ref: body.ref } : {}),
      ...(body.branch ? { branch: body.branch } : {}),
      fetchVia,
    });
    return json({ ok: true, appId: t.appId, scope: t.scope, appDir: t.appDir, ...result });
  } catch (err) {
    return json({ error: 'checkout-failed', message: (err as Error).message }, 422);
  }
};

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload, null, 2), { status, headers: { 'Content-Type': 'application/json' } });
}
