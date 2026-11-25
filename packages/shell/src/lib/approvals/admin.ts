/**
 * The owner's management routes (D50): grants, API keys, the audit trail, the
 * access report, manifest edits and the few other changes that took the
 * shared admin session before. That credential is gone; the owner decides.
 *
 *   the owner in the desktop (a login session, not through an app)  → directly
 *   the host operator (its one-time ticket, D8)                     → directly
 *   the owner through a trusted system UI (Settings, D45): a read   → directly
 *   …a change, and every app instance (the CLI and agents in the
 *   System Terminal)                                                → 202 needs-approval;
 *       the owner decides in the desktop, the caller sends the same
 *       request again with `X-Aura-Approval` and it is used up once
 *
 * Levels (D9): `fresh` (the password, or the host operator over HTTP, D18)
 * for privileged permissions, Docker or `*` tools, sidecars.privileged and
 * API key creation; `session` (one click) for the rest, reads included.
 * Who may call these routes at all is the route manifest's (OWNER_MANAGES).
 *
 * Every record and audit entry names the owner or the operator: for an
 * approved request, the owner who approved it, with the requester beside it.
 */
import * as core from '@aura/core';
import type { APIContext } from 'astro';
import type { AccessPrincipal, ApprovalAction, ApprovalLevel, ChangeAttribution } from '@aura/core';
import { authenticate } from '../auth.ts';
import { bearerToken, type CallerPrincipal } from '../access/identify.ts';
import { shellOwner } from '../appHostHandoff.ts';
import { adminDisplay, isRiskyPermission, isRiskyTool } from './display.ts';
import {
  actionGate, json, liveApprovalDeps, presentedApproval, requesterSummary, type ApprovalServiceDeps,
} from './service.ts';

/** The owner's management actions, and opening an app's source (Track P, same flow). */
export type AdminApprovalAction = Extract<ApprovalAction, `admin.${string}` | 'app.source.open'>;

/** One owner-management request, as its route validated it. */
export interface AdminRequest {
  action: AdminApprovalAction;
  /** Exactly what is approved: the approval binds its hash. */
  payload: unknown;
  level: ApprovalLevel;
  /** For the dialog, from the validated request: "Grant io.lakner.terminalx terminal.screen.read". */
  title: string;
  details?: readonly string[];
}

/** Who acted, for the record and the audit trail. */
export interface OwnerActor {
  by: ChangeAttribution;
  /** Audit detail: the app it came through, or the request the owner approved. */
  detail: Record<string, unknown>;
}

type RouteCtx = Pick<APIContext, 'request' | 'cookies'> & { clientAddress?: string };

export interface OwnerActionDeps {
  approvals: ApprovalServiceDeps;
  authenticate(request: Request): Promise<CallerPrincipal | Response>;
  shellOwner(ctx: RouteCtx): Promise<{ error: string; status: number } | { identity: unknown }>;
}

export function liveOwnerActionDeps(): OwnerActionDeps {
  return { approvals: liveApprovalDeps(), authenticate: (request) => authenticate(request), shellOwner: (ctx) => shellOwner(ctx) };
}

/**
 * The gate of one owner-management request: who acts (the request may go
 * ahead, any approval it presented is used up), or the answer to send.
 */
export async function ownerAction(
  ctx: RouteCtx, req: AdminRequest, deps: OwnerActionDeps = liveOwnerActionDeps(),
): Promise<OwnerActor | Response> {
  const principal = await deps.authenticate(ctx.request);
  if (principal instanceof Response) return principal;
  if (principal.kind === 'operator') return { by: core.operatorAttribution(), detail: {} };
  if (principal.kind === 'anonymous') return json({ error: 'unauthenticated' }, 401);

  if (principal.kind === 'user' && !principal.through) {
    // A login cookie rides on a sibling App Host's request too (same site): a
    // change by cookie needs the desktop's own Origin. A bearer is no cookie.
    if (req.action !== 'admin.read' && bearerToken(ctx.request) === null) {
      const owner = await deps.shellOwner(ctx);
      if ('error' in owner) return json({ error: owner.error }, owner.status);
    }
    return { by: core.userAttribution(principal), detail: {} };
  }
  if (principal.kind === 'user' && req.action === 'admin.read') {
    return { by: core.userAttribution(principal), detail: { through: principal.through?.appId } };
  }
  return approvedRequest(deps.approvals, principal, ctx.request, req);
}

/** An app's request, or a change through Settings: the owner approves exactly this one. */
async function approvedRequest(
  deps: ApprovalServiceDeps, principal: AccessPrincipal, request: Request, req: AdminRequest,
): Promise<OwnerActor | Response> {
  const gate = actionGate(deps, principal, { approvalId: presentedApproval(request) });
  if (await gate.allows(req.action, req.payload)) {
    const record = gate.consumed();
    const decided = record?.decidedBy;
    if (!record || !decided) return json({ error: 'wrong-state' }, 409);
    return {
      by: decided.kind === 'user' ? core.userAttribution({ userId: decided.userId, sessionId: decided.sessionId }) : core.operatorAttribution(),
      detail: { requestedBy: requesterSummary(record.requester), approval: record.id },
    };
  }
  return gate.needsApproval({
    action: req.action, payload: req.payload, level: req.level,
    display: (by) => adminDisplay(req.title, req.details ?? [], by),
  });
}

/** Append an owner change to the audit trail (never throws). */
export async function auditOwner(
  actor: OwnerActor | null,
  action: string,
  opts: { target?: string; outcome?: 'ok' | 'denied' | 'failed'; detail?: Record<string, unknown> } = {},
): Promise<void> {
  try {
    await core.getAuthServices().audit.record({
      by: actor?.by ?? { kind: 'anonymous' },
      action,
      ...(opts.target ? { target: opts.target } : {}),
      ...(opts.outcome ? { outcome: opts.outcome } : {}),
      ...(actor && Object.keys(actor.detail).length || opts.detail ? { detail: { ...actor?.detail, ...opts.detail } } : {}),
    });
  } catch (err) {
    console.warn(`[auth] audit write failed: ${(err as Error).message}`);
  }
}

// ── levels (D9) ─────────────────────────────────────────────────────────────

/** Granting a privileged permission needs the password (every GrantStore permission is one). */
export const grantLevel = (permission: string): ApprovalLevel =>
  core.isPrivilegedPermission(permission) || isRiskyPermission(permission) ? 'fresh' : 'session';

/**
 * A manifest edit that adds Docker or every tool, or a privileged permission,
 * needs the password; any other edit, and every removal, one click.
 */
export function manifestEditLevel(edit: { action: string; tool?: string; tools?: readonly string[]; permission?: string }): ApprovalLevel {
  switch (edit.action) {
    case 'add-tool':
    case 'add-service-tool':
      return edit.tool && isRiskyTool(edit.tool) ? 'fresh' : 'session';
    case 'set-tools':
      return (edit.tools ?? []).some(isRiskyTool) ? 'fresh' : 'session';
    case 'add-permission':
      return edit.permission ? grantLevel(edit.permission) : 'session';
    default:
      return 'session';
  }
}
