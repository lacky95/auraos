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
 * `context.read:<KEY>`, attributed to whoever approved it (`grantContext`).
 * A key the update no longer declares keeps its grant, which counts only
 * while declared.
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
  /** Where the approved Context keys are granted; default GrantStore and the admin audit. */
  contextGrants: () => Pick<core.AuthServices, 'grants' | 'audit'> = () => core.getAuthServices(),
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
      const { grants, audit } = contextGrants();
      for (const key of binding.context) {
        try {
          const r = await grants.grant({ kind: 'app', id: binding.appId }, core.contextReadPermission(key), { by, appScope: binding.scope });
          if (r.changed) {
            await audit.record({ by, action: 'grant', target: `app:${binding.appId}`, outcome: 'ok', detail: { permission: core.contextReadPermission(key), appScope: binding.scope, via: binding.action } })
              .catch(() => undefined);
          }
        } catch (err) {
          console.warn(`[nexus] context grant ${key} for ${binding.appId} failed: ${(err as Error).message}`);
        }
      }
    },
    needsApproval: (binding: InstallBinding, coreDiff: PermissionDiff) => {
      const diff = override?.diff ?? coreDiff;
      return gate.needsApproval({
        action: binding.action, payload: binding, level: override ? override.level(binding) : installLevel(binding),
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
      if (ev.type === 'error') return json({ error: ev.message }, errorStatus(ev));
      if (ev.type === 'install.done') { await gate.grantContext(); return json({ ok: true, record: ev.record }); }
      cursor = await it.next();
    }
    if (cursor.value) await gate.grantContext();
    return json({ ok: true, record: cursor.value });
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
}
