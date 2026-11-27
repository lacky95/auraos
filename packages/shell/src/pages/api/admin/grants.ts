import type { APIRoute } from 'astro';
import * as core from '@aura/core';
import { jsonResponse } from '../../../lib/appResponse.js';
import { readJson } from '../../../lib/notificationCaller.js';
import { auditOwner, grantLevel, ownerAction } from '../../../lib/approvals/admin.ts';
import { ownerUiApp } from '../../../../server/gateway-identity.mjs';

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
 *   POST   {subjectKind:'app'|'apiKey'|'user', subjectId, permission} → grant
 *            (a `user` subject, I.2: a member's app.use:<installationId> or
 *            app.jump:<installationId> only; `aura admin user grant` on the host)
 *            (app grants are pinned to the app's current install scope and to its
 *            installation, repaired when missing: a new app under the same id
 *            inherits nothing, S1)
 *            `notifications.read` (phase 5) also needs `readScope`:
 *            "all" | "app:<id>,sender:<key>" | {apps:[…]} | {senders:[…]},
 *            plus `includeSecret` (default false). Re-granting replaces the scope.
 *   DELETE {subjectKind, subjectId, permission} (body or query) → revoke
 *
 * Takes effect on the very next request (no restart); emits
 * `permissions:changed`; the record and the audit name the owner (or the
 * operator) who decided, and the requester of an approved request.
 * Grantable: notifications.locked, notifications.popup, notifications.read,
 * notifications.systemModal (phase 6; revoking it releases that sender's modals),
 * context.read:<KEY> (Phase 5 stream C: a system Context key reaches the app).
 * An app must also REQUEST the permission in its manifest for the grant to count
 * (a Context key: declare it in `context[]`).
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
    const declared = [...new Set([
      ...(m.permissions ?? []).map((x: string) => core.canonicalPermission(x)).filter((x: string) => core.isPrivilegedPermission(x)),
      // Stream C: each declared Context key is requested as context.read:<KEY>.
      ...(m.context ?? []).map((k: string) => core.contextReadPermission(k)),
    ])];
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
  return jsonResponse({ privileged: core.PRIVILEGED_PERMISSIONS, grants: all, apps });
};

export const POST: APIRoute = async (ctx) => {
  const { request, url } = ctx;
  const a = await subjectArgs(request, url);
  if (a instanceof Response) return a;
  const { grants, apiKeys } = core.getAuthServices();
  const warnings: string[] = [];
  let appScope: string | undefined;
  let installationId: string | undefined;
  if (a.kind === 'app') {
    const mgr = core.getAppManager();
    const m = mgr.registry.getById(a.id);
    if (!m) return jsonResponse({ error: `unknown app ${a.id}` }, 404);
    appScope = mgr.registry.getScopeId(a.id);
    // S1: the grant is given to this installation of the app only.
    try {
      const ensured = await mgr.ensureInstallation(a.id);
      if (!ensured.installation) return jsonResponse({ error: ensured.error }, 409);
      installationId = ensured.installation.installationId;
    } catch (err) {
      return jsonResponse({ error: `${a.id}: its installation record can't be read (${(err as Error).message})` }, 503);
    }
    if (core.CONTEXT_READ_PERMISSION_RE.test(a.permission)) {
      // Stream C: a Context key counts only while the app declares it in context[].
      const key = a.permission.slice('context.read:'.length);
      if (!(m.context ?? []).includes(key)) warnings.push(`${a.id} does not declare '${key}' in its manifest context[] — the grant has no effect until it does`);
    } else if (!(m.permissions ?? []).some((x: string) => core.canonicalPermission(x) === a.permission)) {
      warnings.push(`${a.id} does not request '${a.permission}' in its manifest — the grant has no effect until it does`);
    }
  } else if (a.kind === 'apiKey') {
    const k = await apiKeys.get(a.id);
    if (!k) return jsonResponse({ error: `unknown API key ${a.id}` }, 404);
    if (k.revokedAt) return jsonResponse({ error: `API key ${a.id} is revoked` }, 409);
  } else if (a.kind === 'user') {
    // I.2 (C7): a member's app.use / app.jump; the owner holds every app already.
    const u = await core.getAuthServices().users.getUser(a.id);
    if (!u) return jsonResponse({ error: `unknown user ${a.id}` }, 404);
    if (u.role === 'owner') return jsonResponse({ error: 'the owner holds every app already; grants are for members' }, 409);
  }
  const readArg = a.src['readScope'] ?? (a.permission === 'notifications.read' ? a.src['scope'] : undefined);
  const read = a.permission === 'notifications.read' && readArg !== undefined
    ? { scope: readArg, includeSecret: a.src['includeSecret'] === true || a.src['includeSecret'] === 'true' }
    : undefined;
  const actor = await ownerAction(ctx, {
    action: 'admin.grant', level: grantLevel(a.permission),
    payload: { subjectKind: a.kind, subjectId: a.id, permission: a.permission, ...(installationId ? { installationId } : {}), ...(read ? { read } : {}) },
    title: `Grant ${a.id} ${a.permission}`,
    details: [
      `${a.kind === 'apiKey' ? 'API key' : 'App'}: ${a.id}${appScope ? ` (${appScope} scope)` : ''}`,
      ...(installationId ? [`For this installation of it only (${installationId}): an app installed later under the same id must be granted again.`] : []),
      ...(read ? [`Reads: ${typeof read.scope === 'string' ? read.scope : JSON.stringify(read.scope)}${read.includeSecret ? ', secret items included' : ''}`] : []),
      ...warnings,
    ],
  });
  if (actor instanceof Response) return actor;
  try {
    const r = await grants.grant({ kind: a.kind as 'app' | 'apiKey' | 'user', id: a.id }, a.permission, {
      by: actor.by, appScope, ...(installationId ? { installationId } : {}), ...(read ? { read } : {}),
    });
    await auditOwner(actor, 'grant', { target: `${a.kind}:${a.id}`, detail: { permission: a.permission, appScope: appScope ?? null, installationId: installationId ?? null, changed: r.changed, ...(r.record.read ? { read: core.GrantStore.describeRead(r.record) } : {}) } });
    return jsonResponse({ ok: true, ...r, warnings });
  } catch (err) {
    return fail(err);
  }
};

export const DELETE: APIRoute = async (ctx) => {
  const a = await subjectArgs(ctx.request, ctx.url);
  if (a instanceof Response) return a;
  const actor = await ownerAction(ctx, {
    action: 'admin.revoke', level: 'session',
    payload: { subjectKind: a.kind, subjectId: a.id, permission: a.permission },
    title: `Revoke ${a.permission} from ${a.id}`,
  });
  if (actor instanceof Response) return actor;
  try {
    const removed = await core.getAuthServices().grants.revoke({ kind: a.kind as 'app' | 'apiKey' | 'user', id: a.id }, a.permission);
    await auditOwner(actor, 'revoke', { target: `${a.kind}:${a.id}`, detail: { permission: a.permission, changed: !!removed } });
    return jsonResponse({ ok: true, changed: !!removed, removed });
  } catch (err) {
    return fail(err);
  }
};
