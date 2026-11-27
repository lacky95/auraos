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
import { holdNoticeInput, liveHoldNoticeDeps, type HoldNoticeDeps } from './holdNotice.ts';

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
    'create' | 'get' | 'listPending' | 'approve' | 'deny' | 'consume' | 'isBlocked' | 'block' | 'unblock' | 'listBlocked'
    | 'hold' | 'cancel' | 'setNotice'>;
  /** The registry's display name for an app id. */
  appName(appId: string): string | null;
  audit(entry: AuditInput): Promise<unknown>;
  /**
   * D102: is this open request still valid? Null when it is, else why not
   * (it is then cancelled). Checked before an approve (`decide`) and again
   * before the approval is used (`execute`); see `liveRevalidate`.
   */
  revalidate?(record: ApprovalRecord, when: 'decide' | 'execute'): Promise<string | null>;
  /** D102: the hold notification (holdNotice.ts). Absent: Later still holds, without a notice. */
  notices?: HoldNoticeDeps;
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
    revalidate: (record, when) => liveRevalidate(record, when, {
      isBlocked: (appId) => svc.approvals.isBlocked(appId),
      appInstalled: (appId) => {
        try { return !!core.getAppManager().registry.getById(appId); } catch { return true; }
      },
      instanceRunning: (instanceId) => {
        try { return !!core.getAppManager().getInstance(instanceId); } catch { return true; }
      },
    }),
    notices: liveHoldNoticeDeps(),
  };
}

// ── revalidation (D102) ─────────────────────────────────────────────────────

export interface RevalidateFacts {
  isBlocked(appId: string): Promise<boolean>;
  appInstalled(appId: string): boolean;
  instanceRunning(instanceId: string): boolean;
}

/**
 * D102: revalidate the original request before it is approved and before
 * the approval is used. Generic, from what the record holds:
 *   - the requesting app is still installed and not blocked;
 *   - before the approve, the requesting instance still runs (an approval
 *     only its own instance token can use would be dead);
 *   - `credential.store`: the app that will consume the secret is installed.
 * The exact request itself is revalidated at execution by construction: the
 * route rebuilds the payload from the current state (install binding,
 * PermissionDiff, grant, scope, …) and runs its own access check, and the
 * consume binds that payload's hash, so a changed scope, artifact or
 * permission set needs a new approval.
 */
export async function liveRevalidate(record: ApprovalRecord, when: 'decide' | 'execute', facts: RevalidateFacts): Promise<string | null> {
  const appId = core.requesterAppId(record.requester);
  if (appId) {
    if (await facts.isBlocked(appId)) return 'the requesting app is blocked';
    if (!facts.appInstalled(appId)) return 'the requesting app was removed';
  }
  if (when === 'decide' && record.requester.kind === 'instance' && !facts.instanceRunning(record.requester.instanceId)) {
    return 'the requesting app instance has stopped';
  }
  if (record.action === 'credential.store') {
    const consumer = (record.payload as { for?: unknown } | undefined)?.for;
    if (typeof consumer === 'string' && !facts.appInstalled(consumer)) return 'the app that would use the secret was removed';
  }
  return null;
}

/** Cancel a request revalidation found stale, end its notice, and say so in the audit trail. */
export async function cancelStale(deps: ApprovalServiceDeps, record: ApprovalRecord, why: string): Promise<void> {
  const r = await deps.store.cancel(record.id, { kind: 'system', reason: why });
  if (!r.ok) return;
  await endHoldNotice(deps, r.record);
  approvalsChanged();
  await audit(deps, {
    by: { kind: 'system' }, action: 'approval.cancelled', target: `approval:${record.id}`, outcome: 'ok',
    detail: { action: record.action, title: record.display.title, requestedBy: requesterSummary(record.requester), reason: why },
  });
}

// ── hold notices (D102) ─────────────────────────────────────────────────────

/** Post the one notice for a held record and keep its id on the record. Best effort. */
export async function postHoldNotice(deps: ApprovalServiceDeps, record: ApprovalRecord, now = Date.now()): Promise<ApprovalRecord> {
  if (!deps.notices || record.notice || record.heldAt === undefined) return record;
  let id: string;
  try { id = await deps.notices.create(holdNoticeInput(record, now)); } catch { return record; }
  const r = await deps.store.setNotice(record.id, id);
  if (r.ok) return r.record;
  // Decided in the meantime: no pointer to a request that is no longer open.
  await deps.notices.remove(id).catch(() => undefined);
  return record;
}

/** Remove a record's notice (approved, denied, cancelled, expired). Never an outcome notice (D102). */
export async function endHoldNotice(deps: ApprovalServiceDeps, record: ApprovalRecord): Promise<void> {
  if (!deps.notices || !record.notice) return;
  try { await deps.notices.remove(record.notice); } catch { /* best effort; reconcile catches it */ }
}

/**
 * Remove every AuraOS approval notice whose request is no longer held (at
 * boot, and now and then from the desktop's poll). Returns how many.
 */
export async function reconcileHoldNotices(deps: ApprovalServiceDeps): Promise<number> {
  if (!deps.notices) return 0;
  let removed = 0;
  for (const n of await deps.notices.listActive()) {
    const record = await deps.store.get(n.approvalId);
    if (record && record.state === 'pending' && record.heldAt !== undefined && record.notice === n.id) continue;
    await deps.notices.remove(n.id);
    removed += 1;
  }
  return removed;
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
  /** Keep the payload on the record, for a decision that acts on it (credential.store). Never a secret. */
  keepPayload?: boolean;
}

export type RequestOutcome =
  /** `resumed` (D102): the requester's own open request for the same thing. */
  | { ok: true; record: ApprovalRecord; resumed?: boolean }
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
    // D102: the class is the catalog's, never the requester's.
    class: core.approvalClassOf(req.action, req.payload),
    ...(req.keepPayload ? { payload: req.payload } : {}),
  });
  // D102: asking again for the same thing resumes the original request: no new record, notice or audit entry.
  if (result.ok && !result.resumed) {
    approvalsChanged();
    await audit(deps, {
      by: auditBy(requester), action: 'approval.requested', target: core.approvalRef(result.record.id), outcome: 'ok',
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
  // D102: revalidate before execution, only for the requester's own approved record.
  if (deps.revalidate) {
    const record = await deps.store.get(id);
    if (record && record.state === 'approved' && record.action === action && core.sameRequester(requester, record.requester)) {
      const why = await deps.revalidate(record, 'execute');
      if (why) {
        await cancelStale(deps, record, why);
        return { ok: false, reason: 'stale' };
      }
    }
  }
  const result = await deps.store.consume(id, { requester, action, payloadHash: core.payloadHash(payload) });
  if (result.ok) {
    approvalsChanged();
    const d = result.record.decidedBy;
    await audit(deps, {
      by: auditBy(requester), action: 'approval.consumed', target: core.approvalRef(id), outcome: 'ok',
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
  let consumed: ApprovalRecord | null = null;
  return {
    /** The approval this request used up, once `allows` said yes to one (not for an operator code). */
    consumed: (): ApprovalRecord | null => consumed,
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
      if (r.ok) consumed = r.record;
      else refused = r.reason;
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
        return json({
          message: `This request needs the owner's ${req.level === 'fresh' ? 'fresh ' : ''}approval.`,
          category: 'needs-approval',
          hint: `The owner approves it in the AuraOS desktop${req.level === 'fresh' ? ' (with the password)' : ''}, or the host operator runs: aura approve ${r.id}. `
            + `Then send the same request again with the header X-Aura-Approval: ${r.id}.`,
          ...base, approvalId: r.id, expiresAt: r.expiresAt, display: r.display, state: r.state,
          class: r.class ?? 'forced', ...(r.heldAt !== undefined ? { heldAt: r.heldAt } : {}),
          ...(created.resumed ? { resumed: true } : {}),
        }, 202);
      }
      if (created.reason === 'not-a-requester') {
        // The host operator path (D18): `aura` on the host confirms this exact payload.
        return json({
          message: 'Only the host operator can confirm this request.',
          category: 'needs-approval',
          hint: 'Run the same command on the host, where aura asks the operator to confirm it.',
          ...base, operatorOnly: true, operatorSubject: actionSubject(req.action, req.payload),
        }, 202);
      }
      return refusal(created.reason);
    },
  };
}

/**
 * A route's whole gate for one protected request: null when it may go ahead
 * (the approval it presented is used up), else the 202 that asks the owner.
 */
export async function approvedOrAsk(
  deps: ApprovalServiceDeps, principal: AccessPrincipal, request: Request, req: ActionRequest,
): Promise<Response | null> {
  const gate = actionGate(deps, principal, { approvalId: presentedApproval(request) });
  if (await gate.allows(req.action, req.payload)) return null;
  return gate.needsApproval(req);
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
    case 'too-many-pending': return json({ error: 'too-many-pending', message: 'An earlier request is still waiting for the owner (or on hold in the desktop): withdraw it or wait.' }, 429);
    case 'rate-limited': return json({ error: 'rate-limited' }, 429);
    case 'blocked': return json({ error: 'blocked', message: 'The owner blocked approval requests from this app.' }, 403);
    case 'needs-fresh-auth': return json({ error: 'needs-fresh-auth' }, 403);
    case 'not-a-decider': return json({ error: 'decider-required' }, 403);
    case 'not-a-requester': return json({ error: 'requester-required' }, 403);
    case 'mismatch': return json({ error: 'mismatch' }, 409);
    case 'not-deferrable': return json({ error: 'not-deferrable', message: 'This request must be decided now: approve or deny it.' }, 409);
    case 'stale': return json({ error: 'stale', message: 'This request is no longer valid and was cancelled. Ask again.' }, 409);
    case 'wrong-state':
    default: return json({ error: 'wrong-state' }, 409);
  }
}

/**
 * A record as its requester sees it: the request and its state, never who
 * decided. D102: whether it is held (`heldAt`: on hold in the desktop, still
 * pending, authorizes nothing), the owner's denial feedback, and who
 * cancelled it.
 */
export function requesterView(r: ApprovalRecord) {
  return {
    id: r.id, action: r.action, level: r.level, state: r.state, class: r.class ?? 'forced',
    createdAt: r.createdAt, expiresAt: r.expiresAt, display: r.display,
    ...(r.heldAt !== undefined && r.state === 'pending' ? { heldAt: r.heldAt } : {}),
    ...(r.approvedAt !== undefined ? { approvedAt: r.approvedAt } : {}),
    ...(r.state === 'denied' && r.feedback ? { feedback: r.feedback } : {}),
    ...(r.state === 'cancelled' && r.cancelledBy ? { cancelledBy: r.cancelledBy === 'requester' ? 'requester' : 'system' } : {}),
  };
}

/**
 * The app "Deny and block" blocks (L4): an app that asked as itself. Never
 * the owner acting through an app (that request is the owner's, and blocking
 * the app would block the owner's own UI), and never Settings, the owner's
 * own system UI. Null: the dialog offers no block.
 */
export function blockableApp(r: ApprovalRecord['requester']): string | null {
  if (r.kind !== 'instance' || r.appId === 'com.aura.settings') return null;
  return r.appId;
}

/** A record as the owner's dialog sees it: plus the requester and its app, for the frame check. */
export function ownerView(r: ApprovalRecord) {
  return {
    ...requesterView(r),
    requester: r.requester,
    appId: core.requesterAppId(r.requester),
    blockable: blockableApp(r.requester),
    ...(r.decidedBy ? { decidedBy: r.decidedBy.kind === 'operator' ? 'operator' : 'owner' } : {}),
  };
}
