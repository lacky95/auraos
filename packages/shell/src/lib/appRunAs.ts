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
 */
import * as core from '@aura/core';
import { auditOwner, ownerAction, type OwnerActor } from './approvals/admin.ts';
import { json } from './approvals/service.ts';

type Ctx = Parameters<typeof ownerAction>[0];
type Mgr = ReturnType<typeof core.getAppManager>;

export interface RunAsDeps {
  ownerAction(ctx: Ctx, req: Parameters<typeof ownerAction>[1]): Promise<OwnerActor | Response>;
  audit(actor: OwnerActor, action: string, opts: Parameters<typeof auditOwner>[2]): Promise<void>;
  mgr: Pick<Mgr, 'registry' | 'getAllInstances'>;
  hosts: Pick<core.AppHostStore, 'findInstallation' | 'setRunAs'>;
}

export function liveRunAsDeps(): RunAsDeps {
  return {
    ownerAction: (ctx, req) => ownerAction(ctx, req),
    audit: (actor, action, opts) => auditOwner(actor, action, opts),
    mgr: core.getAppManager(),
    hosts: core.getAppHostServices().registry,
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
  if (before === runAs && inst.runAs !== undefined) return json({ ok: true, changed: false, appId, installationId: inst.installationId, runAs });
  const running = deps.mgr.getAllInstances().filter((i) => i.appId === appId).length;
  const actor = await deps.ownerAction(ctx, {
    action: 'admin.change', payload: { runAs: { appId, installationId: inst.installationId, runAs } }, level: 'fresh',
    title: runAs === 'app' ? `Run ${appId} as its own app identity (non-root)` : `Run ${appId} as root again`,
    details: [
      runAs === 'app'
        ? 'Its processes run as its app uid with no capabilities; its data becomes owned by that uid at its next start. A failed start is not retried as root.'
        : 'Rollback: its processes run as root again. Nothing is chowned back.',
      running ? `Applies to its next start: ${running} running instance(s) keep their identity until restarted.` : 'Applies to its next start.',
    ],
  });
  if (actor instanceof Response) return actor;
  const r = await deps.hosts.setRunAs(inst.installationId, runAs, before);
  if (!r.ok) return json({ error: 'conflict', message: 'The installation record changed meanwhile. Try again.' }, 409);
  await deps.audit(actor, core.RUN_AS_AUDIT_ACTIONS.changed, {
    target: `installation:${inst.installationId}`, detail: { appId, from: before, to: runAs },
  });
  return json({ ok: true, changed: true, appId, installationId: inst.installationId, runAs, running });
}
