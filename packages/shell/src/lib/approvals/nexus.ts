/**
 * The install gate of `/api/nexus/install` and `/api/nexus/update/<id>`
 * (D31): core's pipeline asks `approval(binding)` before it installs, and the
 * gate answers yes only for a consumed owner approval of exactly that binding
 * (`X-Aura-Approval`), or the host operator's code for it (`operatorCode`).
 * Otherwise the route answers 202 needs-approval with a new pending approval
 * whose dialog shows the binding and the PermissionDiff. Nothing in the
 * request body can approve an install: `autoApprove` is gone.
 *
 * Stream C (Q7): the approved binding names the app's Context keys
 * (`context[]`); once the install lands, the same decision grants each as
 * `context.read:<KEY>` to the installation it landed as (S1), attributed to
 * whoever approved it (`grantContext`).
 * A key the update no longer declares keeps its grant, which counts only
 * while declared.
 *
 * Owner decision 5-main item 3: a root request (`binding.execution`) is part
 * of the binding, so only this approval (at `fresh`, display.ts
 * `installRisks`) grants it; core records it on the installation and the
 * gate audits it (`app.execution-approved`).
 */
import * as core from '@aura/core';
import type { AccessPrincipal, ApprovalLevel, InstallBinding, InstallRecord, NexusProgressEvent, PermissionDiff } from '@aura/core';
import { installDisplay, installLevel } from './display.ts';
import { actionGate, json, presentedApproval, type ApprovalServiceDeps } from './service.ts';

type InstallGenerator = AsyncGenerator<NexusProgressEvent, InstallRecord | null, { approve: boolean } | void>;

/**
 * The gate for one install request, to pass as core's `approval` option.
 * `override`: a patch activation (Track P) names its own level and the diff
 * against the running copy.
 */
export function installGate(
  deps: ApprovalServiceDeps, principal: AccessPrincipal, request: Request, operatorCode: unknown,
  override?: { level: (binding: InstallBinding) => ApprovalLevel; diff: PermissionDiff },
  /** Where the approved Context keys are granted: GrantStore, the admin audit, the installation the app landed as. */
  contextGrants: () => Pick<core.AuthServices, 'grants' | 'audit'> & { installationOf(appId: string, scope: string): Promise<string | null> } = () => {
    const svc = core.getAuthServices();
    return { grants: svc.grants, audit: svc.audit, installationOf: (appId, scope) => core.getAppManager().installationIdOf(appId, scope) };
  },
) {
  const gate = actionGate(deps, principal, {
    approvalId: presentedApproval(request),
    ...(operatorCode !== undefined ? { operatorCode } : {}),
  });
  let approved: { binding: InstallBinding; by: core.GrantedBy } | null = null;
  return {
    approval: async (binding: InstallBinding) => {
      const ok = await gate.allows(binding.action, binding);
      if (ok) {
        const d = gate.consumed()?.decidedBy;
        approved = { binding, by: d?.kind === 'user' ? core.userAttribution({ userId: d.userId, sessionId: d.sessionId }) : core.operatorAttribution() };
      }
      return ok;
    },
    /** After the install landed: grant the Context keys the approved binding names. */
    grantContext: async (): Promise<void> => {
      if (!approved || !(approved.binding.context ?? []).length) return;
      const { binding, by } = approved;
      const { grants, audit, installationOf } = contextGrants();
      const installationId = await installationOf(binding.appId, binding.scope);
      if (!installationId) {
        console.warn(`[nexus] ${binding.appId} has no installation in scope ${binding.scope}: its approved Context keys are not granted (aura grant them after it has one)`);
        return;
      }
      for (const key of binding.context) {
        try {
          const r = await grants.grant({ kind: 'app', id: binding.appId }, core.contextReadPermission(key), { by, appScope: binding.scope, installationId });
          if (r.changed) {
            await audit.record({ by, action: 'grant', target: `app:${binding.appId}`, outcome: 'ok', detail: { permission: core.contextReadPermission(key), appScope: binding.scope, installationId, via: binding.action } })
              .catch(() => undefined);
          }
        } catch (err) {
          console.warn(`[nexus] context grant ${key} for ${binding.appId} failed: ${(err as Error).message}`);
        }
      }
    },
    /**
     * After the install landed: the audit row of an approved root request
     * (core recorded it on the installation, identity/execution.ts).
     */
    auditExecution: async (): Promise<void> => {
      const ex = approved?.binding.execution;
      if (!approved || !ex || !ex.renew) return;
      const { binding, by } = approved;
      await contextGrants().audit.record({
        by, action: core.EXECUTION_AUDIT_ACTIONS.approved, target: `app:${binding.appId}`, outcome: 'ok',
        detail: { appScope: binding.scope, runAs: ex.runAs, digest: ex.digest, via: binding.action, approval: gate.consumed()?.id },
      }).catch(() => undefined);
    },
    needsApproval: (binding: InstallBinding, coreDiff: PermissionDiff) => {
      const diff = override?.diff ?? coreDiff;
      return gate.needsApproval({
        action: binding.action, payload: binding, level: override ? override.level(binding) : installLevel(binding, diff),
        display: (by) => installDisplay(binding, diff, by),
      }, { diff });
    },
  };
}

/**
 * Run an install or update to its answer: the record, an identity question,
 * or needs-approval. The generator is abandoned at a question, as before.
 */
export async function runInstall(
  it: InstallGenerator,
  gate: ReturnType<typeof installGate>,
  errorStatus: (ev: Extract<NexusProgressEvent, { type: 'error' }>) => number = () => 500,
): Promise<Response> {
  try {
    let cursor = await it.next();
    while (!cursor.done) {
      const ev = cursor.value;
      if (ev.type === 'identity.choice') {
        await it.return(null).catch(() => undefined);
        return json({ ok: false, needsIdentityChoice: true, conflict: ev.conflict });
      }
      if (ev.type === 'permission.needed') {
        await it.return(null).catch(() => undefined);
        return gate.needsApproval(ev.binding, ev.diff);
      }
      // D48: an app built for a newer Aura contract is 422 `contract-unsupported` on every install path.
      if (ev.type === 'error' && ev.code === core.CONTRACT_UNSUPPORTED) return json({ error: ev.code, message: ev.message }, 422);
      if (ev.type === 'error') return json({ error: ev.message }, errorStatus(ev));
      if (ev.type === 'install.done') { await gate.grantContext(); await gate.auditExecution(); return json({ ok: true, record: ev.record }); }
      cursor = await it.next();
    }
    if (cursor.value) { await gate.grantContext(); await gate.auditExecution(); }
    return json({ ok: true, record: cursor.value });
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
}
