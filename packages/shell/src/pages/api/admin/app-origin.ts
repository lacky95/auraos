import type { APIRoute } from 'astro';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
// Namespace import: the running shell may cache a core build without newer exports.
import * as core from '@aura/core';
import { auditAdmin, requireAdmin } from '../../../lib/auth.js';

/**
 * Origin ids of the installed apps — the engine behind `aura dev origin`.
 *
 *   GET                         → { apps: [{ appId, originId, scope, mutable, active }] }
 *                                 every app dir in every scope (shadowed ones too)
 *   POST { mode: 'assign', appIds?: string[], all?: true, scope? }
 *        → give apps WITHOUT an originId a new one. Never touches an existing
 *          originId, so no admin needed: it only records what an app already is.
 *   POST { mode: 'reassign', appIds: [one], scope?, originId? }
 *        → replace an app's originId: an explicit identity change (it stops
 *          being recognised as the artifact it was). Admin only, audited.
 *
 * System apps live in the immutable in-repo scope: they get their originId in
 * the AuraOS repo, never here. Lives in the shell for the same reason as
 * manifest-edit / clone-app — a sandboxed CLI can't see other apps' dirs.
 */

interface Body {
  mode?:     'assign' | 'reassign';
  appIds?:   string[];
  all?:      boolean;
  scope?:    core.ScopeId;
  originId?: string;
}

interface Row { appId: string; originId: string | null; scope: core.ScopeId; mutable: boolean; active: boolean }

function listRows(): { rows: Row[]; scopes: core.ScopeDefinition[]; mgr: ReturnType<typeof core.getAppManager> } {
  const mgr = core.getAppManager();
  const scopes = mgr.getScopeDefinitions();
  const rows: Row[] = [];
  for (const s of scopes) {
    for (const a of core.scanInstalledIdentities(s.appsDir, s.id)) {
      const winner = mgr.registry.getById(a.appId)?.scopeId;
      rows.push({ ...a, mutable: !s.immutable, active: winner === s.id });
    }
  }
  rows.sort((a, b) => a.appId.localeCompare(b.appId) || a.scope.localeCompare(b.scope));
  return { rows, scopes, mgr };
}

export const GET: APIRoute = async () => {
  try { return json({ apps: listRows().rows }); }
  catch (err) { return json({ error: 'app-manager-unavailable', message: (err as Error).message }, 503); }
};

export const POST: APIRoute = async ({ request }) => {
  let body: Body;
  try { body = await request.json() as Body; }
  catch { return json({ error: 'invalid-json' }, 400); }
  const mode = body.mode;
  if (mode !== 'assign' && mode !== 'reassign') {
    return json({ error: 'invalid-mode', message: "mode must be 'assign' or 'reassign'." }, 400);
  }
  if (body.originId !== undefined && !core.isOriginId(body.originId)) {
    return json({ error: 'invalid-origin-id', message: 'originId must be a UUID.' }, 400);
  }

  let ctx: ReturnType<typeof listRows>;
  try { ctx = listRows(); }
  catch (err) { return json({ error: 'app-manager-unavailable', message: (err as Error).message }, 503); }

  let admin: Awaited<ReturnType<typeof requireAdmin>> | null = null;
  if (mode === 'reassign') {
    if (!Array.isArray(body.appIds) || body.appIds.length !== 1 || body.all) {
      return json({ error: 'one-app', message: 'reassign changes the identity of ONE app — pass exactly one appId.' }, 400);
    }
    admin = await requireAdmin(request);
    if (admin instanceof Response) return admin;
  } else if (body.originId !== undefined) {
    return json({ error: 'invalid-origin-id', message: 'assign generates the originId; pass one only with reassign.' }, 400);
  }

  // Targets: the named apps (their active copy, or the given scope) or all.
  let targets: Row[];
  if (body.all) {
    targets = ctx.rows.filter((r) => (body.scope ? r.scope === body.scope : true));
  } else {
    if (!Array.isArray(body.appIds) || body.appIds.length === 0 || body.appIds.some((id) => typeof id !== 'string' || !core.APP_ID_PATTERN.test(id))) {
      return json({ error: 'invalid-app-id', message: 'pass appIds (reverse-domain ids) or all: true.' }, 400);
    }
    targets = [];
    for (const id of body.appIds) {
      const copies = ctx.rows.filter((r) => r.appId === id);
      const pick = body.scope ? copies.find((r) => r.scope === body.scope) : copies.find((r) => r.active) ?? copies[copies.length - 1];
      if (!pick) return json({ error: 'not-found', message: `${id} is not installed${body.scope ? ` in scope ${body.scope}` : ''}.` }, 404);
      targets.push(pick);
    }
  }

  const results: Array<{ appId: string; scope: core.ScopeId; originId: string | null; previous: string | null; changed: boolean; skipped?: string }> = [];
  for (const t of targets) {
    if (!t.mutable) {
      results.push({ appId: t.appId, scope: t.scope, originId: t.originId, previous: t.originId, changed: false,
        skipped: t.originId ? undefined : 'system app — its originId is set in the AuraOS repo' });
      continue;
    }
    const def = ctx.scopes.find((s) => s.id === t.scope)!;
    const path = join(def.appsDir, t.appId, 'app.manifest.json');
    if (!existsSync(path)) {
      results.push({ appId: t.appId, scope: t.scope, originId: null, previous: null, changed: false, skipped: 'manifest missing' });
      continue;
    }
    try {
      const r = core.setOriginIdInFile(path, { mode, ...(body.originId ? { originId: body.originId } : {}) });
      results.push({ appId: t.appId, scope: t.scope, originId: r.originId, previous: r.previous, changed: r.changed });
      if (r.changed && t.active) { try { ctx.mgr.reloadManifest(t.appId); } catch { /* watcher reconciles */ } }
      if (r.changed && mode === 'reassign') {
        await auditAdmin(admin as Exclude<typeof admin, Response | null>, 'app.origin-reassign', {
          target: `app:${t.appId}`, detail: { scope: t.scope, from: r.previous, to: r.originId },
        });
      }
    } catch (err) {
      results.push({ appId: t.appId, scope: t.scope, originId: t.originId, previous: t.originId, changed: false, skipped: (err as Error).message });
    }
  }
  return json({ ok: true, mode, results });
};

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload, null, 2), { status, headers: { 'Content-Type': 'application/json' } });
}
