/**
 * `osClient.approvals`: ask the owner to approve an action, and get back a
 * single-use grant (5.10, D48).
 *
 *   // An action route answered 202 with an approval id (Nexus install, an
 *   // Aura Context write): ask the owner about it, then send it again.
 *   const { approved, approvalId } = await osClient.approvals.request({ approvalId: body.approvalId });
 *   if (approved) await fetch(url, { method: 'POST', headers: approvalHeader(approvalId), body });
 *
 *   // Or create one yourself, for an action AuraOS lets apps ask for:
 *   const r = await osClient.approvals.request({ action: 'user.confirm', payload: { action: 'wipe-board' }, level: 'fresh' });
 *
 * Creating an approval (`POST /api/approvals`) needs the `user.confirm`
 * permission; waiting on one an AuraOS route created for this app needs none.
 *
 * The owner decides in AuraOS's own dialog, from what the server verified:
 * the requesting app, the action and its payload. Your `reason` is shown
 * labelled as your words. The result is only the outcome; `approvalId` is the
 * grant: single use, bound to this instance, its user and the exact action
 * and payload, and it expires (10 minutes). The route that performs the
 * action uses it up (`X-Aura-Approval: <id>`).
 *
 * In a page the dialog opens at once; on a server the request waits in the
 * owner's pending list (the desktop shows it) and `request()` polls it.
 *
 * To confirm one of your own actions (no AuraOS route behind it), use
 * `osClient.user.confirm`, which is this same approval with action
 * `user.confirm`.
 */
import { isFromShell, postToShell } from './channel.js';
import { OsError, osErrorFrom } from './errors.js';
import { appHostRuntime, isBrowser, osAuthHeaders, osBase } from './os-auth.js';

/** The header an action route reads the grant from. */
export const APPROVAL_HEADER = 'X-Aura-Approval';
/** `{ 'X-Aura-Approval': id }`, for the request that uses the grant up. */
export const approvalHeader = (approvalId: string): Record<string, string> => ({ [APPROVAL_HEADER]: approvalId });

export type ApprovalLevel = 'session' | 'fresh';

/**
 * `approved` (or used up already); `denied`; `expired`; `blocked` (the owner
 * blocked requests from this app); `busy` (one request of this instance is
 * already waiting, or too many); `unavailable` (no dialog could be shown, an
 * unknown id). D102: `cancelled` (withdrawn, or no longer valid); `on_hold`
 * (the owner chose Later; only with `returnOnHold`, the request stays
 * pending and authorizes nothing: wait again with the same `approvalId`).
 */
export type ApprovalOutcome = 'approved' | 'denied' | 'expired' | 'blocked' | 'busy' | 'cancelled' | 'on_hold' | 'unavailable';

export interface ApprovalResult {
  approved: boolean;
  outcome: ApprovalOutcome;
  /** The grant; present once an approval exists (also when it was refused). */
  approvalId?: string;
  /** D102: the owner's optional words with a denial, to adapt your plan. Grants nothing. */
  feedback?: string;
  /** D102, `on_hold`: until when the owner may still decide (ms since the epoch). */
  heldUntil?: number;
}

export interface ApprovalAsk {
  /** An action AuraOS lets apps ask for (`os.context.write`, `user.confirm`). */
  action: string;
  /** The action's payload; the grant is bound to it exactly. */
  payload?: unknown;
  /** `session` (default): a click. `fresh`: also the owner's password. Some actions fix their own level. */
  level?: ApprovalLevel;
  /** Shown to the owner, labelled as the app's words. */
  reason?: string;
}

export interface ApprovalWaitOptions {
  /** Server side: give up after this long (default: until the approval expires). */
  timeoutMs?: number;
  /** Server side: poll interval, default 1500 ms. */
  pollMs?: number;
  /** Server side: another instance token than `AURA_INSTANCE_TOKEN`. */
  token?: string;
  /**
   * D102, server side: when the owner puts the request on hold, return
   * `{ outcome: 'on_hold' }` at once instead of waiting (up to 24 hours).
   */
  returnOnHold?: boolean;
}

const NO = (outcome: ApprovalOutcome, approvalId?: string, extra: { feedback?: unknown; heldUntil?: unknown } = {}): ApprovalResult => ({
  approved: false, outcome, ...(approvalId ? { approvalId } : {}),
  ...(outcome === 'denied' && typeof extra.feedback === 'string' && extra.feedback ? { feedback: extra.feedback } : {}),
  ...(outcome === 'on_hold' && typeof extra.heldUntil === 'number' ? { heldUntil: extra.heldUntil } : {}),
});

function base(): string {
  return osBase({ mode: isBrowser() ? 'relative' : 'server' });
}

function requestId(): string {
  const c = globalThis.crypto;
  return c?.randomUUID ? c.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** The outcome a server state means; null while it is still open. */
function outcomeOf(state: unknown): ApprovalOutcome | null {
  switch (state) {
    case 'pending': return null;
    case 'approved': case 'consumed': return 'approved';
    case 'denied': return 'denied';
    case 'expired': return 'expired';
    case 'cancelled': return 'cancelled';
    default: return 'unavailable';
  }
}

/**
 * POST /api/approvals. The id of the new approval, or the outcome that makes
 * it a "no" without asking (blocked, busy). Throws OsError for a bad request.
 */
export async function createApproval(ask: ApprovalAsk, opts: { token?: string } = {}): Promise<{ id: string; expiresAt?: number } | { no: ApprovalOutcome }> {
  const url = `${base()}/api/approvals`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...osAuthHeaders(url, opts.token !== undefined ? { token: opts.token } : {}) },
    body: JSON.stringify({
      action: ask.action,
      ...(ask.payload !== undefined ? { payload: ask.payload } : {}),
      ...(ask.level ? { level: ask.level } : {}),
      ...(ask.reason ? { reason: ask.reason } : {}),
    }),
  });
  if (res.ok) {
    const body = await res.json().catch(() => ({})) as { id?: unknown; expiresAt?: unknown };
    if (typeof body.id === 'string') return { id: body.id, ...(typeof body.expiresAt === 'number' ? { expiresAt: body.expiresAt } : {}) };
    throw new OsError(res.status, 'invalid-response', 'approvals: the OS answered without an approval id');
  }
  const err = await osErrorFrom(res, 'approvals: POST /api/approvals');
  // The owner blocked this app, or a request is already waiting: a "no", not a bug.
  if (res.status === 403 && err.code === 'blocked') return { no: 'blocked' };
  if (res.status === 429) return { no: 'busy' };
  throw err;
}

export class ApprovalsApi {
  /**
   * Ask the owner and wait for the answer. Pass `{ approvalId }` for an
   * approval an action route created (its 202 answer), or an `ApprovalAsk`
   * to create one. Resolves `{ approved: false }` for every kind of "no";
   * rejects (OsError) only on a bad request or a missing permission.
   */
  async request(ask: ApprovalAsk | { approvalId: string }, opts: ApprovalWaitOptions = {}): Promise<ApprovalResult> {
    let id: string;
    if ('approvalId' in ask) {
      id = ask.approvalId;
    } else {
      const created = await createApproval(ask, opts);
      if ('no' in created) return NO(created.no);
      id = created.id;
    }
    return this.wait(id, opts);
  }

  /** Wait for the owner's decision on an approval this app asked for. */
  wait(approvalId: string, opts: ApprovalWaitOptions = {}): Promise<ApprovalResult> {
    if (isBrowser() && appHostRuntime()) return this.askShell(approvalId);
    return this.poll(approvalId, opts);
  }

  /**
   * D102: withdraw a request this app asked for and no longer needs (pending,
   * held, or approved and not yet used). True when it was withdrawn.
   */
  async cancel(approvalId: string, opts: { token?: string } = {}): Promise<boolean> {
    const url = `${base()}/api/approvals/${encodeURIComponent(approvalId)}/cancel`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...osAuthHeaders(url, opts.token !== undefined ? { token: opts.token } : {}) },
      body: '{}',
    });
    return res.ok;
  }

  /** The approval's state as its requester sees it, or null when unknown. */
  async get(approvalId: string, opts: { token?: string } = {}): Promise<{
    id: string; action: string; level: ApprovalLevel; state: string; expiresAt: number;
    /** D102 */ class?: 'forced' | 'deferrable'; heldAt?: number; feedback?: string;
  } | null> {
    const url = `${base()}/api/approvals/${encodeURIComponent(approvalId)}`;
    const res = await fetch(url, { headers: { accept: 'application/json', ...osAuthHeaders(url, opts.token !== undefined ? { token: opts.token } : {}) } });
    if (res.status === 404) return null;
    if (!res.ok) throw await osErrorFrom(res, `approvals: GET ${approvalId}`);
    return await res.json() as { id: string; action: string; level: ApprovalLevel; state: string; expiresAt: number };
  }

  /** A page: the Shell shows the dialog for this approval and answers once. */
  private askShell(approvalId: string): Promise<ApprovalResult> {
    const rid = requestId();
    return new Promise((resolve) => {
      const onMessage = (ev: MessageEvent) => {
        if (!isFromShell(ev)) return;
        const d = ev.data as { type?: unknown; requestId?: unknown; ok?: unknown; error?: unknown; approvalId?: unknown } | null;
        if (!d || d.type !== 'aura.approval.result' || d.requestId !== rid) return;
        window.removeEventListener('message', onMessage);
        if (d.ok === true && d.approvalId === approvalId) { resolve({ approved: true, outcome: 'approved', approvalId }); return; }
        const e = d.error;
        resolve(NO(e === 'denied' || e === 'expired' || e === 'cancelled' ? e : 'unavailable', approvalId, d as { feedback?: unknown }));
      };
      window.addEventListener('message', onMessage);
      postToShell({ type: 'aura.approval.request', requestId: rid, approvalId });
    });
  }

  /** A server: the owner sees the request in the desktop's pending list; poll until it is decided. */
  private async poll(approvalId: string, opts: ApprovalWaitOptions): Promise<ApprovalResult> {
    const pollMs = Math.max(250, opts.pollMs ?? 1500);
    const started = Date.now();
    for (;;) {
      const view = await this.get(approvalId, opts);
      if (!view) return NO('unavailable', approvalId);
      const outcome = outcomeOf(view.state);
      if (outcome) return outcome === 'approved' ? { approved: true, outcome, approvalId } : NO(outcome, approvalId, view);
      // D102: held by the owner; still pending, authorizes nothing.
      if (opts.returnOnHold && typeof view.heldAt === 'number') return NO('on_hold', approvalId, { heldUntil: view.expiresAt });
      const now = Date.now();
      if (opts.timeoutMs !== undefined && now - started >= opts.timeoutMs) return NO('expired', approvalId);
      if (typeof view.expiresAt === 'number' && now > view.expiresAt + 1000) return NO('expired', approvalId);
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
}
