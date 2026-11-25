/**
 * The browser half of the owner's approval dialog (components/shell/
 * OwnerPasswordDialog.astro): what an approval looks like to it, and the only
 * answers it may send back to an app. Pure, so tests pin both.
 *
 * An app learns only the outcome. `aura.user.confirm.result` carries
 * `{confirmed, approvalId?}` (D49): no password, no reason for a no, so a
 * wrong password and a cancel look the same.
 */

/** The owner's view of a pending approval (lib/approvals/service.ts `ownerView`). */
export interface ApprovalDialogView {
  id: string;
  action: string;
  level: 'session' | 'fresh';
  state: 'pending' | 'approved' | 'denied' | 'consumed' | 'expired';
  expiresAt: number;
  display: { title: string; details: string[]; requestedBy: string; reason?: string };
  appId: string | null;
}

export type ApprovalWaiterKind = 'approval' | 'confirm';
export type ApprovalOutcome = 'approved' | 'denied' | 'expired' | 'unavailable';

/** Approve stays disabled this long after the dialog appears (5.10 "No accidental approval"). */
export const APPROVE_DELAY_MS = 1500;

export const APPROVAL_ID_RE = /^apr_[A-Za-z0-9_-]{22}$/;

/** A server answer as a view the dialog can show, or null. */
export function parseApprovalView(x: unknown): ApprovalDialogView | null {
  if (!x || typeof x !== 'object') return null;
  const v = x as Record<string, unknown>;
  const d = v['display'] as Record<string, unknown> | undefined;
  if (typeof v['id'] !== 'string' || !APPROVAL_ID_RE.test(v['id'])) return null;
  if (v['level'] !== 'session' && v['level'] !== 'fresh') return null;
  if (typeof v['state'] !== 'string' || typeof v['expiresAt'] !== 'number' || typeof v['action'] !== 'string') return null;
  if (!d || typeof d['title'] !== 'string' || typeof d['requestedBy'] !== 'string' || !Array.isArray(d['details'])) return null;
  return {
    id: v['id'], action: v['action'], level: v['level'], state: v['state'] as ApprovalDialogView['state'], expiresAt: v['expiresAt'],
    display: {
      title: d['title'], requestedBy: d['requestedBy'],
      details: (d['details'] as unknown[]).filter((l): l is string => typeof l === 'string'),
      ...(typeof d['reason'] === 'string' ? { reason: d['reason'] } : {}),
    },
    appId: typeof v['appId'] === 'string' ? v['appId'] : null,
  };
}

/** The outcome a record's state means for whoever waits on it. Null while it is still open. */
export function outcomeOf(state: string | undefined): ApprovalOutcome | null {
  switch (state) {
    case 'pending': return null;
    case 'approved': case 'consumed': return 'approved';
    case 'denied': return 'denied';
    case 'expired': return 'expired';
    default: return 'unavailable';
  }
}

/** The one answer to an app's `aura.approval.request` or `aura.user.confirm.request`. */
export function approvalReply(kind: ApprovalWaiterKind, requestId: unknown, approvalId: string, outcome: ApprovalOutcome) {
  const rid = typeof requestId === 'string' ? requestId : '';
  if (kind === 'confirm') {
    return outcome === 'approved'
      ? { type: 'aura.user.confirm.result' as const, requestId: rid, confirmed: true, approvalId }
      : { type: 'aura.user.confirm.result' as const, requestId: rid, confirmed: false };
  }
  return outcome === 'approved'
    ? { type: 'aura.approval.result' as const, requestId: rid, approvalId, ok: true }
    : { type: 'aura.approval.result' as const, requestId: rid, approvalId, ok: false, error: outcome };
}

/** D18: a `fresh` approval on an HTTP page. The server refuses the password there (`operator-required`). */
export function operatorRequiredText(approvalId: string): string {
  return `This needs HTTPS, or approve on the host with \`aura approve ${approvalId}\`.`;
}

/** The dialog's text for a refused decision. */
export function decisionErrorText(error: string | undefined, approvalId: string): string {
  switch (error) {
    case 'invalid-credentials': return 'The password is wrong.';
    case 'password-required': return 'Enter your password to approve this.';
    case 'rate-limited': return 'Too many attempts. Wait a minute and try again.';
    case 'operator-required': return operatorRequiredText(approvalId);
    case 'locked': return 'Unlock the screen first.';
    case 'login-required': return 'Your login session has ended. Sign in again.';
    case 'forbidden-origin': return 'This page may not decide approvals.';
    default: return 'That did not work. Try again.';
  }
}
