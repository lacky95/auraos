import type { APIRoute } from 'astro';
import * as core from '@aura/core';
import { jsonResponse } from '../../../lib/appResponse.js';
import { readJson } from '../../../lib/notificationCaller.js';
import { adminOf, adminRecordBy, auditAdmin } from '../../../lib/auth.js';
import { ownerUiApp } from '../../../../server/gateway-identity.mjs';

/**
 * Admin grants of privileged permissions (core auth `GrantStore`).
 * Every method needs an admin session (`Authorization: Bearer aura-admin1.…`).
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
 * Takes effect on the very next request (no restart); emits
 * `permissions:changed`; audited as "admin (shared credential)".
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

export const GET: APIRoute = async () => {
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
  return jsonResponse({ privileged: core.PRIVILEGED_PERMISSIONS, grants: all, apps });
};

export const POST: APIRoute = async ({ request, url, locals }) => {
  const p = adminOf(locals);
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
  try {
    const readArg = a.src['readScope'] ?? (a.permission === 'notifications.read' ? a.src['scope'] : undefined);
    const read = a.permission === 'notifications.read' && readArg !== undefined
      ? { scope: readArg, includeSecret: a.src['includeSecret'] === true || a.src['includeSecret'] === 'true' }
      : undefined;
    const r = await grants.grant({ kind: a.kind as 'app' | 'apiKey', id: a.id }, a.permission, { by: adminRecordBy(p), appScope, ...(read ? { read } : {}) });
    await auditAdmin(p, 'grant', { target: `${a.kind}:${a.id}`, detail: { permission: a.permission, appScope: appScope ?? null, changed: r.changed, ...(r.record.read ? { read: core.GrantStore.describeRead(r.record) } : {}) } });
    return jsonResponse({ ok: true, ...r, warnings });
  } catch (err) {
    return fail(err);
  }
};

export const DELETE: APIRoute = async ({ request, url, locals }) => {
  const p = adminOf(locals);
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
