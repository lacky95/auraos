/**
 * The owner's per-installation runAs flip (P5-3, stream A):
 *
 *   POST /api/admin/apps/run-as {appId, runAs: 'app' | 'root'}
 *
 * An owner action at `fresh` (the password, or the host operator),
 * compare-and-set on the installation record, audited
 * (`app.run-as-changed`). It applies to the app's next start: running
 * instances keep the identity they were started with. Rolling one app back is
 * the flip to `root`; nothing is chowned back (root reads everything).
 *
 * Owner decision 5-main item 3: for an app whose manifest REQUESTS root
 * (`execution`, core identity/execution.ts), the flip to `root` is the
 * owner's approval of exactly that request: it records the config digest on
 * the installation (`execution`) and is audited `app.execution-approved` too;
 * refused while the D64 switch `app-root-execution` is `refuse`. For any
 * other app it stays the 5-apps rollback (legacy root, no approval record).
 * The flip to `app` removes an approval: a requesting app then does not start.
 */
import * as core from '@aura/core';
import { auditOwner, ownerAction, type OwnerActor } from './approvals/admin.ts';
import { json } from './approvals/service.ts';
import { requesterReason } from './approvals/display.ts';

type Ctx = Parameters<typeof ownerAction>[0];
type Mgr = ReturnType<typeof core.getAppManager>;

export interface RunAsDeps {
  ownerAction(ctx: Ctx, req: Parameters<typeof ownerAction>[1]): Promise<OwnerActor | Response>;
  audit(actor: OwnerActor, action: string, opts: Parameters<typeof auditOwner>[2]): Promise<void>;
  mgr: Pick<Mgr, 'registry' | 'getAllInstances'>;
  hosts: Pick<core.AppHostStore, 'findInstallation' | 'setRunAs'>;
  /** The effective `app-root-execution` value (a read failure counts as refuse: fail closed). */
  rootPolicy(): Promise<core.AppRootExecutionPolicy>;
}

export function liveRunAsDeps(): RunAsDeps {
  return {
    ownerAction: (ctx, req) => ownerAction(ctx, req),
    audit: (actor, action, opts) => auditOwner(actor, action, opts),
    mgr: core.getAppManager(),
    hosts: core.getAppHostServices().registry,
    rootPolicy: async () => {
      try {
        const store = core.getAuthServices().securityPolicy;
        if (!store) return 'refuse';
        return core.securityPolicyValue(await store.get(), core.APP_ROOT_EXECUTION_OPTION) === 'refuse' ? 'refuse' : 'approve';
      } catch { return 'refuse'; }
    },
  };
}

export async function postRunAs(ctx: Ctx, deps: RunAsDeps = liveRunAsDeps()): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    const b = await ctx.request.json();
    if (!b || typeof b !== 'object' || Array.isArray(b)) return json({ error: 'invalid-request', message: 'body must be a JSON object' }, 400);
    body = b as Record<string, unknown>;
  } catch { return json({ error: 'invalid-request', message: 'body must be JSON' }, 400); }
  const { appId, runAs } = body as { appId?: unknown; runAs?: unknown };
  if (typeof appId !== 'string' || (runAs !== 'app' && runAs !== 'root')) {
    return json({ error: 'invalid-request', message: 'expected { appId, runAs: "app" | "root" }' }, 400);
  }
  const m = deps.mgr.registry.getById(appId);
  if (!m) return json({ error: 'not-found', message: `unknown app: ${appId}` }, 404);
  const inst = await deps.hosts.findInstallation(appId, m.scopeId);
  if (!inst) return json({ error: 'not-ready', message: `${appId} has no recorded installation yet` }, 409);
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
  const actor = await deps.ownerAction(ctx, {
    action: 'admin.change', payload: { runAs: { appId, installationId: inst.installationId, runAs, ...(approve ? { execution: approve } : {}) } }, level: 'fresh',
    title: runAs === 'app' ? `Run ${appId} as its own app identity (non-root)`
      : approve ? `Approve ${appId}'s request to run as root` : `Run ${appId} as root again`,
    details: [
      runAs === 'app'
        ? `Its processes run as its app uid with no capabilities; its data becomes owned by that uid at its next start. A failed start is not retried as root.${requested ? ' It requests root: without the approval it does not start.' : ''}`
        : approve ? `Grants exactly its manifest's request (${approve}) to installation ${inst.installationId}; a changed request asks again.`
          : 'Rollback: its processes run as root again. Nothing is chowned back.',
      running ? `Applies to its next start: ${running} running instance(s) keep their identity until restarted.` : 'Applies to its next start.',
    ],
    ...(approve ? {
      highRisk: [{
        item: 'Root execution (runAs: root)', added: true,
        why: 'Its processes run as root inside their container. Still no capabilities, no Docker socket and no host access.',
      }],
    } : {}),
    ...(reason ? { reason } : {}),
  });
  if (actor instanceof Response) return actor;
  const r = await deps.hosts.setRunAs(inst.installationId, runAs, before,
    approve ? { runAs: 'root', digest: approve, approvedAt: Date.now(), via: 'admin.run-as' } : undefined);
  if (!r.ok) return json({ error: 'conflict', message: 'The installation record changed meanwhile. Try again.' }, 409);
  await deps.audit(actor, core.RUN_AS_AUDIT_ACTIONS.changed, {
    target: `installation:${inst.installationId}`, detail: { appId, from: before, to: runAs },
  });
  if (approve) {
    await deps.audit(actor, core.EXECUTION_AUDIT_ACTIONS.approved, {
      target: `installation:${inst.installationId}`, detail: { appId, runAs: 'root', digest: approve, via: 'admin.run-as' },
    });
  }
  return json({ ok: true, changed: true, appId, installationId: inst.installationId, runAs, running });
}
