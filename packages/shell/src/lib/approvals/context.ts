/**
 * Aura Context writes need a fresh owner approval (5.10, decide()'s
 * `needs-fresh-auth`): the write presents `X-Aura-Approval`, and this
 * consumes it against the exact key, kind and injection being written.
 */
import { authenticate } from '../auth.ts';
import { contextDisplay, type ContextWrite } from './display.ts';
import { actionGate, liveApprovalDeps, presentedApproval, type ApprovalServiceDeps } from './service.ts';

/** Null when the write may go ahead (its approval is used up), else the answer. */
export async function contextGate(
  request: Request, write: ContextWrite, deps: ApprovalServiceDeps = liveApprovalDeps(),
): Promise<Response | null> {
  const principal = await authenticate(request);
  if (principal instanceof Response) return principal;
  const gate = actionGate(deps, principal, { approvalId: presentedApproval(request) });
  if (await gate.allows('os.context.write', write)) return null;
  return gate.needsApproval({
    action: 'os.context.write', payload: write, level: 'fresh', display: (by) => contextDisplay(write, by),
  });
}
