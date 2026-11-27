import type { APIRoute } from 'astro';
import { dirname } from 'node:path';
import * as core from '@aura/core';
import { auditOwner, ownerAction } from '../../../lib/approvals/admin.ts';
import { failureResponse } from '../../../lib/appResponse.ts';

/**
 * The one-shot migration of local grant edits into the settings overlay (Phase 6 O,
 * core release/overlayMigration.ts): `aura admin overlay report|apply`.
 *
 *   GET  /api/admin/overlay            → the report (read-only): per system app the ops its local
 *                                        edit becomes and every other differing field; the
 *                                        registry's local edits and backup; its digest
 *   POST /api/admin/overlay {digest}   → apply exactly that report (the owner decides; the host
 *                                        operator directly); audited `overlay.migrated`
 *
 * The effective grants do not change: the ops carry exactly what the edited manifests said.
 */

const DIGEST_RE = /^[0-9a-f]{64}$/;

function migrationOptions(mgr: ReturnType<typeof core.getAppManager>): core.OverlayMigrationOptions {
  const systemAppsDir = mgr.registry.getAppsDir();
  return { repoRoot: dirname(systemAppsDir), systemAppsDir, dataRoot: mgr.getDataDir() };
}

export const GET: APIRoute = async (ctx) => {
  const actor = await ownerAction(ctx, {
    action: 'admin.read', payload: { view: 'overlay-migration' }, level: 'session', title: 'Show the settings overlay migration report',
  });
  if (actor instanceof Response) return actor;
  return json(core.overlayMigrationReport(migrationOptions(core.getAppManager())));
};

export const POST: APIRoute = async (ctx) => {
  let body: { digest?: unknown };
  try { body = await ctx.request.json() as { digest?: unknown }; }
  catch { return json({ error: 'invalid-json' }, 400); }
  if (typeof body.digest !== 'string' || !DIGEST_RE.test(body.digest)) {
    return json({
      error: 'invalid-digest', category: body.digest === undefined ? 'missing-input' : 'invalid-input',
      message: '`digest` must be the digest `aura admin overlay report` printed.',
    }, 400);
  }
  const mgr = core.getAppManager();
  const opts = migrationOptions(mgr);
  const report = core.overlayMigrationReport(opts);
  if (report.digest !== body.digest) {
    return json({ error: 'digest-mismatch', digest: report.digest, message: 'The state changed since that report: review the new one.' }, 409);
  }
  const actor = await ownerAction(ctx, {
    action: 'admin.change', level: 'session', payload: { op: 'overlay.migrate', digest: report.digest },
    title: 'Move local grant edits into the settings overlay',
    details: [
      ...report.apps.map((a) => `${a.appId}: ${a.fields.join(', ') || 'no grant change'}${a.restore ? ' (manifest restored)' : `; kept in place: ${a.otherFields.join(', ')}`}`),
      ...report.registry.map((r) => `${r.file}: ${r.action === 'move-aside' ? 'moved aside' : 'reported only'}`),
      'The effective grants stay the same.',
    ],
  });
  if (actor instanceof Response) return actor;
  let result: core.OverlayMigrationResult;
  try { result = core.applyOverlayMigration(opts, report.digest); }
  catch (err) {
    await auditOwner(actor, 'overlay.migrated', { target: 'system:overlay', outcome: 'failed', detail: { digest: report.digest, error: (err as Error).message } });
    // The migration's own refusals say what to do; anything else is redacted for all but the owner.
    if (err instanceof core.OverlayMigrationError) {
      return err.code === 'digest-mismatch'
        ? json({ error: err.code, message: 'The state changed since that report: review the new one.' }, 409)
        : json({ error: err.code, message: 'This install runs from a release: there is nothing to migrate.' }, 422);
    }
    return failureResponse(ctx, err);
  }
  const reloadErrors: string[] = [];
  for (const appId of new Set([...result.overlays, ...result.restored])) {
    try { mgr.reloadManifest(appId); mgr.refreshInstanceTools(appId); } catch { reloadErrors.push(appId); }
  }
  await auditOwner(actor, 'overlay.migrated', {
    target: 'system:overlay', outcome: 'ok',
    detail: { digest: report.digest, fields: report.fields, overlays: result.overlays, restored: result.restored, movedAside: result.movedAside.map((m) => m.file) },
  });
  return json({ ...result, digest: report.digest, ...(reloadErrors.length ? { reloadErrors } : {}) });
};

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload, null, 2), { status, headers: { 'Content-Type': 'application/json' } });
}
