/**
 * The install gate of `/api/nexus/install` and `/api/nexus/update/<id>`
 * (D31): core's pipeline asks `approval(binding)` before it installs, and the
 * gate answers yes only for a consumed owner approval of exactly that binding
 * (`X-Aura-Approval`), or the host operator's code for it (`operatorCode`).
 * Otherwise the route answers 202 needs-approval with a new pending approval
 * whose dialog shows the binding and the PermissionDiff. Nothing in the
 * request body can approve an install: `autoApprove` is gone.
 */
import { InstallRefusedError } from '@aura/core';
import type { AccessPrincipal, ApprovalLevel, InstallBinding, InstallRecord, NexusProgressEvent, PermissionDiff } from '@aura/core';
import { errorResponse } from '../appResponse.ts';
import { installDisplay, installLevel } from './display.ts';
import { actionGate, json, presentedApproval, type ApprovalServiceDeps } from './service.ts';

type InstallGenerator = AsyncGenerator<NexusProgressEvent, InstallRecord | null, { approve: boolean } | void>;

/**
 * The gate for one install request, to pass as core's `approval` option.
 * `override`: a patch activation (Track P) names its own level and the diff
 * against the running copy, which core's record-based diff can't see for a
 * system-app overlay.
 */
export function installGate(
  deps: ApprovalServiceDeps, principal: AccessPrincipal, request: Request, operatorCode: unknown,
  override?: { level: (binding: InstallBinding) => ApprovalLevel; diff: PermissionDiff },
) {
  const gate = actionGate(deps, principal, {
    approvalId: presentedApproval(request),
    ...(operatorCode !== undefined ? { operatorCode } : {}),
  });
  return {
    approval: (binding: InstallBinding) => gate.allows(binding.action, binding),
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
      if (ev.type === 'install.done') return json({ ok: true, record: ev.record });
      cursor = await it.next();
    }
    return json({ ok: true, record: cursor.value });
  } catch (err) {
    // Refused before approval, nothing written (e.g. foreign install inputs): the D105 body, 400.
    if (err instanceof InstallRefusedError) return errorResponse(400, err.body);
    return json({ error: (err as Error).message }, 500);
  }
}
