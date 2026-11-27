/**
 * The owner's per-installation runAs flip (P5-3, stream A):
 *
 *   POST /api/admin/apps/run-as {appId, runAs: 'app' | 'root'}            the dry run (when the uid changes)
 *   POST /api/admin/apps/run-as {appId, runAs, digest}                    the flip, with its data migration
 *   POST /api/admin/apps/run-as {appId, recover: true}                    an interrupted migration restored
 *
 * An owner action at `fresh` (the password, or the host operator),
 * compare-and-set on the installation record, audited
 * (`app.run-as-changed`).
 *
 * Owner decision 5-main, "run-as reversible": a flip that changes the uid
 * (root -> app, app -> root) moves the app's managed storage with it, through
 * the reviewed ownership migration (core identity/runAsOwnership.ts): a dry
 * run with a digest first; the owner approves exactly that digest; then the
 * app's instances and the instances that mount its data are stopped, the
 * apply runs journaled (a pending marker on the record first), the record is
 * flipped, and what ran is started again, only after all that succeeded. A
 * failed apply is restored from its journal and the app stays stopped; an
 * interrupted one keeps the marker, so the app does not start until
 * `--recover` restores the journal. The flip back restores the earlier
 * migration's journal exactly where it can. No capability is added anywhere.
 *
 * Owner decision 5-main item 3: for an app whose manifest REQUESTS root
 * (`execution`, core identity/execution.ts), the flip to `root` is the
 * owner's approval of exactly that request: it records the config digest on
 * the installation (`execution`) and is audited `app.execution-approved` too;
 * refused while the D64 switch `app-root-execution` is `refuse`. For any
 * other app it stays the 5-apps rollback (legacy root, no approval record).
 * The flip to `app` removes an approval: a requesting app then does not start.
 */
import { basename } from 'node:path';
import * as core from '@aura/core';
import { auditOwner, ownerAction, type OwnerActor } from './approvals/admin.ts';
import { json } from './approvals/service.ts';
import { requesterReason } from './approvals/display.ts';
import { refusedRoots } from './identityReports.ts';

type Ctx = Parameters<typeof ownerAction>[0];
type Mgr = ReturnType<typeof core.getAppManager>;
type MigrationInput = core.RunAsOwnershipInput & { runAsMigration?: core.AppRunAsMigration };

/** What the run-as migration needs from the system (the kernel's pieces; a fake in tests). */
export interface RunAsMigrationDeps {
  /** The app's managed storage and both identities (AppManager.runAsOwnershipInput). */
  input(appId: string, runAs: core.RunAsTarget): Promise<MigrationInput>;
  /** The dry run (core runAsOwnershipPlan). */
  plan(input: MigrationInput): Promise<{ plan: core.RunAsOwnershipPlan; apply: core.RunAsOwnershipApply }>;
  /** A new journal path for `digest` (not created yet). */
  newJournal(digest: string): string;
  /** A journal named on a record, as a path; null when it is not there. */
  journalPath(name: string): string | null;
  /** The apply, journaled, in a child process (core runOwnershipApply). */
  apply(digest: string, apply: core.RunAsOwnershipApply, journal: string): Promise<{ rows: core.OwnershipApplyResult['rows']; restored?: core.OwnershipApplyResult['restored'] }>;
  /** A journal restored exactly inside `within` (core restoreJournalEntries, every entry). */
  restore(journal: string, within: string[]): { restored: number; skipped: string[] };
  /** Stops the app and every instance that mounts its data; returns what to start again. */
  stop(appId: string): Promise<{ stopped: string[]; restart: Array<{ appId: string; userId?: string }> }>;
  /** Starts again what `stop` returned; the errors, by app. */
  restart(list: Array<{ appId: string; userId?: string }>): Promise<string[]>;
  /** While a migration runs, no warm-pool refill starts the app. */
  hold(appId: string, on: boolean): void;
}

export interface RunAsDeps {
  ownerAction(ctx: Ctx, req: Parameters<typeof ownerAction>[1]): Promise<OwnerActor | Response>;
  audit(actor: OwnerActor, action: string, opts: Parameters<typeof auditOwner>[2]): Promise<void>;
  /** `ensureInstallation`: an app without its installation record is repaired, never answered "not ready". */
  mgr: Pick<Mgr, 'registry' | 'getAllInstances' | 'ensureInstallation'>;
  hosts: Pick<core.AppHostStore, 'setRunAs' | 'setRunAsMigration'>;
  /** The effective `app-root-execution` value (a read failure counts as refuse: fail closed). */
  rootPolicy(): Promise<core.AppRootExecutionPolicy>;
  migration: RunAsMigrationDeps;
}

const dataDir = (): string => process.env['AURA_DATA_DIR'] ?? '/data';

export function liveRunAsDeps(): RunAsDeps {
  const mgr = core.getAppManager();
  return {
    ownerAction: (ctx, req) => ownerAction(ctx, req),
    audit: (actor, action, opts) => auditOwner(actor, action, opts),
    mgr,
    hosts: core.getAppHostServices().registry,
    rootPolicy: async () => {
      try {
        const store = core.getAuthServices().securityPolicy;
        if (!store) return 'refuse';
        return core.securityPolicyValue(await store.get(), core.APP_ROOT_EXECUTION_OPTION) === 'refuse' ? 'refuse' : 'approve';
      } catch { return 'refuse'; }
    },
    migration: {
      input: (appId, runAs) => mgr.runAsOwnershipInput(appId, runAs),
      plan: (input) => core.runAsOwnershipPlan(input, { refuseRoots: refusedRoots() }),
      newJournal: (digest) => core.newOwnershipJournal(dataDir(), digest),
      journalPath: (name) => core.ownershipJournalPath(dataDir(), name),
      apply: (digest, apply, journal) => core.runOwnershipApply(dataDir(), digest, apply.rows, { journal, ...(apply.restore ? { restore: apply.restore } : {}) }),
      restore: (journal, within) => core.restoreJournalEntries({ journal, within, owner: null }),
      stop: async (appId) => {
        const restart: Array<{ appId: string; userId?: string }> = [];
        const stopped: string[] = [];
        const consumers = new Set(mgr.mounts.dataConsumers(appId));
        for (const inst of mgr.getAllInstances()) {
          if (inst.appId !== appId && !consumers.has(inst.instanceId)) continue;
          stopped.push(inst.instanceId);
          // A preview is a throwaway copy (Track P): stopped, not started again.
          if (inst.preview) { await mgr.stopPreview(inst.instanceId); continue; }
          if (!inst.inPool) restart.push({ appId: inst.appId, ...(inst.owner ? { userId: inst.owner } : {}) });
          await mgr.stop(inst.instanceId);
        }
        return { stopped, restart };
      },
      restart: async (list) => {
        const errors: string[] = [];
        for (const r of list) {
          try { await mgr.start(r.appId, r.userId ? { userId: r.userId } : {}); }
          catch (err) { errors.push(`${r.appId}: ${(err as Error).message}`); }
        }
        return errors;
      },
      hold: (appId, on) => mgr.markUninstalling(appId, on),
    },
  };
}

async function body(ctx: Ctx): Promise<Record<string, unknown> | Response> {
  try {
    const b = await ctx.request.json();
    if (!b || typeof b !== 'object' || Array.isArray(b)) return json({ error: 'invalid-request', message: 'body must be a JSON object' }, 400);
    return b as Record<string, unknown>;
  } catch { return json({ error: 'invalid-request', message: 'body must be JSON' }, 400); }
}

const recoverHint = (appId: string) => `aura admin apps run-as ${appId} --recover`;

/** The app's installation, repaired when it is missing (AppManager `ensureInstallation`); else why not. */
async function installationOf(deps: RunAsDeps, appId: string): Promise<core.AppInstallation | Response> {
  let r;
  try { r = await deps.mgr.ensureInstallation(appId); }
  catch (err) { return json({ error: 'not-ready', message: `${appId}: its installation record can't be read (${(err as Error).message})` }, 503); }
  return r.installation ?? json({ error: 'no-installation', message: r.error }, 409);
}

export async function postRunAs(ctx: Ctx, deps: RunAsDeps = liveRunAsDeps()): Promise<Response> {
  const b = await body(ctx);
  if (b instanceof Response) return b;
  const { appId, runAs, digest, recover } = b as { appId?: unknown; runAs?: unknown; digest?: unknown; recover?: unknown };
  if (typeof appId === 'string' && recover === true) return recoverRunAs(ctx, appId, deps);
  if (typeof appId !== 'string' || (runAs !== 'app' && runAs !== 'root')) {
    return json({ error: 'invalid-request', message: 'expected { appId, runAs: "app" | "root" [, digest] } or { appId, recover: true }' }, 400);
  }
  if (digest !== undefined && (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest))) {
    return json({ error: 'invalid-request', message: 'digest: the 64 hex digits of the dry run you reviewed' }, 400);
  }
  const m = deps.mgr.registry.getById(appId);
  if (!m) return json({ error: 'not-found', message: `unknown app: ${appId}` }, 404);
  const inst = await installationOf(deps, appId);
  if (inst instanceof Response) return inst;
  if (inst.runAsMigration) {
    return json({ error: 'migration-pending', message: `${appId}: an earlier run-as change (to ${inst.runAsMigration.to}) did not finish. Restore it first: ${recoverHint(appId)}` }, 409);
  }
  const before = inst.runAs ?? 'root';
  // The app's own root request: the flip to root approves exactly it.
  const requested = core.executionConfigOf(m);
  const approve = runAs === 'root' && requested ? core.executionDigest(requested) : null;
  if (approve && await deps.rootPolicy() !== 'approve') {
    return json({ error: 'root-execution-refused', message: `root execution is turned off on this AuraOS (security option ${core.APP_ROOT_EXECUTION_OPTION} = refuse)` }, 403);
  }
  const unchanged = before === runAs && inst.runAs !== undefined && (!approve || inst.execution?.digest === approve);
  if (unchanged) return json({ ok: true, changed: false, appId, installationId: inst.installationId, runAs });
  const running = deps.mgr.getAllInstances().filter((i) => i.appId === appId).length;
  const reason = approve ? requesterReason((m as { execution?: { reason?: string } }).execution?.reason) : undefined;
  const execution: core.ExecutionApproval | undefined = approve ? { runAs: 'root', digest: approve, approvedAt: Date.now(), via: 'admin.run-as' } : undefined;
  const highRisk = approve ? {
    highRisk: [{
      item: 'Root execution (runAs: root)', added: true,
      why: 'Its processes run as root inside their container. Still no capabilities, no Docker socket and no host access.',
    }],
  } : {};
  const title = runAs === 'app' ? `Run ${appId} as its own app identity (non-root)`
    : approve ? `Approve ${appId}'s request to run as root` : `Run ${appId} as root again`;

  // The uid stays root (a legacy root app's request approved): nothing to migrate.
  if ((before === 'app') === (runAs === 'app')) {
    const actor = await deps.ownerAction(ctx, {
      action: 'admin.change', payload: { runAs: { appId, installationId: inst.installationId, runAs, ...(approve ? { execution: approve } : {}) } }, level: 'fresh',
      title,
      details: [
        `Grants exactly its manifest's request (${approve}) to installation ${inst.installationId}; a changed request asks again.`,
        running ? `Applies to its next start: ${running} running instance(s) keep their identity until restarted.` : 'Applies to its next start.',
      ],
      ...highRisk,
      ...(reason ? { reason } : {}),
    });
    if (actor instanceof Response) return actor;
    const r = await deps.hosts.setRunAs(inst.installationId, runAs, before, execution);
    if (!r.ok) return json({ error: 'conflict', message: 'The installation record changed meanwhile. Try again.' }, 409);
    await deps.audit(actor, core.RUN_AS_AUDIT_ACTIONS.changed, { target: `installation:${inst.installationId}`, detail: { appId, from: before, to: runAs } });
    if (approve) {
      await deps.audit(actor, core.EXECUTION_AUDIT_ACTIONS.approved, {
        target: `installation:${inst.installationId}`, detail: { appId, runAs: 'root', digest: approve, via: 'admin.run-as' },
      });
    }
    return json({ ok: true, changed: true, appId, installationId: inst.installationId, runAs, running });
  }

  // The uid changes: the managed storage moves with it (owner decision 5-main, run-as reversible).
  let planned;
  try { planned = await deps.migration.plan(await deps.migration.input(appId, runAs)); }
  catch (err) { return json({ error: 'not-ready', message: `${appId}: its run-as migration can't be planned: ${(err as Error).message}` }, 409); }
  const { plan, apply } = planned;
  if (digest === undefined) {
    // The dry run: an owner view, changes nothing.
    const actor = await deps.ownerAction(ctx, { action: 'admin.read', payload: { view: 'run-as-dry-run' }, level: 'session', title: `Show what running ${appId} as ${runAs} changes` });
    if (actor instanceof Response) return actor;
    return json({ ok: true, changed: false, dryRun: true, appId, installationId: inst.installationId, from: before, runAs, running, plan });
  }
  if (digest !== plan.digest) {
    return json({ error: 'digest-mismatch', message: `${appId}'s data changed since your dry run: review the new one (aura admin apps run-as ${appId} ${runAs}).`, digest: plan.digest, plan }, 409);
  }
  const changes = plan.rows.reduce((n, r) => n + r.toChange, 0);
  const actor = await deps.ownerAction(ctx, {
    action: 'admin.change', payload: { runAs: { appId, installationId: inst.installationId, runAs, digest, ...(approve ? { execution: approve } : {}) } }, level: 'fresh',
    title,
    details: [
      runAs === 'app'
        ? `Its processes run as its app uid (${plan.to}) with no capabilities. A failed start is not retried as root.${requested ? ' It requests root: without the approval it does not start.' : ''}`
        : approve ? `Grants exactly its manifest's request (${approve}) to installation ${inst.installationId}; a changed request asks again.`
          : `Rollback: its processes run as root again, with no capabilities.`,
      `Its data, App Homes and dev caches move from ${plan.from} to ${plan.to}: ${changes} entr${changes === 1 ? 'y' : 'ies'} in ${plan.rows.filter((r) => r.exists).length} place(s) (dry run ${digest.slice(0, 12)}).`,
      ...(plan.restore ? [`The earlier migration (${plan.restore.journal}) is restored exactly first: ${plan.restore.entries} entr${plan.restore.entries === 1 ? 'y' : 'ies'}.`] : []),
      'Only what its previous identity owns changes; everything else keeps its owner. Every change is journaled and can be restored.',
      running ? `It is stopped first (${running} running instance(s)) and started again after the change succeeded.` : 'It is not running.',
    ],
    ...highRisk,
    ...(reason ? { reason } : {}),
  });
  if (actor instanceof Response) return actor;

  const journal = deps.migration.newJournal(digest);
  const journalName = basename(journal);
  const target = `installation:${inst.installationId}`;
  const mark = await deps.hosts.setRunAsMigration(inst.installationId, before, { to: runAs, digest, journal: journalName, startedAt: Date.now() });
  if (!mark.ok) return json({ error: 'conflict', message: 'The installation record changed meanwhile. Try again.' }, 409);
  deps.migration.hold(appId, true);
  try {
    let stopped: Awaited<ReturnType<RunAsMigrationDeps['stop']>>;
    try { stopped = await deps.migration.stop(appId); }
    catch (err) {
      await deps.hosts.setRunAsMigration(inst.installationId, before, null);
      return json({ error: 'stop-failed', message: `${appId} could not be stopped (${(err as Error).message}); nothing was changed.` }, 500);
    }
    let applied;
    try { applied = await deps.migration.apply(digest, apply, journal); }
    catch (err) {
      if (err instanceof core.OwnershipApplyError && err.code === 'changed') {
        // Refused before any change (D5: a security-relevant fact differs from the dry run): nothing to restore.
        await deps.hosts.setRunAsMigration(inst.installationId, before, null);
        await deps.audit(actor, core.RUN_AS_AUDIT_ACTIONS.changed, { target, outcome: 'failed', detail: { appId, from: before, to: runAs, digest, refused: 'changed' } });
        deps.migration.hold(appId, false);
        const restartFailed = await deps.migration.restart(stopped.restart);
        return json({
          error: 'changed', appId, runAs: before, stopped: stopped.stopped, restartFailed,
          message: `${appId}: ${err.message}. Nothing was changed; it still runs as ${before}. Review the new dry run (aura admin apps run-as ${appId} ${runAs}).`,
        }, 409);
      }
      // Restored from its own journal; the app stays stopped (restart only after success).
      const path = deps.migration.journalPath(journalName);
      const back = path ? deps.migration.restore(path, apply.within) : { restored: 0, skipped: [] };
      const clean = back.skipped.every((s) => s.endsWith(': gone'));
      if (clean) await deps.hosts.setRunAsMigration(inst.installationId, before, null);
      await deps.audit(actor, core.RUN_AS_AUDIT_ACTIONS.changed, {
        target, outcome: 'failed', detail: { appId, from: before, to: runAs, digest, journal: journalName, restored: back.restored, notRestored: back.skipped.length },
      });
      return json({
        error: 'migration-failed', appId, runAs: before, stopped: stopped.stopped, journal: journalName,
        message: `${appId}: its data could not be moved (${(err as Error).message}). `
          + (clean ? `Everything changed was restored from the journal; it still runs as ${before} and stays stopped: start it again when you are ready.`
            : `${back.skipped.length} entr${back.skipped.length === 1 ? 'y' : 'ies'} could not be restored; it does not start until ${recoverHint(appId)}.`),
      }, 500);
    }
    const r = await deps.hosts.setRunAs(inst.installationId, runAs, before, execution, { journal: journalName });
    if (!r.ok) {
      // The marker stays: a recovery restores the journal (the app stays stopped).
      return json({ error: 'conflict', message: `The installation record changed during the migration. ${appId} stays stopped; restore it with ${recoverHint(appId)}.` }, 409);
    }
    const counts = applied.rows.map((x) => ({ path: x.path, kind: x.kind, changed: x.changed, skipped: x.skipped }));
    await deps.audit(actor, core.RUN_AS_AUDIT_ACTIONS.changed, {
      target, detail: { appId, from: before, to: runAs, digest, journal: journalName, rows: counts, ...(applied.restored ? { restored: applied.restored.restored } : {}) },
    });
    if (approve) {
      await deps.audit(actor, core.EXECUTION_AUDIT_ACTIONS.approved, { target, detail: { appId, runAs: 'root', digest: approve, via: 'admin.run-as' } });
    }
    deps.migration.hold(appId, false);
    const restartFailed = await deps.migration.restart(stopped.restart);
    return json({
      ok: true, changed: true, appId, installationId: inst.installationId, runAs, running, journal: journalName,
      rows: applied.rows, ...(applied.restored ? { restored: applied.restored } : {}),
      stopped: stopped.stopped, restarted: stopped.restart.length - restartFailed.length, restartFailed,
    });
  } finally {
    deps.migration.hold(appId, false);
  }
}

/** `--recover`: a pending migration's journal restored exactly; the marker removed; the app stays stopped. */
async function recoverRunAs(ctx: Ctx, appId: string, deps: RunAsDeps): Promise<Response> {
  const m = deps.mgr.registry.getById(appId);
  if (!m) return json({ error: 'not-found', message: `unknown app: ${appId}` }, 404);
  const inst = await installationOf(deps, appId);
  if (inst instanceof Response) return inst;
  const pending = inst.runAsMigration;
  if (!pending) return json({ ok: true, changed: false, appId, message: `${appId} has no unfinished run-as change` });
  const before = inst.runAs ?? 'root';
  const actor = await deps.ownerAction(ctx, {
    action: 'admin.change', payload: { runAsRecover: { appId, installationId: inst.installationId, journal: pending.journal, digest: pending.digest } }, level: 'fresh',
    title: `Restore ${appId}'s unfinished run-as change`,
    details: [
      `The change to ${pending.to} (started ${new Date(pending.startedAt).toISOString()}) did not finish.`,
      `Every entry of its journal ${pending.journal} gets its previous owner and mode back; it stays ${before} and stopped.`,
    ],
  });
  if (actor instanceof Response) return actor;
  let input;
  try { input = await deps.migration.input(appId, pending.to); }
  catch (err) { return json({ error: 'not-ready', message: `${appId}: ${(err as Error).message}` }, 409); }
  deps.migration.hold(appId, true);
  try {
    await deps.migration.stop(appId);
    const path = deps.migration.journalPath(pending.journal);
    // No journal: the migration stopped before its first change.
    const back = path ? deps.migration.restore(path, core.runAsOwnershipPaths(input)) : { restored: 0, skipped: [] };
    const clean = back.skipped.every((s) => s.endsWith(': gone'));
    if (clean) {
      const r = await deps.hosts.setRunAsMigration(inst.installationId, before, null);
      if (!r.ok) return json({ error: 'conflict', message: 'The installation record changed meanwhile. Try again.' }, 409);
    }
    await deps.audit(actor, core.RUN_AS_MIGRATION_AUDIT_ACTIONS.recovered, {
      target: `installation:${inst.installationId}`, ...(clean ? {} : { outcome: 'failed' }),
      detail: { appId, runAs: before, to: pending.to, journal: pending.journal, restored: back.restored, notRestored: back.skipped.length },
    });
    if (!clean) {
      return json({ error: 'recover-incomplete', appId, restored: back.restored, skipped: back.skipped.slice(0, 50),
        message: `${back.skipped.length} entr${back.skipped.length === 1 ? 'y' : 'ies'} could not be restored; ${appId} stays blocked. Fix them and run ${recoverHint(appId)} again.` }, 500);
    }
    return json({ ok: true, changed: true, recovered: true, appId, runAs: before, journal: pending.journal, restored: back.restored, skipped: back.skipped });
  } finally {
    deps.migration.hold(appId, false);
  }
}
