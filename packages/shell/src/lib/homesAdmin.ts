/**
 * The owner's home operations (Phase 5 stream H; D65 §13, Q15, P5-2):
 *
 *   POST /api/admin/identity/ownership-apply {digest}
 *        the targeted chown of the dry-run ownership report, for the digest
 *        the owner reviewed; a changed report applies nothing (409 + digest)
 *   POST /api/admin/homes/import {appId, paths[], userId?, includePersonal?, apply?}
 *        the selective copy from the owner's Private Home into an App Home;
 *        without `apply` a dry run (an owner view); with it an owner action
 *   POST /api/admin/homes/reset {appId, userId?}
 *        an App Home removed; the next start creates it empty
 *
 * Every change is an owner action at `fresh` (the password, or the host
 * operator) and audited. Core does the work (homes/appHomeAdmin.ts,
 * identity/ownershipApply.ts); this module only gathers inputs.
 */
import * as core from '@aura/core';
import { auditOwner, ownerAction, type OwnerActor } from './approvals/admin.ts';
import { json } from './approvals/service.ts';
import { ownershipReport } from './identityReports.ts';
import { systemModeState } from './systemMode.ts';

type Ctx = Parameters<typeof ownerAction>[0];
const dataDir = (): string => process.env['AURA_DATA_DIR'] ?? '/data';
const USER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

async function body(ctx: Ctx): Promise<Record<string, unknown> | Response> {
  try {
    const b = await ctx.request.json();
    if (!b || typeof b !== 'object' || Array.isArray(b)) return json({ error: 'invalid-request', message: 'body must be a JSON object' }, 400);
    return b as Record<string, unknown>;
  } catch { return json({ error: 'invalid-request', message: 'body must be JSON' }, 400); }
}

function denied(err: unknown): Response {
  if (err instanceof core.HomeDeniedError) return json({ error: err.reason, message: err.message }, 409);
  if (err instanceof core.RuntimeCapabilityError) return json({ error: err.code, message: err.message }, 409);
  if (err instanceof core.AppHomeAdminError) return json({ error: err.code, message: err.message }, err.code === 'not-found' ? 404 : 400);
  return json({ error: 'failed', message: (err as Error).message }, 500);
}

/** `only` conditions of the ownership report that hold on this system. */
function holds(only: string): boolean {
  if (only === 'when Developer Mode is on') return systemModeState().mode === 'developer';
  return false;
}

export async function postOwnershipApply(ctx: Ctx): Promise<Response> {
  const b = await body(ctx);
  if (b instanceof Response) return b;
  const digest = b['digest'];
  if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) {
    return json({ error: 'invalid-request', message: 'expected { digest }: the digest of the dry-run report you reviewed' }, 400);
  }
  const report = await ownershipReport();
  if (report.digest !== digest) {
    return json({ error: 'digest-mismatch', message: 'The ownership report changed since you reviewed it: review the new one (aura admin homes ownership --dry-run).', digest: report.digest }, 409);
  }
  const { rows, notApplied } = core.selectApplyRows(report, { holds });
  if (!rows.length) return json({ ok: true, changed: false, digest, rows: [], notApplied });
  const actor = await ownerAction(ctx, {
    action: 'admin.change', payload: { ownershipApply: { digest } }, level: 'fresh',
    title: `Apply the ownership report (${rows.length} row${rows.length === 1 ? '' : 's'})`,
    details: [
      ...rows.slice(0, 8).map((r) => `${r.path} → ${r.to.uid}:${r.to.gid}${r.recursive ? ' (recursive)' : ''}`),
      ...(rows.length > 8 ? [`…and ${rows.length - 8} more`] : []),
      'Every change is journaled, so it can be reverted exactly. Nothing outside these rows changes.',
    ],
  });
  if (actor instanceof Response) return actor;
  try {
    const r = await core.runOwnershipApply(dataDir(), digest, rows);
    await auditOwner(actor, core.HOME_AUDIT_ACTIONS.ownershipApplied, {
      target: `ownership:${digest.slice(0, 12)}`,
      detail: { rows: r.rows.map((x) => ({ path: x.path, kind: x.kind, changed: x.changed, skipped: x.skipped })), journal: r.journal },
    });
    return json({ ok: true, changed: true, digest, journal: r.journal, rows: r.rows, notApplied });
  } catch (err) {
    await auditOwner(actor, core.HOME_AUDIT_ACTIONS.ownershipApplied, { target: `ownership:${digest.slice(0, 12)}`, outcome: 'failed' });
    return denied(err);
  }
}

/**
 * Stream T, the 5-main deploy's recovery: restore one ownership journal
 * exactly (previous owner and mode of every entry, newest first). The
 * owner's decision at `fresh`, audited; the journal is named by its file
 * name in the journal directory only.
 */
export async function postOwnershipRevert(ctx: Ctx): Promise<Response> {
  const b = await body(ctx);
  if (b instanceof Response) return b;
  const journal = typeof b['journal'] === 'string' ? core.ownershipJournalPath(dataDir(), b['journal']) : null;
  if (!journal) return json({ error: 'invalid-request', message: 'expected { journal }: a journal name from the apply (aura admin homes ownership --apply)' }, 400);
  const name = journal.split('/').pop()!;
  const actor = await ownerAction(ctx, {
    action: 'admin.change', payload: { ownershipRevert: { journal: name } }, level: 'fresh',
    title: `Revert the ownership apply ${name}`,
    details: ['Every entry of that journal gets its previous owner and mode back (the release before 5-main reads them as root).'],
  });
  if (actor instanceof Response) return actor;
  try {
    const r = core.revertOwnershipJournal(journal);
    await auditOwner(actor, core.HOME_AUDIT_ACTIONS.ownershipReverted, { target: `ownership-journal:${name.slice(0, 40)}`, detail: { restored: r.restored, skipped: r.skipped.length } });
    return json({ ok: true, journal: name, restored: r.restored, skipped: r.skipped });
  } catch (err) {
    await auditOwner(actor, core.HOME_AUDIT_ACTIONS.ownershipReverted, { target: `ownership-journal:${name.slice(0, 40)}`, outcome: 'failed' });
    return denied(err);
  }
}

function appTarget(b: Record<string, unknown>): { appId: string; userId?: string } | Response {
  const { appId, userId } = b as { appId?: unknown; userId?: unknown };
  if (typeof appId !== 'string' || !appId) return json({ error: 'invalid-request', message: 'expected { appId }' }, 400);
  if (userId !== undefined && (typeof userId !== 'string' || !USER_ID.test(userId))) return json({ error: 'invalid-request', message: 'invalid userId' }, 400);
  return { appId, ...(typeof userId === 'string' ? { userId } : {}) };
}

export async function postHomesImport(ctx: Ctx): Promise<Response> {
  const b = await body(ctx);
  if (b instanceof Response) return b;
  const t = appTarget(b);
  if (t instanceof Response) return t;
  const paths = b['paths'];
  if (!Array.isArray(paths) || !paths.length || paths.length > 64 || !paths.every((p) => typeof p === 'string')) {
    return json({ error: 'invalid-request', message: 'expected { paths: [...] }: 1 to 64 paths relative to the home' }, 400);
  }
  const apply = b['apply'] === true;
  const includePersonal = b['includePersonal'] === true;
  const mgr = core.getAppManager();
  if (!mgr.registry.getById(t.appId)) return json({ error: 'not-found', message: `unknown app: ${t.appId}` }, 404);
  // The source is the owner's Private Home: today's shared home (Q15).
  const source = core.userHomeDir(dataDir(), core.DEFAULT_OWNER_ID);
  const actor = await ownerAction(ctx, apply ? {
    action: 'admin.change', payload: { homesImport: { appId: t.appId, paths, includePersonal } }, level: 'fresh',
    title: `Copy ${paths.length} path(s) from your home into ${t.appId}'s App Home`,
    details: [
      ...(paths as string[]).slice(0, 8),
      includePersonal ? 'Includes personal logins: the app can then act with them (D66 prefers a fresh login in the app).' : 'Personal logins are left out.',
      'Copied, never moved: your home is not changed. Nothing in the App Home is overwritten.',
    ],
  } : {
    action: 'admin.read', payload: { view: 'homes-import-dry-run' }, level: 'session', title: 'Show what a home import would copy',
  });
  if (actor instanceof Response) return actor;
  try {
    const { installationId, home, running } = await mgr.resolveAppHome(t.appId, t.userId ? { userId: t.userId } : {});
    if (apply && running.length) {
      return json({ error: 'running', message: `Stop ${t.appId} first (${running.join(', ')}): its App Home is in use.` }, 409);
    }
    const r = core.importIntoAppHome({ source, target: home.hostPath!, paths: paths as string[], owner: { uid: home.uid, gid: home.gid }, apply, includePersonal });
    if (apply) {
      await auditOwner(actor as OwnerActor, core.HOME_AUDIT_ACTIONS.imported, {
        target: `installation:${installationId}`,
        detail: { appId: t.appId, paths: r.items.map((i) => ({ path: i.path, action: i.action, files: i.files })), includePersonal },
      });
    }
    return json({ ok: true, appId: t.appId, installationId, kind: home.kind, ...r });
  } catch (err) { return denied(err); }
}

export async function postHomesReset(ctx: Ctx): Promise<Response> {
  const b = await body(ctx);
  if (b instanceof Response) return b;
  const t = appTarget(b);
  if (t instanceof Response) return t;
  const mgr = core.getAppManager();
  if (!mgr.registry.getById(t.appId)) return json({ error: 'not-found', message: `unknown app: ${t.appId}` }, 404);
  let resolved;
  try { resolved = await mgr.resolveAppHome(t.appId, t.userId ? { userId: t.userId } : {}); } catch (err) { return denied(err); }
  if (resolved.running.length) {
    return json({ error: 'running', message: `Stop ${t.appId} first (${resolved.running.join(', ')}): its App Home is in use.` }, 409);
  }
  const actor = await ownerAction(ctx, {
    action: 'admin.change', payload: { homesReset: { appId: t.appId, installationId: resolved.installationId, userId: t.userId ?? null } }, level: 'fresh',
    title: `Reset ${t.appId}'s App Home${t.userId ? ` for ${t.userId}` : ''}`,
    details: ['Everything in it is deleted (logins and settings the app keeps there). The app starts with an empty home. Your Private Home and the app\'s data are not touched.'],
  });
  if (actor instanceof Response) return actor;
  try {
    const removed = core.resetAppHome(dataDir(), resolved.home.hostPath!);
    await auditOwner(actor, core.HOME_AUDIT_ACTIONS.reset, {
      target: `installation:${resolved.installationId}`, detail: { appId: t.appId, kind: resolved.home.kind, removed },
    });
    return json({ ok: true, appId: t.appId, installationId: resolved.installationId, kind: resolved.home.kind, removed });
  } catch (err) { return denied(err); }
}

/**
 * Uninstall with `deleteHome` (D65 §13, "explicit keep or delete"): looked
 * up before the app goes, deleted after. Default: kept.
 */
export async function installationBeforeRemove(appId: string): Promise<string | null> {
  const mgr = core.getAppManager();
  const scope = mgr.registry.getScopeId(appId);
  if (!scope) return null;
  try { return (await core.getAppHostServices().registry.findInstallation(appId, scope))?.installationId ?? null; } catch { return null; }
}

export async function deleteHomesAfterRemove(appId: string, installationId: string | null): Promise<boolean> {
  if (!installationId) return false;
  const removed = core.deleteInstallationHomes(dataDir(), installationId);
  console.log(`[homes] ${appId}: App Homes of installation ${installationId} ${removed ? 'deleted' : 'were not there'} (uninstall --delete-home)`);
  return removed;
}
