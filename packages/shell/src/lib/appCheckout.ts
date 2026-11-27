/**
 * Dev checkouts of installed apps — the engine behind `aura dev checkout`
 * (route: pages/api/admin/app-checkout.ts).
 *
 *   GET  ?appId=<id>[&scope=]   → { appId, scope, checkout, repository, upstream, … }
 *                                 whether the app is a checkout, and where its
 *                                 source would come from (nothing is changed)
 *   POST { appId, scope?, repository?, ref?, branch? }
 *        → make the installed app a git checkout of its source repo, in place
 *          (core nexus/AppSource.ts checkoutApp). The files are not touched;
 *          an app that already has .git is only reported on. The fetch runs
 *          in the app's own sandbox first (a running instance: its git, its
 *          granted tools), then here. `fetchedIn` says where it worked.
 *
 * The same rules as `aura dev open` (Track P, lib/appSource.ts setSourceMode),
 * checked on every request, the approved one included, so an approval never
 * overrides them:
 *   - a system app (an immutable scope) is never checked out (409 system-app);
 *   - a closed install is refused until the owner opens it (409 source-closed);
 *   - an app with no recorded installation is refused (409 not-ready): the
 *     approval binds the installation.
 * Then the owner decides (`ownerAction`, action `app.source.open`, `fresh`:
 * the password or the host operator), bound to the operation, the app, its
 * scope and installation, and the requested repository/ref/branch; used once.
 * Audited `app.checkout` with the outcome.
 *
 * Bundles never ship .git; the repo comes from the manifest's `repository`,
 * the release's publish marker, or the request. Git runs here, in the master
 * container — a sandboxed CLI can't see other apps' dirs.
 */
import { join } from 'node:path';
// Namespace import: the running shell may cache a core build without newer exports.
import * as core from '@aura/core';
import { auditOwner, ownerAction, type OwnerActor } from './approvals/admin.ts';
import { json } from './approvals/service.ts';

type Ctx = Parameters<typeof ownerAction>[0];

export interface CheckoutTarget { appId: string; scope: core.ScopeId; appDir: string; active: boolean }

export interface CheckoutDeps {
  ownerAction(ctx: Ctx, req: Parameters<typeof ownerAction>[1]): Promise<OwnerActor | Response>;
  audit(actor: OwnerActor, action: string, opts: Parameters<typeof auditOwner>[2]): Promise<void>;
  scopes(): core.ScopeDefinition[];
  /** The scope of the active copy of `appId`, if any. */
  activeScope(appId: string): string | undefined;
  /** The app's validated manifest in `appDir` (throws when invalid). */
  manifest(appDir: string): core.AppManifest;
  isCheckout(appDir: string): boolean;
  sourceMode(def: core.ScopeDefinition, manifest: core.AppManifest): core.SourceMode;
  installationId(appId: string, scope: string): Promise<string | null>;
  checkout(t: CheckoutTarget, manifest: core.AppManifest, opts: { repository?: string; ref?: string; branch?: string }): Promise<Record<string, unknown>>;
}

export function liveCheckoutDeps(): CheckoutDeps {
  const mgr = () => core.getAppManager();
  return {
    ownerAction: (ctx, req) => ownerAction(ctx, req),
    audit: (actor, action, opts) => auditOwner(actor, action, opts),
    scopes: () => mgr().getScopeDefinitions(),
    activeScope: (appId) => mgr().registry.getById(appId)?.scopeId,
    manifest: (appDir) => core.validateStagedDir(appDir),
    isCheckout: (appDir) => core.isDevCheckout(appDir),
    sourceMode: (def, manifest) => core.effectiveSourceMode(def, manifest).mode,
    installationId: async (appId, scope) => (await core.getAppHostServices().registry.findInstallation(appId, scope))?.installationId ?? null,
    checkout: async (t, manifest, opts) => {
      // The app's own sandbox first: its git and tools are what the app itself
      // would fetch with. Only the active copy runs.
      const fetchVia: core.FetchPlace[] = [];
      if (t.active) {
        fetchVia.push({
          label: `app ${t.appId}`,
          run: (args) => mgr().execInApp(t.appId, ['git', ...args], { env: { GIT_TERMINAL_PROMPT: '0' }, timeoutMs: 300_000 }),
        });
      }
      fetchVia.push(core.shellFetchPlace(t.appDir));
      return { ...await core.checkoutApp(t.appDir, manifest, { ...opts, fetchVia }) };
    },
  };
}

/** The installed copy a request names, or the answer refusing it (a system app always). */
export function findCheckoutApp(deps: CheckoutDeps, appId: unknown, scope: unknown): CheckoutTarget | Response {
  if (typeof appId !== 'string' || !core.APP_ID_PATTERN.test(appId)) {
    return json({ error: 'invalid-app-id', message: 'pass appId (a reverse-domain id).' }, 400);
  }
  let scopes: core.ScopeDefinition[];
  try { scopes = deps.scopes(); }
  catch (err) { return json({ error: 'app-manager-unavailable', message: (err as Error).message }, 503); }
  if (scope !== undefined && !scopes.some((s) => s.id === scope)) {
    return json({ error: 'invalid-scope', message: `unknown scope '${String(scope)}'.` }, 400);
  }
  // The named scope's copy, else the active one.
  const id = scope ?? deps.activeScope(appId);
  const def = scopes.find((s) => s.id === id);
  if (!def) return json({ error: 'not-found', message: `${appId} is not installed${scope ? ` in scope ${String(scope)}` : ''}.` }, 404);
  if (def.immutable || def.id === 'system') {
    return json({ error: 'system-app', message: `${appId} is a built-in app: its source stays closed. ${core.SYSTEM_APP_LATER_MESSAGE}.` }, 409);
  }
  return { appId, scope: def.id, appDir: join(def.appsDir, appId), active: deps.activeScope(appId) === def.id };
}

export function checkoutManifest(deps: CheckoutDeps, appDir: string): core.AppManifest | Response {
  try { return deps.manifest(appDir); }
  catch (err) { return json({ error: 'invalid-manifest', message: (err as Error).message }, 422); }
}

export async function getAppCheckout(url: URL, deps: CheckoutDeps = liveCheckoutDeps()): Promise<Response> {
  const t = findCheckoutApp(deps, url.searchParams.get('appId'), url.searchParams.get('scope') ?? undefined);
  if (t instanceof Response) return t;
  const manifest = checkoutManifest(deps, t.appDir);
  if (manifest instanceof Response) return manifest;
  const marker = core.readPublishMarker(t.appDir);
  const repo = core.resolveAppRepository(manifest, marker);
  // The commit checkout would use: stamped into the manifest, else the marker's.
  const declared = manifest.repository?.commit
    ? { repository: manifest.repository.url, branch: manifest.repository.branch, commit: manifest.repository.commit }
    : null;
  return json({
    appId: t.appId, scope: t.scope, appDir: t.appDir, version: manifest.version,
    checkout: deps.isCheckout(t.appDir),
    repository: repo?.url ?? null, repositoryFrom: repo?.from ?? null,
    upstream: declared ?? marker?.source ?? null,
  });
}

export async function postAppCheckout(ctx: Ctx, deps: CheckoutDeps = liveCheckoutDeps()): Promise<Response> {
  let body: { appId?: unknown; scope?: unknown; repository?: unknown; ref?: unknown; branch?: unknown };
  try { body = await ctx.request.clone().json() as typeof body; }
  catch { return json({ error: 'invalid-json' }, 400); }
  if (!body || typeof body !== 'object') return json({ error: 'invalid-json' }, 400);
  const opts: { repository?: string; ref?: string; branch?: string } = {};
  for (const k of ['repository', 'ref', 'branch'] as const) {
    const v = body[k];
    // Leading '-' would be read as a git option.
    if (v !== undefined && (typeof v !== 'string' || !v.trim() || v.startsWith('-'))) {
      return json({ error: 'invalid-body', message: `${k} must be a non-empty string not starting with '-'.` }, 400);
    }
    if (typeof v === 'string') opts[k] = v;
  }
  const t = findCheckoutApp(deps, body.appId, body.scope);
  if (t instanceof Response) return t;
  const manifest = checkoutManifest(deps, t.appDir);
  if (manifest instanceof Response) return manifest;
  // A closed install's source is read-only (Track P): a checkout in place
  // would make it a working tree. The owner opens it first (`aura dev open`).
  const def = deps.scopes().find((s) => s.id === t.scope)!;
  const already = deps.isCheckout(t.appDir);
  if (!already && deps.sourceMode(def, manifest) === 'closed') {
    // The one source-closed text (core sourceClosedBody), also what a write that hits EROFS says.
    return json(core.sourceClosedBody(t.appId), 409);
  }
  const installationId = await deps.installationId(t.appId, t.scope).catch(() => null);
  if (!installationId) {
    return json({ error: 'not-ready', message: `${t.appId} has no recorded installation in scope ${t.scope} yet. Start it once, then try again.` }, 409);
  }
  const actor = await deps.ownerAction(ctx, {
    action: 'app.source.open', level: 'fresh',
    payload: { op: 'app.checkout', appId: t.appId, scope: t.scope, installationId, ...opts },
    title: `Make ${t.appId} a git checkout of its source`,
    details: [
      `App: ${t.appId} (${t.scope} scope, installation ${installationId})`,
      ...(opts.repository ? [`Repository: ${opts.repository}`] : []),
      ...(opts.ref ? [`Ref: ${opts.ref}`] : []),
      ...(opts.branch ? [`Branch: ${opts.branch}`] : []),
      'Its installed source becomes a git working tree: Nexus no longer updates it over the changes (update/install need --force).',
    ],
  });
  if (actor instanceof Response) return actor;
  const target = `installation:${installationId}`;
  try {
    const result = await deps.checkout(t, manifest, opts);
    await deps.audit(actor, 'app.checkout', { target, outcome: 'ok', detail: { appId: t.appId, scope: t.scope, created: result['created'] === true } });
    return json({ ok: true, appId: t.appId, scope: t.scope, appDir: t.appDir, installationId, ...result });
  } catch (err) {
    await deps.audit(actor, 'app.checkout', { target, outcome: 'failed', detail: { appId: t.appId, scope: t.scope } });
    return json({ error: 'checkout-failed', message: (err as Error).message }, 422);
  }
}
