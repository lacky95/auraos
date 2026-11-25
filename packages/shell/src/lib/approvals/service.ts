/**
 * Owner approvals in the shell (5.10, D16, D17, D18, D31, D49).
 *
 *   requester ── action route without an approval ──▶ 202 needs-approval {approvalId}
 *             (or POST /api/approvals for user.confirm and os.context.write)
 *   owner     ── the shell's own dialog ──▶ POST /api/approvals/<id>/approve
 *   requester ── the same action, `X-Aura-Approval: <id>` ──▶ consumed once, then done
 *
 * The protected route builds the display and the payload from what it
 * verified itself (the install binding and PermissionDiff, the validated
 * write), and consumes the approval against the same payload, so an approval
 * covers exactly one request of exactly one requester. The host operator can
 * stand in for the owner with a one-time operator code (D18, `aura approve`),
 * which only a process on the host can create.
 *
 * Nothing here stores or returns a credential. Audit says who asked and who
 * decided.
 */
import * as core from '@aura/core';
import type {
  AccessPrincipal, ApprovalAction, ApprovalDisplay, ApprovalLevel, ApprovalRecord, ApprovalRefusal,
  ApprovalRequester, ApprovalResult, AuditInput, SetupTicket, ValkeyApprovalStore,
} from '@aura/core';
import { requesterLabel } from './display.ts';

/** The header a retried action names its approval in. Forwarded by the App Host gateway. */
export const APPROVAL_HEADER = 'x-aura-approval';

/** The approval id a request presents, if well-formed. Presenting is not consuming. */
export function presentedApproval(request: Request): string | null {
  const id = request.headers.get(APPROVAL_HEADER)?.trim() ?? '';
  return core.isApprovalId(id) ? id : null;
}

/**
 * Whether a request presents an approval: decide()'s fresh-auth precondition
 * (5.11) for the routes whose handler then consumes it. Presenting proves
 * nothing by itself; the handler's consume does.
 */
export const presentsApproval = (request: Request): boolean => presentedApproval(request) !== null;

export interface ApprovalServiceDeps {
  store: Pick<ValkeyApprovalStore,
    'create' | 'get' | 'listPending' | 'approve' | 'deny' | 'consume' | 'isBlocked' | 'block' | 'unblock' | 'listBlocked'>;
  /** The registry's display name for an app id. */
  appName(appId: string): string | null;
  audit(entry: AuditInput): Promise<unknown>;
  /** Operator codes (core `FileSetupTickets`, purpose `operator`). */
  tickets: {
    peek(code: string, purpose: 'operator'): Promise<SetupTicket | null>;
    claim(code: string, purpose: 'operator'): Promise<SetupTicket | null>;
  };
}

export function liveApprovalDeps(): ApprovalServiceDeps {
  const svc = core.getAuthServices();
  return {
    store: svc.approvals,
    appName: (appId) => {
      try { return core.getAppManager().registry.getById(appId)?.name ?? null; } catch { return null; }
    },
    audit: (entry) => svc.audit.record(entry),
    tickets: svc.setupTickets,
  };
}

// ── changes, for the dialog's long poll ─────────────────────────────────────

let version = 0;
const waiters = new Set<() => void>();

/** Something in the approval queue changed: wake the desktop's long polls. */
export function approvalsChanged(): void {
  version += 1;
  for (const wake of [...waiters]) wake();
}

export const approvalsVersion = (): number => version;

/** Resolves on the next change after `seen`, or after `timeoutMs`, or on abort. */
export function waitForApprovals(seen: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  if (seen !== version) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); waiters.delete(done); signal?.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, timeoutMs);
    waiters.add(done);
    signal?.addEventListener('abort', done, { once: true });
  });
}

// ── audit ───────────────────────────────────────────────────────────────────

/** Who asked, as the audit trail names it. Never a session id. */
export function requesterSummary(r: ApprovalRequester): string {
  switch (r.kind) {
    case 'instance': return `instance ${r.instanceId}${r.sidecar ? ` sidecar ${r.sidecar}` : ''} (${r.appId})${r.userId ? ` for user ${r.userId}` : ''}`;
    case 'user': return `user ${r.userId}${r.through ? ` through ${r.through.appId}` : ''}`;
    case 'apiKey': return `API key ${r.name}`;
  }
}

async function audit(deps: ApprovalServiceDeps, entry: AuditInput): Promise<void> {
  try { await deps.audit(entry); } catch { /* the audit trail must not fail the request */ }
}

const auditBy = (r: ApprovalRequester): AuditInput['by'] =>
  r.kind === 'user' ? core.userAttribution({ userId: r.userId }) : { kind: 'system' };

// ── requesting ──────────────────────────────────────────────────────────────

export interface ActionRequest {
  action: ApprovalAction;
  /** The exact payload; its hash is what the approval binds. */
  payload: unknown;
  level: ApprovalLevel;
  display: (requestedBy: string) => ApprovalDisplay;
}

export type RequestOutcome =
  | { ok: true; record: ApprovalRecord }
  | { ok: false; reason: ApprovalRefusal | 'not-a-requester' };

/** A pending approval for `principal`, with the server-built display. */
export async function requestApproval(
  deps: ApprovalServiceDeps, principal: AccessPrincipal, req: ActionRequest,
): Promise<RequestOutcome> {
  const requester = core.approvalRequester(principal);
  if (!requester) return { ok: false, reason: 'not-a-requester' };
  const requestedBy = requesterLabel(requester, deps.appName);
  const result = await deps.store.create({
    requester, action: req.action, payloadHash: core.payloadHash(req.payload),
    display: req.display(requestedBy), level: req.level,
  });
  if (result.ok) {
    approvalsChanged();
    await audit(deps, {
      by: auditBy(requester), action: 'approval.requested', target: `approval:${result.record.id}`, outcome: 'ok',
      detail: { action: req.action, level: req.level, requestedBy: requesterSummary(requester), title: result.record.display.title },
    });
  }
  return result;
}

/** Use up the approval `id` for exactly this action and payload, as `principal`. */
export async function consumeApproval(
  deps: ApprovalServiceDeps, principal: AccessPrincipal, id: string, action: ApprovalAction, payload: unknown,
): Promise<ApprovalResult | { ok: false; reason: 'not-a-requester' }> {
  const requester = core.approvalRequester(principal);
  if (!requester) return { ok: false, reason: 'not-a-requester' };
  const result = await deps.store.consume(id, { requester, action, payloadHash: core.payloadHash(payload) });
  if (result.ok) {
    approvalsChanged();
    const d = result.record.decidedBy;
    await audit(deps, {
      by: auditBy(requester), action: 'approval.consumed', target: `approval:${id}`, outcome: 'ok',
      detail: {
        action, requestedBy: requesterSummary(requester),
        approvedBy: d?.kind === 'operator' ? 'host operator' : d ? `owner ${d.userId}` : 'unknown',
      },
    });
  }
  return result;
}

/** The operator's word on `subject`, used up. */
export async function operatorVouches(deps: ApprovalServiceDeps, code: unknown, subject: string): Promise<boolean> {
  if (typeof code !== 'string' || !code) return false;
  const ticket = await deps.tickets.claim(code, 'operator');
  return !!ticket && ticket.subject === subject;
}

/** The operator subject for an action on one exact payload. */
export const actionSubject = (action: ApprovalAction, payload: unknown): string => `${action}:${core.payloadHash(payload)}`;

/**
 * The gate of one protected request (install, update, a context write): it
 * passes on a consumed approval of exactly this payload, or on an operator
 * code for it; otherwise `needsApproval()` answers how to get one.
 */
export function actionGate(
  deps: ApprovalServiceDeps,
  principal: AccessPrincipal,
  presented: { approvalId: string | null; operatorCode?: unknown },
) {
  let refused: ApprovalRefusal | 'not-a-requester' | 'operator-code-invalid' | null = null;
  return {
    /** Whether this request may go ahead. Uses up what it presented. */
    async allows(action: ApprovalAction, payload: unknown): Promise<boolean> {
      if (presented.operatorCode !== undefined) {
        const ok = await operatorVouches(deps, presented.operatorCode, actionSubject(action, payload));
        if (ok) {
          await audit(deps, {
            by: core.operatorAttribution(), action: 'approval.operator', target: action, outcome: 'ok',
            detail: { action, principal: principal.kind },
          });
        } else refused = 'operator-code-invalid';
        return ok;
      }
      if (!presented.approvalId) return false;
      const r = await consumeApproval(deps, principal, presented.approvalId, action, payload);
      if (!r.ok) refused = r.reason;
      return r.ok;
    },
    /** The 202 answer: a new pending approval, or (no requester identity) what an operator code must name. */
    async needsApproval(req: ActionRequest, extra: Record<string, unknown> = {}): Promise<Response> {
      const base = {
        ok: false, error: 'needs-approval', needsApproval: true, action: req.action, level: req.level,
        ...(refused ? { refused } : {}), ...extra,
      };
      const created = await requestApproval(deps, principal, req);
      if (created.ok) {
        const r = created.record;
        return json({ ...base, approvalId: r.id, expiresAt: r.expiresAt, display: r.display }, 202);
      }
      if (created.reason === 'not-a-requester') {
        // The host operator path (D18): `aura` on the host confirms this exact payload.
        return json({ ...base, operatorOnly: true, operatorSubject: actionSubject(req.action, req.payload) }, 202);
      }
      return refusal(created.reason);
    },
  };
}

// ── answers ─────────────────────────────────────────────────────────────────

const HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: HEADERS });
}

/** Each store refusal as its answer. */
export function refusal(reason: ApprovalRefusal | 'not-a-requester'): Response {
  switch (reason) {
    case 'not-found': return json({ error: 'not-found' }, 404);
    case 'expired': return json({ error: 'expired' }, 410);
    case 'too-many-pending': return json({ error: 'too-many-pending', message: 'An earlier request is still waiting for the owner.' }, 429);
    case 'rate-limited': return json({ error: 'rate-limited' }, 429);
    case 'blocked': return json({ error: 'blocked', message: 'The owner blocked approval requests from this app.' }, 403);
    case 'needs-fresh-auth': return json({ error: 'needs-fresh-auth' }, 403);
    case 'not-a-decider': return json({ error: 'decider-required' }, 403);
    case 'not-a-requester': return json({ error: 'requester-required' }, 403);
    case 'mismatch': return json({ error: 'mismatch' }, 409);
    case 'wrong-state':
    default: return json({ error: 'wrong-state' }, 409);
  }
}

/** A record as its requester sees it: the request and its state, never who decided. */
export function requesterView(r: ApprovalRecord) {
  return {
    id: r.id, action: r.action, level: r.level, state: r.state,
    createdAt: r.createdAt, expiresAt: r.expiresAt, display: r.display,
  };
}

/** A record as the owner's dialog sees it: plus the requester and its app, for the frame check. */
export function ownerView(r: ApprovalRecord) {
  return {
    ...requesterView(r),
    requester: r.requester,
    appId: core.requesterAppId(r.requester),
    ...(r.decidedBy ? { decidedBy: r.decidedBy.kind === 'operator' ? 'operator' : 'owner' } : {}),
  };
}
