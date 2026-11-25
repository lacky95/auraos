/**
 * The system side of app patching (Track P): where an agent finds an app's
 * source, its patch workspace, opening an app, and installing a prepared tree.
 * Everything else (the patch repository, the series, filling a workspace,
 * builds, restarts and health checks) is `aura dev`'s, in the Terminal.
 *
 *   GET|POST /api/instances/<inst>/app-source      status (+ the source view in the caller)
 *   POST|DELETE /api/instances/<inst>/app-workspace  bind / detach a writable workspace
 *   POST /api/instances/<inst>/app-workspace/clean  delete old workspaces (never the bound one, the newest N or one in use)
 *   POST /api/apps/<id>/source-mode                 open (owner approval) or close
 *   POST /api/apps/<id>/activate                    install a workspace or the rollback tree
 *
 * The contract is in `aura-work/trackp-streams.md` ("## Routes"). The
 * handlers take their services as `AppSourceDeps`; the route files bind the
 * live ones.
 *
 * Known limit: the System Terminal holds the Docker socket, so read-only is a
 * guardrail for agents, not a boundary, until Phase 5 (D30). The API itself
 * respects it.
 */
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as core from '@aura/core';
import type {
  AccessPrincipal, AppManifest, AuraMount, InstallRecord, NexusManager, ScopeDefinition, SourceModeInfo,
} from '@aura/core';
import type { CallerPrincipal } from './access/identify.ts';
import { ownerAction, type OwnerActionDeps } from './approvals/admin.ts';
import { patchLevel, sourceOpenDetails, sourceOpenLevel } from './approvals/display.ts';
import { installGate, runInstall } from './approvals/nexus.ts';
import { json, type ApprovalServiceDeps } from './approvals/service.ts';
import { parseIdentity } from './nexusIdentity.js';

/** The app a registry knows, with where it lives. */
export type ScopedApp = AppManifest & { scopeId: core.ScopeId; appDir: string };

export interface AppSourceDeps {
  authenticate(request: Request): Promise<CallerPrincipal | Response>;
  approvals: ApprovalServiceDeps;
  owner: OwnerActionDeps;
  /** The root dataDir (`/data`): workspaces live under `aura/workspaces`. */
  dataDir: string;
  apps: {
    all(): ScopedApp[];
    get(appId: string): ScopedApp | undefined;
    scopes(): ScopeDefinition[];
    sourceMode(appId: string): SourceModeInfo | null;
    instance(instanceId: string): { appId: string; sandbox?: string } | undefined;
    instancesOf(appId: string): string[];
    /** AppManager `isTrustedSystemCopy`: the system copy, or the owner's approved overlay of it. */
    trustedSystemCopy(appId: string): boolean;
  };
  mounts: {
    capable(): { ok: boolean; reason?: string };
    list(instanceId: string): AuraMount[];
    add(instanceId: string, spec: { targetAppId: string; mode?: 'ro' | 'rw'; workspace?: string }): Promise<AuraMount>;
    remove(instanceId: string, mountId: string): Promise<void>;
    rebindTarget(appId: string): Promise<unknown>;
    /** Live binds of a workspace dir (relative to dataDir), in every instance. */
    workspaceBinds(subpath: string): Array<{ instanceId: string; mountId: string }>;
  };
  /** The App Host installation of an app in a scope (`apphost:install:*`), or null. */
  installationId(appId: string, scope: string): Promise<string | null>;
  nexus: Pick<NexusManager, 'install' | 'setSourceMode' | 'rollbackTrees' | 'records'>;
}

export function liveAppSourceDeps(authenticate: AppSourceDeps['authenticate'], approvals: ApprovalServiceDeps, owner: OwnerActionDeps): AppSourceDeps {
  const mgr = core.getAppManager();
  return {
    authenticate, approvals, owner,
    dataDir: mgr.rootDataDir,
    apps: {
      all: () => mgr.registry.getAll() as ScopedApp[],
      get: (id) => mgr.registry.getById(id) as ScopedApp | undefined,
      scopes: () => mgr.getScopeDefinitions(),
      sourceMode: (id) => mgr.sourceModeOf(id),
      instance: (id) => mgr.getInstance(id),
      instancesOf: (appId) => mgr.getInstancesByApp(appId).map((i) => i.instanceId),
      trustedSystemCopy: (appId) => mgr.isTrustedSystemCopy(appId),
    },
    mounts: mgr.mounts,
    installationId: async (appId, scope) => (await core.getAppHostServices().registry.findInstallation(appId, scope))?.installationId ?? null,
    nexus: core.getNexusManager(),
  };
}

// ── resolving ───────────────────────────────────────────────────────────────

/** An app by id, else by its name (case-insensitive, exact). */
export function resolveApp(deps: AppSourceDeps, ref: unknown): ScopedApp | Response {
  if (typeof ref !== 'string' || !ref.trim() || ref.length > 200) return json({ error: 'invalid-app', message: 'pass app: an app id or name' }, 400);
  const byId = deps.apps.get(ref);
  if (byId) return byId;
  const name = ref.trim().toLowerCase();
  const matches = deps.apps.all().filter((a) => a.name.toLowerCase() === name);
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) return json({ error: 'ambiguous-app', message: `several apps are called "${ref}"`, matches: matches.map((a) => a.id) }, 409);
  return json({ error: 'app-not-found', message: `no installed app has the id or name "${ref}"` }, 404);
}

/**
 * Whether the active copy is the owner's overlay of a system app: a user-scope
 * copy an approved activation linked to the system installation (core
 * AppHostStore `approvedOverlay`). A same-id copy from a store or `aura dev`
 * is its own app, with its own patches.
 */
function isOverlay(deps: AppSourceDeps, app: ScopedApp): boolean {
  return app.scopeId === 'user' && deps.apps.trustedSystemCopy(app.id);
}

/**
 * The installation patches and workspaces belong to: the active copy's, but a
 * system app's for its overlay, so the patches outlive the overlay itself.
 */
async function patchInstallation(deps: AppSourceDeps, app: ScopedApp): Promise<{ key: string | null; active: string | null; overlay: boolean }> {
  const overlay = isOverlay(deps, app);
  const active = await deps.installationId(app.id, app.scopeId).catch(() => null);
  const key = overlay ? await deps.installationId(app.id, 'system').catch(() => null) : active;
  return { key, active, overlay };
}

/** The user a request acts for: workspaces are per user. */
export function actingUser(principal: AccessPrincipal): string {
  if (principal.kind === 'user') return principal.userId;
  if (principal.kind === 'instance' && principal.userId) return principal.userId;
  return core.APP_HOST_DEFAULT_USER;
}

/** Where the active copy's release came from. A system app: the AuraOS checkout. */
function upstreamOf(deps: AppSourceDeps, app: ScopedApp): core.AppSourceInfo | null {
  if (app.scopeId === 'system') {
    const s = core.readAppSource(app.appDir, app);
    if (s.repository) s.repository = core.withoutCredentials(s.repository);
    return Object.keys(s).length ? s : null;
  }
  const record = deps.nexus.records.get(app.id);
  if (record?.scope === app.scopeId && record.upstream) return record.upstream;
  return core.readPublishMarker(app.appDir)?.source ?? null;
}

/** The caller of an instance route, which must run in a container to receive binds. */
function consumer(deps: AppSourceDeps, instanceId: string | undefined): string | Response {
  if (!instanceId) return json({ error: 'invalid-instance' }, 400);
  const inst = deps.apps.instance(instanceId);
  if (!inst) return json({ error: 'instance-not-found' }, 404);
  if (inst.sandbox && inst.sandbox !== 'container') {
    return json({ error: 'not-a-container', message: `${instanceId} runs in a '${inst.sandbox}' sandbox; source views need sandbox: container` }, 409);
  }
  return instanceId;
}

/**
 * A writable source view of an open app goes only to the owner's own
 * Terminal (or the owner): write access to another app's files is the
 * owner's (Q30), as for `aura mount --wr`. The Terminal's approved overlay
 * is still the owner's Terminal.
 */
function mayWrite(principal: AccessPrincipal, deps: AppSourceDeps): boolean {
  if (principal.kind === 'user' || principal.kind === 'operator') return true;
  return principal.kind === 'instance' && principal.appId === 'com.aura.terminal'
    && deps.apps.trustedSystemCopy('com.aura.terminal');
}

/**
 * Whose workspace an activation installs (multi-user rule): a caller
 * activates its own user's workspaces; the owner (the owner's login or the
 * host operator) may name any user's. Workspaces are keyed by the
 * installation and that user, as R2 creates them.
 */
function workspaceOwner(principal: AccessPrincipal, requested: unknown): string | Response {
  const own = actingUser(principal);
  if (requested === undefined || requested === own) return own;
  if (typeof requested !== 'string' || !requested) return json({ error: 'invalid-user', message: 'user must be a user id' }, 400);
  const owner = principal.kind === 'operator' || (principal.kind === 'user' && principal.role === 'owner');
  if (!owner) return json({ error: 'forbidden', message: 'only the owner activates another user\'s workspace' }, 403);
  return requested;
}

const sourcePath = (appId: string) => `${core.MOUNT_ROOT_PATH}/${appId}`;
const workPath = (appId: string) => `${core.MOUNT_ROOT_PATH}/${core.WORK_DIR_NAME}/${appId}`;
const workNumber = (m: AuraMount | undefined): number | null => {
  const n = Number(m?.workspace?.split('/').pop());
  return Number.isInteger(n) && n > 0 ? n : null;
};

async function readJson(request: Request): Promise<Record<string, unknown> | Response> {
  const text = await request.text().catch(() => null);
  if (text === null) return json({ error: 'invalid-request' }, 400);
  if (!text) return {};
  try {
    const v: unknown = JSON.parse(text);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch { /* below */ }
  return json({ error: 'invalid-json' }, 400);
}

// ── R1: status and the source view ──────────────────────────────────────────

export async function appSourceStatus(request: Request, instanceId: string | undefined, deps: AppSourceDeps, bind: boolean): Promise<Response> {
  const principal = await deps.authenticate(request);
  if (principal instanceof Response) return principal;
  const inst = consumer(deps, instanceId);
  if (inst instanceof Response) return inst;
  let ref: unknown;
  if (bind) {
    const body = await readJson(request);
    if (body instanceof Response) return body;
    ref = body['app'];
  } else {
    ref = new URL(request.url).searchParams.get('app');
  }
  const app = resolveApp(deps, ref);
  if (app instanceof Response) return app;
  const mode = deps.apps.sourceMode(app.id) ?? { mode: 'closed', defaultMode: 'closed', from: 'default' } as SourceModeInfo;
  const { key, active, overlay } = await patchInstallation(deps, app);
  const userId = actingUser(principal);

  const writable = mode.mode === 'open' && mayWrite(principal, deps);
  let view = deps.mounts.list(inst).find((m) => m.id === app.id);
  if (bind) {
    const cap = deps.mounts.capable();
    if (!cap.ok) return json({ error: 'mounts-unavailable', message: cap.reason ?? 'mount propagation is unavailable on this host' }, 503);
    const want = writable ? 'rw' : 'ro';
    try {
      if (view && view.mode !== want) { await deps.mounts.remove(inst, view.id); view = undefined; }
      if (!view) view = await deps.mounts.add(inst, { targetAppId: app.id, mode: want });
    } catch (err) {
      return json({ error: 'mount-failed', message: (err as Error).message }, 409);
    }
  }
  const work = deps.mounts.list(inst).find((m) => m.id === `${app.id}:work`);
  const workspaces = key ? core.listWorkspaces(deps.dataDir, userId, key) : [];
  const path = view?.containerPath ?? sourcePath(app.id);
  const next = mode.mode === 'open' && view?.mode === 'rw'
    ? `Edit the source at ${path} directly: ${app.id} is open.`
    : work
      ? `Edit in ${work.containerPath}, then \`aura dev patch save\`; \`aura dev patch activate\` installs it.`
      : `Read the source at ${path} (read-only). To change it: \`aura dev patch start ${app.id}\`.`;
  return json({
    appId: app.id, name: app.name, version: app.version, scope: app.scopeId,
    installationId: key, activeInstallationId: active, overlay,
    mode: mode.mode, defaultMode: mode.defaultMode, modeFrom: mode.from,
    upstream: upstreamOf(deps, app),
    source: { path, writable: view?.mode === 'rw', mounted: !!view },
    workspace: work ? { n: workNumber(work), path: work.containerPath } : null,
    workspaces,
    user: userId,
    next,
  });
}

// ── R2: the workspace bind ──────────────────────────────────────────────────

export async function bindWorkspace(request: Request, instanceId: string | undefined, deps: AppSourceDeps): Promise<Response> {
  const principal = await deps.authenticate(request);
  if (principal instanceof Response) return principal;
  const inst = consumer(deps, instanceId);
  if (inst instanceof Response) return inst;
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const app = resolveApp(deps, body['app']);
  if (app instanceof Response) return app;
  if (body['n'] !== undefined && (!Number.isInteger(body['n']) || (body['n'] as number) < 1 || (body['n'] as number) > 9999)) {
    return json({ error: 'invalid-workspace', message: 'n must be a whole number from 1 to 9999' }, 400);
  }
  const cap = deps.mounts.capable();
  if (!cap.ok) return json({ error: 'mounts-unavailable', message: cap.reason ?? 'mount propagation is unavailable on this host' }, 503);
  const { key } = await patchInstallation(deps, app);
  if (!key) return json({ error: 'no-installation', message: `${app.id} has no installation record yet; try again once it has started` }, 409);
  const userId = actingUser(principal);

  const existing = core.listWorkspaces(deps.dataDir, userId, key);
  const bound = deps.mounts.list(inst).find((m) => m.id === `${app.id}:work`);
  const boundHere = bound?.workspace?.startsWith(`aura/workspaces/${userId}/${key}/`) ? workNumber(bound) : null;
  const n = typeof body['n'] === 'number' ? body['n']
    : body['new'] === true ? (existing.at(-1) ?? 0) + 1
      : boundHere ?? existing.at(-1) ?? 1;
  let subpath: string;
  try { subpath = core.workspaceSubpath(userId, key, n); }
  catch (err) { return json({ error: 'invalid-workspace', message: (err as Error).message }, 400); }
  const created = !existsSync(join(deps.dataDir, subpath));
  try {
    if (bound && bound.workspace !== subpath) await deps.mounts.remove(inst, bound.id);
    if (!bound || bound.workspace !== subpath) await deps.mounts.add(inst, { targetAppId: app.id, workspace: subpath });
  } catch (err) {
    return json({ error: 'mount-failed', message: (err as Error).message }, 409);
  }
  return json({ ok: true, appId: app.id, installationId: key, n, path: workPath(app.id), created });
}

export async function detachWorkspace(request: Request, instanceId: string | undefined, deps: AppSourceDeps): Promise<Response> {
  const principal = await deps.authenticate(request);
  if (principal instanceof Response) return principal;
  const inst = consumer(deps, instanceId);
  if (inst instanceof Response) return inst;
  const app = resolveApp(deps, new URL(request.url).searchParams.get('app'));
  if (app instanceof Response) return app;
  const bound = deps.mounts.list(inst).find((m) => m.id === `${app.id}:work`);
  if (!bound) return json({ ok: true, removed: false });
  try { await deps.mounts.remove(inst, bound.id); }
  catch (err) { return json({ error: 'mount-failed', message: (err as Error).message }, 409); }
  return json({ ok: true, removed: true });
}

/**
 * `aura dev patch clean`: delete this user's old workspaces of the app's
 * installation. Never candidates: the one bound in the calling instance and
 * the newest `keep` (default 3) by number. A candidate bound in another
 * instance is `inUse` and kept unless `force` (then detached there first).
 * Whether a workspace holds unsaved work is `aura dev`'s to judge (it knows
 * the patch repo): it asks with `dryRun`, inspects, then names the ones to
 * go in `delete`. Without `delete`, every candidate not in use goes.
 */
export async function cleanWorkspaces(request: Request, instanceId: string | undefined, deps: AppSourceDeps): Promise<Response> {
  const principal = await deps.authenticate(request);
  if (principal instanceof Response) return principal;
  const inst = consumer(deps, instanceId);
  if (inst instanceof Response) return inst;
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const app = resolveApp(deps, body['app']);
  if (app instanceof Response) return app;
  const keep = body['keep'] ?? 3;
  if (!Number.isInteger(keep) || (keep as number) < 0 || (keep as number) > 9999) {
    return json({ error: 'invalid-keep', message: 'keep must be a whole number from 0' }, 400);
  }
  const only = body['delete'];
  if (only !== undefined && (!Array.isArray(only) || !only.every((n) => Number.isInteger(n)))) {
    return json({ error: 'invalid-delete', message: 'delete must be a list of workspace numbers' }, 400);
  }
  const force = body['force'] === true;
  const { key } = await patchInstallation(deps, app);
  if (!key) return json({ error: 'no-installation', message: `${app.id} has no installation record` }, 409);
  const userId = actingUser(principal);
  const all = core.listWorkspaces(deps.dataDir, userId, key);
  const bound = deps.mounts.list(inst).find((m) => m.id === `${app.id}:work`);
  const boundHere = bound?.workspace?.startsWith(`aura/workspaces/${userId}/${key}/`) ? workNumber(bound) : null;
  const kept = new Set<number>([...(boundHere ? [boundHere] : []), ...(keep ? all.slice(-(keep as number)) : [])]);
  const candidates = all.filter((n) => !kept.has(n));
  const inUse = candidates.filter((n) => deps.mounts.workspaceBinds(core.workspaceSubpath(userId, key, n)).length > 0);
  const base = { appId: app.id, installationId: key, kept: all.filter((n) => kept.has(n)), candidates, inUse };
  if (body['dryRun'] === true) return json({ ok: true, ...base, deleted: [], detached: 0 });

  const targets = candidates.filter((n) => (only === undefined || (only as number[]).includes(n)) && (force || !inUse.includes(n)));
  const deleted: number[] = [];
  let detached = 0;
  for (const n of targets) {
    const subpath = core.workspaceSubpath(userId, key, n);
    try {
      for (const b of deps.mounts.workspaceBinds(subpath)) { await deps.mounts.remove(b.instanceId, b.mountId); detached++; }
      rmSync(join(deps.dataDir, subpath), { recursive: true, force: true });
      deleted.push(n);
    } catch (err) {
      return json({ error: 'clean-failed', message: `workspace ${n}: ${(err as Error).message}`, deleted, detached }, 409);
    }
  }
  return json({ ok: true, ...base, deleted, detached });
}

// ── R3: open and close ──────────────────────────────────────────────────────

type RouteCtx = Parameters<typeof ownerAction>[0];

export async function setSourceMode(ctx: RouteCtx, appId: string | undefined, deps: AppSourceDeps): Promise<Response> {
  const app = appId ? deps.apps.get(appId) : undefined;
  if (!app) return json({ error: 'app-not-found' }, 404);
  const body = await readJson(ctx.request.clone());
  if (body instanceof Response) return body;
  const mode = body['mode'];
  if (mode !== 'open' && mode !== 'closed') return json({ error: 'invalid-mode', message: "mode must be 'open' or 'closed'" }, 400);
  if (app.scopeId === 'system') {
    return json({ error: 'system-app', message: `${app.id} is a system app: its source stays closed. Patch it (\`aura dev patch start ${app.id}\`); activation makes your own copy.` }, 409);
  }
  const record = deps.nexus.records.get(app.id);
  if (!record || record.scope !== app.scopeId) {
    return json({ ok: true, appId: app.id, mode: 'open', defaultMode: app.source?.defaultMode ?? 'closed', note: 'built here: always open' });
  }
  const principal = await deps.authenticate(ctx.request);
  if (principal instanceof Response) return principal;
  if (principal.kind === 'anonymous') return json({ error: 'unauthenticated' }, 401);
  let by: Parameters<ApprovalServiceDeps['audit']>[0]['by'] = principal.kind === 'user' ? core.userAttribution(principal)
    : principal.kind === 'operator' ? core.operatorAttribution() : { kind: 'system' };
  if (mode === 'open') {
    const decided = await ownerAction(ctx, {
      action: 'app.source.open', payload: { appId: app.id, scope: app.scopeId, mode },
      level: sourceOpenLevel(app.id), title: `Open the source of ${app.name}`, details: sourceOpenDetails(app.id, app.scopeId),
    }, deps.owner);
    if (decided instanceof Response) return decided;
    by = decided.by;
  }
  try { deps.nexus.setSourceMode(app.id, mode); }
  catch (err) { return json({ error: 'not-installed', message: (err as Error).message }, 409); }
  // Closed: writable views of it come back read-only.
  if (mode === 'closed') await deps.mounts.rebindTarget(app.id);
  try {
    await deps.approvals.audit({ by, action: `app.source.${mode === 'open' ? 'open' : 'close'}`, target: `app:${app.id}`, outcome: 'ok' });
  } catch { /* the audit trail must not fail the request */ }
  return json({ ok: true, appId: app.id, mode, defaultMode: app.source?.defaultMode ?? 'closed' });
}

// ── R4: activate a prepared tree ────────────────────────────────────────────

export async function activatePrepared(request: Request, appId: string | undefined, deps: AppSourceDeps): Promise<Response> {
  const principal = await deps.authenticate(request);
  if (principal instanceof Response) return principal;
  const app = appId ? deps.apps.get(appId) : undefined;
  if (!app) return json({ error: 'app-not-found' }, 404);
  const body = await readJson(request.clone());
  if (body instanceof Response) return body;
  const identity = parseIdentity(body['identity']);
  if (identity instanceof Response) return identity;
  const overlay = app.scopeId === 'system' || isOverlay(deps, app);
  // A system app is patched as the user's own copy: /workspace stays as released.
  const scope: 'global' | 'user' = app.scopeId === 'global' ? 'global' : 'user';

  let tree: string;
  if (body['rollback'] === true) {
    const newest = deps.nexus.rollbackTrees(app.id, scope).newest;
    if (!newest) return json({ error: 'no-rollback-tree', message: `no earlier tree of ${app.id} is kept${overlay ? ` — to drop your copy, \`aura nexus uninstall ${app.id}\`` : ''}` }, 404);
    tree = newest;
  } else {
    const n = body['workspace'];
    if (!Number.isInteger(n)) return json({ error: 'invalid-workspace', message: 'pass workspace: <n>, or rollback: true' }, 400);
    const user = workspaceOwner(principal, body['user']);
    if (user instanceof Response) return user;
    const { key } = await patchInstallation(deps, app);
    if (!key) return json({ error: 'no-installation', message: `${app.id} has no installation record` }, 409);
    try { tree = join(deps.dataDir, core.workspaceSubpath(user, key, n as number)); }
    catch (err) { return json({ error: 'invalid-workspace', message: (err as Error).message }, 400); }
    if (!existsSync(tree)) return json({ error: 'no-workspace', message: `workspace ${String(n)} of ${app.id} does not exist` }, 404);
  }
  let candidate: AppManifest;
  try { candidate = core.validateStagedDir(tree); }
  catch (err) { return json({ error: 'invalid-tree', message: (err as Error).message }, 422); }
  if (candidate.id !== app.id) return json({ error: 'invalid-tree', message: `the prepared tree is ${candidate.id}, not ${app.id}` }, 422);

  // Compared with the copy that runs now, which a system app's overlay has no record of.
  const diff = core.computePermissionDiff(app, candidate);
  const gate = installGate(deps.approvals, principal, request, body['operatorCode'], {
    level: (binding) => patchLevel(app.id, binding, diff), diff,
  });
  const answer = await runInstall(deps.nexus.install({
    ref: tree, scope, action: 'app.patch.activate', approval: gate.approval, ...(identity ? { identity } : {}),
  }), gate, () => 422);
  if (answer.status !== 200) return answer;
  const result = await answer.json() as { ok?: boolean; record?: InstallRecord };
  if (!result.ok || !result.record) return json(result);
  return json({
    ok: true, record: result.record, scope, overlay,
    rollbackTree: deps.nexus.rollbackTrees(app.id, scope, result.record).previous,
    running: deps.apps.instancesOf(app.id),
  });
}
