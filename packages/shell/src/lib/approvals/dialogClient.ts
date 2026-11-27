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
  display: {
    title: string; details: string[]; requestedBy: string; reason?: string;
    /** The server's high-risk review, shown first (lib/approvals/display.ts `installRisks`). */
    highRisk?: Array<{ item: string; why: string; added: boolean }>;
    /** The exact change (a patch activation), shown collapsed. */
    diff?: string;
  };
  appId: string | null;
  /** The app "Deny and block" would block (L4), or null: no block offered. */
  blockable: string | null;
  /** How a `fresh` approval is given on this connection, as the server decided it (D18, D63). */
  freshVia: 'password' | 'operator';
}

export type ApprovalWaiterKind = 'approval' | 'confirm';
export type ApprovalOutcome = 'approved' | 'denied' | 'expired' | 'unavailable';

/** Approve stays disabled this long after the dialog appears (5.10 "No accidental approval"). */
export const APPROVE_DELAY_MS = 1500;

export const APPROVAL_ID_RE = /^apr_[A-Za-z0-9_-]{22}$/;

/** A server answer as a view the dialog can show, or null. `protocol`: the page's (`location.protocol`). */
export function parseApprovalView(x: unknown, protocol = 'https:'): ApprovalDialogView | null {
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
      ...(Array.isArray(d['highRisk']) ? { highRisk: parseRisks(d['highRisk']) } : {}),
      ...(typeof d['diff'] === 'string' && d['diff'] ? { diff: d['diff'] } : {}),
    },
    appId: typeof v['appId'] === 'string' ? v['appId'] : null,
    blockable: typeof v['blockable'] === 'string' ? v['blockable'] : null,
    freshVia: freshViaOf(v['freshVia'], protocol),
  };
}

/** The well-formed high-risk lines of a view; anything else is dropped. */
function parseRisks(x: unknown[]): Array<{ item: string; why: string; added: boolean }> {
  return x.flatMap((r) => {
    const o = r as Record<string, unknown> | null;
    return o && typeof o['item'] === 'string' && typeof o['why'] === 'string' ? [{ item: o['item'], why: o['why'], added: o['added'] === true }] : [];
  });
}

/**
 * The server's `freshVia`; an older server sends none, and then only HTTPS
 * takes the password, as it did (D18).
 */
export function freshViaOf(x: unknown, protocol: string): 'password' | 'operator' {
  if (x === 'password' || x === 'operator') return x;
  return protocol === 'https:' ? 'password' : 'operator';
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

/** D18: a `fresh` approval on HTTP with HTTPS required (D63). The server refuses the password there (`operator-required`). */
export function operatorRequiredText(approvalId: string): string {
  return `This needs HTTPS, or approve on the host with \`aura approve ${approvalId}\`.`;
}

/** D63: a `fresh` approval whose password goes over plain HTTP. Informational only. */
export const PASSWORD_OVER_HTTP_NOTE = '(HTTP: password sent unencrypted)';

export function passwordTransportNote(view: Pick<ApprovalDialogView, 'level' | 'freshVia'>, protocol: string): string | null {
  return view.level === 'fresh' && view.freshVia === 'password' && protocol !== 'https:' ? PASSWORD_OVER_HTTP_NOTE : null;
}

/**
 * D56 (owner decision): a secret may be stored over plain HTTP, with this
 * notice under the secret field. None on HTTPS, none for other approvals.
 */
export const SECRET_OVER_HTTP_NOTICE = 'This connection is not encrypted — use HTTPS for sensitive secrets.';

export function secretTransportNotice(action: string, protocol: string): string | null {
  return action === 'credential.store' && protocol !== 'https:' ? SECRET_OVER_HTTP_NOTICE : null;
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
    case 'secret-required': return 'Enter the secret to approve this.';
    case 'secret-too-long': return 'That secret is too long (4 KiB at most).';
    case 'other-user': return 'This request acts for another user.';
    case 'store-failed': return 'AuraOS could not keep the secret. Try again.';
    default: return 'That did not work. Try again.';
  }
}
