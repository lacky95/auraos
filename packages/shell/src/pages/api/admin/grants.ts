import type { APIRoute } from 'astro';
import * as core from '@aura/core';
import { jsonResponse } from '../../../lib/appResponse.js';
import { readJson } from '../../../lib/notificationCaller.js';
import { auditOwner, grantLevel, ownerAction } from '../../../lib/approvals/admin.ts';
import { ownerUiApp } from '../../../../server/gateway-identity.mjs';
import { liveAppView } from '../../../../server/app-view.mjs';

/**
 * The owner's grants of privileged permissions (core auth `GrantStore`).
 * Who may call (D50, lib/approvals/admin.ts): the owner in the desktop and the
 * host operator directly; Settings reads directly and asks the owner's
 * approval for a change; the CLI in the System Terminal asks for every call
 * (202 needs-approval, then the same request with `X-Aura-Approval`). A grant
 * needs the password (`fresh`), a revoke or a read one click.
 *
 *   GET    → { privileged, grants: GrantRecord[], apps: [{appId, name, scope,
 *             requested: [...], granted: [...], effective: [...], asOwner?: [...]}] }
 *            `asOwner`: what a trusted system UI declares but needs no grant
 *            for, because the owner acts through it (D45: Settings writes
 *            `os` KV topics as the owner). Never in `requested`.
 *   POST   {subjectKind:'app'|'apiKey', subjectId, permission} → grant
 *            (app grants are pinned to the app's current install scope)
 *            `notifications.read` (phase 5) also needs `readScope`:
 *            "all" | "app:<id>,sender:<key>" | {apps:[…]} | {senders:[…]},
 *            plus `includeSecret` (default false). Re-granting replaces the scope.
 *   DELETE {subjectKind, subjectId, permission} (body or query) → revoke
 *
 * App access (D104, `apps.view`): POST and DELETE also take `target` (the
 * target app id); a grant needs it, a revoke without it drops every target.
 * Granting it is one click (owner decision; D102 class deferrable). GET lists
 * them in `appAccess` with whether each still counts (both installations).
 *
 * Takes effect on the very next request (no restart); emits
 * `permissions:changed`; the record and the audit name the owner (or the
 * operator) who decided, and the requester of an approved request.
 * Grantable: notifications.locked, notifications.popup, notifications.read,
 * notifications.systemModal (phase 6; revoking it releases that sender's modals).
 * An app must also REQUEST the permission in its manifest for the grant to count.
 */
function fail(err: unknown): Response {
  const status = (err as { status?: unknown }).status;
  const message = err instanceof Error ? err.message : String(err);
  return jsonResponse({ error: message }, typeof status === 'number' ? status : 500);
}

async function subjectArgs(request: Request, url: URL): Promise<{ kind: string; id: string; permission: string; src: Record<string, unknown> } | Response> {
  let src: Record<string, unknown> = Object.fromEntries(url.searchParams.entries());
  if (request.method !== 'GET' && (request.headers.get('content-type') ?? '').includes('json')) {
    const body = await readJson(request);
    if (body instanceof Response) return body;
    src = { ...src, ...body };
  }
  const kind = String(src['subjectKind'] ?? 'app');
  const id = String(src['subjectId'] ?? src['appId'] ?? '');
  // Phase 6 rename: the deprecated name maps to the current one (GrantStore does the same).
  const permission = core.canonicalPermission(String(src['permission'] ?? ''));
  if (!id || !permission) return jsonResponse({ error: 'subjectId (or appId) and permission are required' }, 400);
  return { kind, id, permission, src };
}

/**
 * D45: the system copy of a trusted UI whose entry covers `kv` (Settings)
 * writes `os` topics as the owner, so the `system.kv.os.<topic>.write` it
 * declares is not waiting for a grant.
 */
export function asOwnerPermissions(appId: string, scope: string | null, declared: readonly string[]): string[] {
  if (scope !== 'system' || !ownerUiApp(appId)?.groups.includes('kv')) return [];
  return declared.filter((x) => core.KV_OS_WRITE_PERMISSION_RE.test(x));
}

export const GET: APIRoute = async (ctx) => {
  const actor = await ownerAction(ctx, { action: 'admin.read', payload: { view: 'grants' }, level: 'session', title: 'Show the permission grants' });
  if (actor instanceof Response) return actor;
  const { grants, authorizer } = core.getAuthServices();
  const all = await grants.listAll();
  const mgr = core.getAppManager();
  const apps = [];
  for (const m of mgr.registry.getAll()) {
    // Deprecated names in permissions[] count as their current name (desktopModal → systemModal).
    const declared = [...new Set((m.permissions ?? []).map((x: string) => core.canonicalPermission(x)).filter((x: string) => core.isPrivilegedPermission(x)))];
    const scope = mgr.registry.getScopeId(m.id) ?? null;
    const asOwner = asOwnerPermissions(m.id, scope, declared);
    const requested = declared.filter((x) => !asOwner.includes(x));
    const mine = all.filter((g) => g.subject.kind === 'app' && g.subject.id === m.id);
    const granted = mine.map((g) => g.permission);
    const readRec = mine.find((g) => g.permission === 'notifications.read');
    if (requested.length === 0 && asOwner.length === 0 && granted.length === 0 && !(m.permissions ?? []).includes('system.notifications')) continue;
    const probe = { kind: 'instance', appId: m.id, instanceId: `${m.id}-probe`, verification: 'verified' } as const;
    const effective: string[] = [];
    for (const perm of core.PRIVILEGED_PERMISSIONS) {
      if ((await authorizer.authorize(probe, perm)).allow) effective.push(perm);
    }
    apps.push({
      appId: m.id, name: m.name, scope,
      sends: (m.permissions ?? []).includes('system.notifications'),
      requested, granted, effective,
      ...(asOwner.length ? { asOwner } : {}),
      // Phase 5: what a notifications.read grant covers ("all", "app:x,sender:y", "+secret").
      ...(readRec?.read ? { read: { ...readRec.read, label: core.GrantStore.describeRead(readRec) } } : {}),
    });
  }
  apps.sort((a, b) => a.appId.localeCompare(b.appId));
  const view = await liveAppView();
  const appAccess = [];
  for (const g of all) {
    if (g.subject.kind !== 'app' || g.scope?.kind !== 'app') continue;
    const counts = core.appAccessCounts(g, await view.binding(g.subject.id), (await view.binding(g.scope.id)).installationId);
    appAccess.push({ consumer: g.subject.id, permission: g.permission, target: g.scope.id, grantedAt: g.grantedAt, state: counts ? 'active' : 'stale' });
  }
  return jsonResponse({ privileged: core.PRIVILEGED_PERMISSIONS, grants: all, apps, appAccess });
};

export const POST: APIRoute = async (ctx) => {
  const { request, url } = ctx;
  const a = await subjectArgs(request, url);
  if (a instanceof Response) return a;
  const { grants, apiKeys } = core.getAuthServices();
  const warnings: string[] = [];
  let appScope: string | undefined;
  if (a.kind === 'app') {
    const mgr = core.getAppManager();
    const m = mgr.registry.getById(a.id);
    if (!m) return jsonResponse({ error: `unknown app ${a.id}` }, 404);
    appScope = mgr.registry.getScopeId(a.id);
    if (!(m.permissions ?? []).some((x: string) => core.canonicalPermission(x) === a.permission)) {
      warnings.push(`${a.id} does not request '${a.permission}' in its manifest — the grant has no effect until it does`);
    }
  } else if (a.kind === 'apiKey') {
    const k = await apiKeys.get(a.id);
    if (!k) return jsonResponse({ error: `unknown API key ${a.id}` }, 404);
    if (k.revokedAt) return jsonResponse({ error: `API key ${a.id} is revoked` }, 409);
  }
  if (core.isAppAccessPermission(a.permission) || a.src['target'] !== undefined) return grantAppAccess(ctx, a);
  const readArg = a.src['readScope'] ?? (a.permission === 'notifications.read' ? a.src['scope'] : undefined);
  const read = a.permission === 'notifications.read' && readArg !== undefined
    ? { scope: readArg, includeSecret: a.src['includeSecret'] === true || a.src['includeSecret'] === 'true' }
    : undefined;
  const actor = await ownerAction(ctx, {
    action: 'admin.grant', level: grantLevel(a.permission),
    payload: { subjectKind: a.kind, subjectId: a.id, permission: a.permission, ...(read ? { read } : {}) },
    title: `Grant ${a.id} ${a.permission}`,
    details: [
      `${a.kind === 'apiKey' ? 'API key' : 'App'}: ${a.id}${appScope ? ` (${appScope} scope)` : ''}`,
      ...(read ? [`Reads: ${typeof read.scope === 'string' ? read.scope : JSON.stringify(read.scope)}${read.includeSecret ? ', secret items included' : ''}`] : []),
      ...warnings,
    ],
  });
  if (actor instanceof Response) return actor;
  try {
    const r = await grants.grant({ kind: a.kind as 'app' | 'apiKey', id: a.id }, a.permission, { by: actor.by, appScope, ...(read ? { read } : {}) });
    await auditOwner(actor, 'grant', { target: `${a.kind}:${a.id}`, detail: { permission: a.permission, appScope: appScope ?? null, changed: r.changed, ...(r.record.read ? { read: core.GrantStore.describeRead(r.record) } : {}) } });
    return jsonResponse({ ok: true, ...r, warnings });
  } catch (err) {
    return fail(err);
  }
};

export const DELETE: APIRoute = async (ctx) => {
  const a = await subjectArgs(ctx.request, ctx.url);
  if (a instanceof Response) return a;
  if (core.isAppAccessPermission(a.permission)) return revokeAppAccess(ctx, a);
  const actor = await ownerAction(ctx, {
    action: 'admin.revoke', level: 'session',
    payload: { subjectKind: a.kind, subjectId: a.id, permission: a.permission },
    title: `Revoke ${a.permission} from ${a.id}`,
  });
  if (actor instanceof Response) return actor;
  try {
    const removed = await core.getAuthServices().grants.revoke({ kind: a.kind as 'app' | 'apiKey', id: a.id }, a.permission);
    await auditOwner(actor, 'revoke', { target: `${a.kind}:${a.id}`, detail: { permission: a.permission, changed: !!removed } });
    return jsonResponse({ ok: true, changed: !!removed, removed });
  } catch (err) {
    return fail(err);
  }
};

type SubjectArgs = { kind: string; id: string; permission: string; src: Record<string, unknown> };
type RouteCtx = Parameters<APIRoute>[0];

const refuse = (e: core.AppAccessError) => jsonResponse(core.appAccessErrorBody(e), e.status);

/** POST {subjectId, permission:'apps.view', target}: the owner grants one app read access to one target (D104). */
async function grantAppAccess(ctx: RouteCtx, a: SubjectArgs): Promise<Response> {
  const target = typeof a.src['target'] === 'string' ? a.src['target'] : '';
  const mgr = core.getAppManager();
  const consumerName = mgr.registry.getById(a.id)?.name ?? a.id;
  const base = { consumer: a.id, consumerName, permission: a.permission, ...(target ? { target } : {}) };
  if (!core.isAppAccessPermission(a.permission)) {
    if ((core.RESERVED_APP_ACCESS_PERMISSIONS as readonly string[]).includes(a.permission)) return refuse(core.appAccessError('level-not-available', base));
    return jsonResponse({ error: 'invalid-request', message: `--target applies to app access (apps.view) only, not '${a.permission}'.` }, 400);
  }
  if (a.kind !== 'app') return jsonResponse({ error: 'invalid-request', message: `${a.permission} is granted to an app.` }, 400);
  if (!mgr.registry.getById(a.id)) return jsonResponse({ error: 'not-found', message: `No app ${a.id} is installed.` }, 404);
  if (!target) {
    return jsonResponse({ error: 'invalid-request', message: `${a.permission} is granted for one target app.`, hint: `aura grant perms ${a.id} ${a.permission} --target <app id>`, permission: a.permission }, 400);
  }
  const view = await liveAppView();
  const blocked = view.targetRefusal(a.id, target, { consumerName, permission: a.permission });
  if (blocked) return refuse(blocked);
  const warnings = view.declares(a.id) ? [] : [core.appAccessError('not-declared', base).hint!];
  const consumer = await view.binding(a.id);
  const targetInstallation = (await view.binding(target)).installationId;
  if (!consumer.installationId || !targetInstallation) {
    return jsonResponse({ error: 'conflict', message: `${!consumer.installationId ? a.id : target} has no installation record yet; start it once, then grant again.` }, 409);
  }
  const actor = await ownerAction(ctx, {
    action: 'admin.grant', level: 'session',
    payload: { subjectKind: 'app', subjectId: a.id, permission: a.permission, target, consumerInstallation: consumer.installationId, targetInstallation },
    title: `Let ${consumerName} read ${mgr.registry.getById(target)?.name ?? target}`,
    details: [
      `Reader: ${a.id}, on its server. AuraOS lets only reads through (GET and HEAD; no forms, no sockets); a read page of ${target} that changes data by itself would still run.`,
      `Reads: ${target}, everything you can see there: its pages and its read-only API. This can be sensitive content.`,
      ...warnings,
    ],
  });
  if (actor instanceof Response) return actor;
  try {
    const { grants } = core.getAuthServices();
    const r = await grants.grant({ kind: 'app', id: a.id }, a.permission, {
      by: actor.by, scope: core.appTargetScope(target, targetInstallation), installationId: consumer.installationId,
      ...(consumer.scope ? { appScope: consumer.scope } : {}),
    });
    await auditOwner(actor, 'grant', { target: `app:${a.id}`, detail: { permission: a.permission, target, appScope: consumer.scope ?? null } });
    return jsonResponse({ ok: true, ...r, warnings });
  } catch (err) {
    return fail(err);
  }
}

/** DELETE {subjectId, permission:'apps.view', target?}: revoke one target, or every target. Ends outstanding credentials at once. */
async function revokeAppAccess(ctx: RouteCtx, a: SubjectArgs): Promise<Response> {
  const target = typeof a.src['target'] === 'string' && a.src['target'] ? a.src['target'] : null;
  const actor = await ownerAction(ctx, {
    action: 'admin.revoke', level: 'session',
    payload: { subjectKind: a.kind, subjectId: a.id, permission: a.permission, target },
    title: target ? `Revoke ${a.permission} for ${target} from ${a.id}` : `Revoke ${a.permission} for every app from ${a.id}`,
  });
  if (actor instanceof Response) return actor;
  try {
    const { grants } = core.getAuthServices();
    const subject = { kind: 'app' as const, id: a.id };
    const had = (await grants.listFor(subject)).filter((g) => g.permission === a.permission && (!target || (g.scope?.kind === 'app' && g.scope.id === target)));
    if (target) await grants.revoke(subject, a.permission, core.appTargetScope(target, ''));
    else await grants.revoke(subject, a.permission);
    await auditOwner(actor, 'revoke', { target: `app:${a.id}`, detail: { permission: a.permission, target: target ?? '*', changed: had.length > 0 } });
    return jsonResponse({ ok: true, changed: had.length > 0, removed: had });
  } catch (err) {
    return fail(err);
  }
}
