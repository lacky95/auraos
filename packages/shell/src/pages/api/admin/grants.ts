import type { APIRoute } from 'astro';
import * as core from '@aura/core';
import { jsonResponse } from '../../../lib/appResponse.js';
import { readJson } from '../../../lib/notificationCaller.js';
import { auditAdmin, requireAdmin } from '../../../lib/auth.js';

/**
 * Admin grants of privileged permissions (core auth `GrantStore`).
 * Every method needs an admin session (`Authorization: Bearer aura-admin1.…`).
 *
 *   GET    → { privileged, grants: GrantRecord[], apps: [{appId, name, scope,
 *             requested: [...], granted: [...], effective: [...]}] }
 *   POST   {subjectKind:'app'|'apiKey', subjectId, permission} → grant
 *            (app grants are pinned to the app's current install scope)
 *            `notifications.read` (phase 5) also needs `readScope`:
 *            "all" | "app:<id>,sender:<key>" | {apps:[…]} | {senders:[…]},
 *            plus `includeSecret` (default false). Re-granting replaces the scope.
 *   DELETE {subjectKind, subjectId, permission} (body or query) → revoke
 *
 * Takes effect on the very next request (no restart); emits
 * `permissions:changed`; audited as "admin (shared credential)".
 * Grantable: notifications.locked, notifications.popup, notifications.read.
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
  const permission = String(src['permission'] ?? '');
  if (!id || !permission) return jsonResponse({ error: 'subjectId (or appId) and permission are required' }, 400);
  return { kind, id, permission, src };
}

export const GET: APIRoute = async ({ request }) => {
  const p = await requireAdmin(request);
  if (p instanceof Response) return p;
  const { grants, authorizer } = core.getAuthServices();
  const all = await grants.listAll();
  const mgr = core.getAppManager();
  const apps = [];
  for (const m of mgr.registry.getAll()) {
    const requested = (m.permissions ?? []).filter((x: string) => core.isPrivilegedPermission(x));
    const mine = all.filter((g) => g.subject.kind === 'app' && g.subject.id === m.id);
    const granted = mine.map((g) => g.permission);
    const readRec = mine.find((g) => g.permission === 'notifications.read');
    if (requested.length === 0 && granted.length === 0 && !(m.permissions ?? []).includes('system.notifications')) continue;
    const probe = { kind: 'instance', appId: m.id, instanceId: `${m.id}-probe`, verification: 'verified' } as const;
    const effective: string[] = [];
    for (const perm of core.PRIVILEGED_PERMISSIONS) {
      if ((await authorizer.authorize(probe, perm)).allow) effective.push(perm);
    }
    apps.push({
      appId: m.id, name: m.name, scope: mgr.registry.getScopeId(m.id) ?? null,
      sends: (m.permissions ?? []).includes('system.notifications'),
      requested, granted, effective,
      // Phase 5: what a notifications.read grant covers ("all", "app:x,sender:y", "+secret").
      ...(readRec?.read ? { read: { ...readRec.read, label: core.GrantStore.describeRead(readRec) } } : {}),
    });
  }
  apps.sort((a, b) => a.appId.localeCompare(b.appId));
  return jsonResponse({ privileged: core.PRIVILEGED_PERMISSIONS, grants: all, apps });
};

export const POST: APIRoute = async ({ request, url }) => {
  const p = await requireAdmin(request);
  if (p instanceof Response) return p;
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
    if (!(m.permissions ?? []).includes(a.permission)) {
      warnings.push(`${a.id} does not request '${a.permission}' in its manifest — the grant has no effect until it does`);
    }
  } else if (a.kind === 'apiKey') {
    const k = await apiKeys.get(a.id);
    if (!k) return jsonResponse({ error: `unknown API key ${a.id}` }, 404);
    if (k.revokedAt) return jsonResponse({ error: `API key ${a.id} is revoked` }, 409);
  }
  try {
    const readArg = a.src['readScope'] ?? (a.permission === 'notifications.read' ? a.src['scope'] : undefined);
    const read = a.permission === 'notifications.read' && readArg !== undefined
      ? { scope: readArg, includeSecret: a.src['includeSecret'] === true || a.src['includeSecret'] === 'true' }
      : undefined;
    const r = await grants.grant({ kind: a.kind as 'app' | 'apiKey', id: a.id }, a.permission, { by: core.adminAttribution(p), appScope, ...(read ? { read } : {}) });
    await auditAdmin(p, 'grant', { target: `${a.kind}:${a.id}`, detail: { permission: a.permission, appScope: appScope ?? null, changed: r.changed, ...(r.record.read ? { read: core.GrantStore.describeRead(r.record) } : {}) } });
    return jsonResponse({ ok: true, ...r, warnings });
  } catch (err) {
    return fail(err);
  }
};

export const DELETE: APIRoute = async ({ request, url }) => {
  const p = await requireAdmin(request);
  if (p instanceof Response) return p;
  const a = await subjectArgs(request, url);
  if (a instanceof Response) return a;
  try {
    const removed = await core.getAuthServices().grants.revoke({ kind: a.kind as 'app' | 'apiKey', id: a.id }, a.permission);
    await auditAdmin(p, 'revoke', { target: `${a.kind}:${a.id}`, detail: { permission: a.permission, changed: !!removed } });
    return jsonResponse({ ok: true, changed: !!removed, removed });
  } catch (err) {
    return fail(err);
  }
};
