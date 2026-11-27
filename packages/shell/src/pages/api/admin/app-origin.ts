import type { APIRoute } from 'astro';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
// Namespace import: the running shell may cache a core build without newer exports.
import * as core from '@aura/core';
import { auditOwner, ownerAction, type OwnerActor } from '../../../lib/approvals/admin.ts';

/**
 * Origin ids of the installed apps — the engine behind `aura dev origin`.
 *
 *   GET                         → { apps: [{ appId, originId, scope, mutable, active }] }
 *                                 every app dir in every scope (shadowed ones too)
 *   POST { mode: 'assign', appIds?: string[], all?: true, scope? }
 *        → give apps WITHOUT an originId a new one. Never touches an existing
 *          originId, so no owner decision: it only records what an app already is.
 *   POST { mode: 'reassign', appIds: [one], scope?, originId? }
 *        → replace an app's originId: an explicit identity change (it stops
 *          being recognised as the artifact it was). The owner's: from an app
 *          it needs the owner's approval (D50, lib/approvals/admin.ts). Audited.
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

export const POST: APIRoute = async (context) => {
  const { request } = context;
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

  if (mode === 'reassign') {
    if (!Array.isArray(body.appIds) || body.appIds.length !== 1 || body.all) {
      return json({ error: 'one-app', message: 'reassign changes the identity of ONE app — pass exactly one appId.' }, 400);
    }
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

  // A reassign is the owner's decision on exactly this app and id (D50).
  let admin: OwnerActor | null = null;
  if (mode === 'reassign') {
    const t = targets[0]!;
    const decided = await ownerAction(context, {
      action: 'admin.change', level: 'session',
      payload: { op: 'app-origin.reassign', appId: t.appId, scope: t.scope, originId: body.originId ?? null },
      title: `Give ${t.appId} a new origin id`,
      details: [`Scope: ${t.scope}`, `From: ${t.originId ?? 'none'}`, `To: ${body.originId ?? 'a new random id'}`,
        'Updates and store installs stop recognising it as the app it was.'],
    });
    if (decided instanceof Response) return decided;
    admin = decided;
  }

  const results: Array<{
    appId: string; scope: core.ScopeId; originId: string | null; previous: string | null; changed: boolean; skipped?: string;
    installationId?: string | null; previousInstallationId?: string | null; note?: string;
  }> = [];
  const installationOf = async (appId: string, scope: core.ScopeId) =>
    (await core.getAppHostServices().registry.findInstallation(appId, scope).catch(() => null))?.installationId ?? null;
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
      const before = await installationOf(t.appId, t.scope);
      const r = core.setOriginIdInFile(path, { mode, ...(body.originId ? { originId: body.originId } : {}) });
      const row: (typeof results)[number] = { appId: t.appId, scope: t.scope, originId: r.originId, previous: r.previous, changed: r.changed };
      results.push(row);
      if (r.changed) {
        // The manifest changed in place (no install): re-read it, then bring the
        // installation in line now, not at the next shell start (D2). A new
        // origin is another app: a new installation, the grants revoked.
        if (t.active) { try { ctx.mgr.reloadManifest(t.appId); } catch { /* watcher reconciles */ } }
        const hostError = await ctx.mgr.syncAppHost(t.appId, t.scope);
        row.previousInstallationId = before;
        row.installationId = await installationOf(t.appId, t.scope);
        if (hostError) row.note = `the installation follows at the next shell start (${hostError})`;
        else if (before && row.installationId && row.installationId !== before) {
          row.note = `new installation ${row.installationId}: grants given to ${t.appId} were revoked; patches and workspaces stay with the previous installation ${before}`;
        }
      }
      if (r.changed && mode === 'reassign') {
        await auditOwner(admin, 'app.origin-reassign', {
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
