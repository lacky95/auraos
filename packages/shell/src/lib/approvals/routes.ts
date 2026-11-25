/**
 * The handlers behind `/api/approvals/*` (5.10). The route files only bind
 * them to the live services.
 *
 *   GET    /api/approvals                 owner's desktop: pending requests (long poll) and blocked apps
 *   POST   /api/approvals                 a requester asks: `user.confirm`, `os.context.write`
 *   GET    /api/approvals/<id>            its requester polls (or the owner's desktop reads it)
 *   POST   /api/approvals/<id>/approve    the owner in the shell's own document, or the host operator
 *   POST   /api/approvals/<id>/deny       the same; `{block: true}` also blocks the requesting app
 *   POST   /api/approvals/<id>/consume    the requester uses up a `user.confirm` approval
 *   DELETE /api/approvals/blocked/<app>   the owner (or operator) lifts a block
 *
 * A `credential.store` (D56) is created by `/api/credentials/requests`; its
 * approve request also carries the secret the owner typed into the dialog,
 * which goes straight to the owner's vault (`storeCredential`). The host
 * operator may deny one, never approve it: it cannot type the secret.
 *
 * Install and update approvals are created by `/api/nexus/install|update`
 * itself, from the binding and PermissionDiff it computed: no request body
 * can describe an install.
 *
 * The owner decides only from the shell's exact Origin, with the login
 * cookie, on an unlocked tab (`X-Aura-Client-Session`), and never with a
 * bearer: instance tokens and API keys are refused. A `fresh` approval also
 * needs the owner's password, checked by core's `verifyPassword` under the
 * login rate limit, over HTTPS; over HTTP it is the host operator's (D18).
 */
import * as core from '@aura/core';
import type { AccessPrincipal, ApprovalAction, ApprovalRecord } from '@aura/core';
import type { CallerPrincipal } from '../access/identify.ts';
import { GATEWAY_IDENTITY_HEADER } from '@aura/core/host-rules';
import {
  confirmDisplay, confirmPayload, contextDisplay, contextWrite, credentialAsk, requesterReason, type CredentialAsk,
} from './display.ts';
import {
  approvalsChanged, approvalsVersion, blockableApp, json, ownerView, refusal, requestApproval, requesterSummary,
  requesterView, waitForApprovals, consumeApproval, type ApprovalServiceDeps,
} from './service.ts';

export const MAX_BODY_BYTES = 8 * 1024;
/** How long the desktop's poll waits for a change. */
export const LONG_POLL_MS = 25_000;
/** The approve request names its password field so; nothing else carries one. */
const PASSWORD_FIELD = 'password';
/** The approve request of a `credential.store` carries the secret the owner typed in this field (D56). */
const SECRET_FIELD = 'secret';

export interface OwnerSession { userId: string; sessionId: string; username: string }

/** The part of Astro's APIContext these handlers read. */
export interface RouteCtx {
  request: Request;
  readonly clientAddress?: string;
}

export interface ApprovalRouteDeps extends ApprovalServiceDeps {
  /** The shell's principal for a request (lib/auth.ts `authenticate`). */
  authenticate(request: Request): Promise<CallerPrincipal | Response>;
  /**
   * The owner's login session from the cookie, on the shell's exact Origin
   * (appHostHandoff `shellOwner`), with the scheme the browser used.
   */
  shellOwner(ctx: RouteCtx): Promise<{ owner: OwnerSession; scheme: string } | { error: string; status: number }>;
  /** The owner's login session from the cookie, for a read (no Origin on a same-origin GET). */
  ownerRead(ctx: RouteCtx): Promise<OwnerSession | null>;
  /** A shell tab's lock state, from its client session id. */
  lockOf(sid: string): Promise<'locked' | 'unlocked'>;
  /** The owner's password, through core's login rate limit. */
  verifyPassword(username: string, password: string, rateLimitKey: string | undefined): Promise<'ok' | 'invalid' | 'rate-limited'>;
  /** The login rate-limit key of this client (authSurface `clientRateKey`). */
  rateKey(ctx: RouteCtx): string | undefined;
  /**
   * D56: keep the secret the owner typed into the dialog for an approved
   * `credential.store`, in `userId`'s vault (lib/credentials.ts). Absent: no
   * vault here, and such an approval is refused.
   */
  storeCredential?(userId: string, ask: CredentialAsk, value: string, record: ApprovalRecord): Promise<void>;
}

const CLIENT_SESSION_HEADER = 'x-aura-client-session';

async function readBody(request: Request): Promise<Record<string, unknown> | Response> {
  const type = request.headers.get('content-type') ?? '';
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return json({ error: 'body-too-large' }, 413);
  const text = await request.text().catch(() => null);
  if (text === null) return json({ error: 'invalid-request' }, 400);
  if (text.length === 0) return {};
  if (!/^application\/json\s*(;|$)/i.test(type)) return json({ error: 'json-required' }, 415);
  if (text.length > MAX_BODY_BYTES) return json({ error: 'body-too-large' }, 413);
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch { /* below */ }
  return json({ error: 'invalid-request' }, 400);
}

/** The owner, directly in the shell's own document (no app, no bearer). */
const isShellDocumentRequest = (request: Request) =>
  !request.headers.has('authorization') && !request.headers.has(GATEWAY_IDENTITY_HEADER);

// ── GET /api/approvals ──────────────────────────────────────────────────────

export async function listApprovals(ctx: RouteCtx, deps: ApprovalRouteDeps): Promise<Response> {
  const { request } = ctx;
  if (!isShellDocumentRequest(request)) return json({ error: 'owner-required' }, 403);
  const site = request.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin') return json({ error: 'forbidden-origin' }, 403);
  if (!(await deps.ownerRead(ctx))) return json({ error: 'login-required' }, 401);
  const url = new URL(request.url);
  const seen = Number(url.searchParams.get('seen'));
  if (url.searchParams.has('seen') && Number.isInteger(seen)) {
    await waitForApprovals(seen, LONG_POLL_MS, request.signal);
  }
  const [pending, blocked] = await Promise.all([deps.store.listPending(), deps.store.listBlocked()]);
  return json({ version: approvalsVersion(), pending: pending.map(ownerView), blocked });
}

// ── POST /api/approvals ─────────────────────────────────────────────────────

const CREATABLE: ReadonlySet<ApprovalAction> = new Set<ApprovalAction>(['user.confirm', 'os.context.write']);

export async function createApproval(ctx: RouteCtx, deps: ApprovalRouteDeps): Promise<Response> {
  const { request } = ctx;
  const principal = await deps.authenticate(request);
  if (principal instanceof Response) return principal;
  const body = await readBody(request);
  if (body instanceof Response) return body;

  const action = body['action'];
  if (typeof action !== 'string' || !(core.APPROVAL_ACTIONS as readonly string[]).includes(action)) {
    return json({ error: 'invalid-action' }, 400);
  }
  if (!CREATABLE.has(action as ApprovalAction)) {
    return json({ error: 'use-the-action-route', message: `Approvals for ${action} come from the route that performs it.` }, 400);
  }
  const requester = core.approvalRequester(principal);
  if (!requester) return refusal('not-a-requester');
  // A login cookie alone could be riding on another site's form: the owner's
  // own desktop asks from its exact Origin.
  if (requester.kind === 'user' && !requester.through) {
    const owner = await deps.shellOwner(ctx);
    if ('error' in owner) return json({ error: owner.error }, owner.status);
  }

  if (action === 'user.confirm') {
    // An app asks: the dialog names the verified app, never just "you".
    if (!core.requesterAppId(requester)) return json({ error: 'app-required' }, 403);
    const payload = confirmPayload(body['payload']);
    if (!payload) return json({ error: 'invalid-payload', message: 'payload.action must be a short identifier' }, 400);
    const level = body['level'] === 'fresh' ? 'fresh' : body['level'] === undefined || body['level'] === 'session' ? 'session' : null;
    if (!level) return json({ error: 'invalid-level' }, 400);
    const reason = requesterReason(body['reason']);
    const r = await requestApproval(deps, principal, {
      action: 'user.confirm', payload, level, display: (by) => confirmDisplay(payload, by, reason),
    });
    return r.ok ? json(requesterView(r.record), 201) : refusal(r.reason);
  }

  const write = contextWrite(body['payload']);
  if (!write) return json({ error: 'invalid-payload' }, 400);
  const r = await requestApproval(deps, principal, {
    action: 'os.context.write', payload: write, level: 'fresh', display: (by) => contextDisplay(write, by),
  });
  return r.ok ? json(requesterView(r.record), 201) : refusal(r.reason);
}

// ── GET /api/approvals/<id> ─────────────────────────────────────────────────

export async function getApproval(ctx: RouteCtx, id: string | undefined, deps: ApprovalRouteDeps): Promise<Response> {
  const { request } = ctx;
  if (!id || !core.isApprovalId(id)) return refusal('not-found');
  const record = await deps.store.get(id);
  // An owner read from the desktop sees the requester too.
  if (isShellDocumentRequest(request)) {
    const site = request.headers.get('sec-fetch-site');
    if ((site === null || site === 'same-origin') && await deps.ownerRead(ctx)) {
      return record ? json(ownerView(record)) : refusal('not-found');
    }
  }
  const principal = await deps.authenticate(request);
  if (principal instanceof Response) return principal;
  const requester = core.approvalRequester(principal);
  // Someone else's id reads as unknown.
  if (!record || !requester || !core.sameRequester(requester, record.requester)) return refusal('not-found');
  return json(requesterView(record));
}

// ── POST /api/approvals/<id>/<decision> ─────────────────────────────────────

export async function decideApproval(
  ctx: RouteCtx, id: string | undefined, decision: string | undefined, deps: ApprovalRouteDeps,
): Promise<Response> {
  const { request } = ctx;
  if (!id || !core.isApprovalId(id)) return refusal('not-found');
  if (decision === 'consume') return consumeConfirm(request, id, deps);
  if (decision !== 'approve' && decision !== 'deny') return json({ error: 'not-found' }, 404);
  const body = await readBody(request);
  if (body instanceof Response) return body;
  if (body['operatorCode'] !== undefined) return operatorDecision(id, decision, body, deps);

  // The owner, in the shell's own document. Never a token or a key.
  if (request.headers.has('authorization')) return refusal('not-a-decider');
  if (request.headers.has(GATEWAY_IDENTITY_HEADER)) return refusal('not-a-decider');
  const shell = await deps.shellOwner(ctx);
  if ('error' in shell) return json({ error: shell.error }, shell.status);
  const sid = request.headers.get(CLIENT_SESSION_HEADER)?.trim();
  if (!sid || (await deps.lockOf(sid)) !== 'unlocked') return json({ error: 'locked', message: 'Unlock this screen first.' }, 403);

  const record = await deps.store.get(id);
  if (!record) return refusal('not-found');
  const { owner } = shell;

  // D56: the secret is typed only here, in the shell's dialog, and goes straight to the owner's vault.
  let credential: { ask: CredentialAsk; value: string } | null = null;
  if (decision === 'approve' && record.action === 'credential.store') {
    const ask = credentialAsk(record.payload);
    if (!ask || core.payloadHash(ask) !== record.payloadHash) return refusal('mismatch');
    const requesterUser = record.requester.kind === 'apiKey' ? undefined : record.requester.userId;
    if (requesterUser && requesterUser !== owner.userId) return json({ error: 'other-user', message: 'This request acts for another user.' }, 403);
    if (!deps.storeCredential) return json({ error: 'vault-unavailable' }, 503);
    const value = body[SECRET_FIELD];
    if (typeof value !== 'string' || value.length === 0) return json({ error: 'secret-required' }, 400);
    if (Buffer.byteLength(value, 'utf8') > core.MAX_CREDENTIAL_BYTES) return json({ error: 'secret-too-long' }, 413);
    credential = { ask, value };
  }

  let fresh = false;
  if (decision === 'approve' && record.level === 'fresh') {
    // D18: the password travels only over HTTPS; on HTTP the host operator approves.
    if (shell.scheme !== 'https') {
      return json({ error: 'operator-required', message: `This needs HTTPS, or approve on the host with \`aura approve ${id}\`.` }, 403);
    }
    const password = body[PASSWORD_FIELD];
    if (typeof password !== 'string' || !password || !core.passwordWithinMax(password)) return json({ error: 'password-required' }, 401);
    const check = await deps.verifyPassword(owner.username, password, deps.rateKey(ctx));
    if (check === 'rate-limited') return json({ error: 'rate-limited' }, 429);
    if (check !== 'ok') return json({ error: 'invalid-credentials' }, 401);
    fresh = true;
  }

  const principal: AccessPrincipal = {
    kind: 'user', userId: owner.userId, role: 'owner', sessionId: owner.sessionId, verification: 'verified',
  };
  const decider = core.approvalDecider(principal, { fresh });
  if (!decider) return refusal('not-a-decider');
  const result = decision === 'approve' ? await deps.store.approve(id, decider) : await deps.store.deny(id, decider);
  if (!result.ok) return refusal(result.reason);
  if (credential) {
    try {
      await deps.storeCredential!(owner.userId, credential.ask, credential.value, result.record);
    } catch {
      approvalsChanged();
      return json({ error: 'store-failed', message: 'AuraOS could not keep the secret. Ask again.' }, 500);
    } finally {
      credential.value = '';
    }
  }

  const appId = blockableApp(record.requester);
  const block = decision === 'deny' && body['block'] === true && appId !== null;
  if (block) await deps.store.block(appId, `user:${owner.userId}`);
  approvalsChanged();
  await recordDecision(deps, core.userAttribution({ userId: owner.userId, sessionId: owner.sessionId }), result.record, decision, {
    decidedBy: `owner ${owner.userId}`, fresh, ...(block ? { blocked: appId } : {}),
  });
  return json({ ok: true, state: result.record.state, ...(block ? { blocked: appId } : {}) });
}

async function recordDecision(
  deps: ApprovalRouteDeps, by: Parameters<ApprovalRouteDeps['audit']>[0]['by'],
  record: Awaited<ReturnType<ApprovalRouteDeps['store']['get']>> & object, decision: 'approve' | 'deny',
  extra: Record<string, unknown>,
): Promise<void> {
  try {
    await deps.audit({
      by, action: decision === 'approve' ? 'approval.approved' : 'approval.denied', target: `approval:${record.id}`, outcome: 'ok',
      detail: {
        action: record.action, level: record.level, title: record.display.title,
        requestedBy: requesterSummary(record.requester), ...extra,
      },
    });
  } catch { /* the audit trail must not fail the request */ }
}

/** `aura approve <id>` on the host (D18): an operator code for `<decision>:<id>`. */
async function operatorDecision(
  id: string, decision: 'approve' | 'deny', body: Record<string, unknown>, deps: ApprovalRouteDeps,
): Promise<Response> {
  const code = body['operatorCode'];
  const subject = `${decision}:${id}`;
  if (typeof code !== 'string' || !code) return json({ error: 'operator-code-invalid' }, 403);
  if (body['preview'] === true) {
    const ticket = await deps.tickets.peek(code, 'operator');
    if (!ticket || ticket.subject !== subject) return json({ error: 'operator-code-invalid' }, 403);
    const record = await deps.store.get(id);
    return record ? json(ownerView(record)) : refusal('not-found');
  }
  const ticket = await deps.tickets.claim(code, 'operator');
  if (!ticket || ticket.subject !== subject) return json({ error: 'operator-code-invalid' }, 403);
  const record = await deps.store.get(id);
  if (!record) return refusal('not-found');
  if (decision === 'approve' && record.action === 'credential.store') {
    return json({ error: 'dialog-required', message: 'A secret is typed only into the AuraOS desktop\'s own dialog. Approve it there, or deny it here.' }, 409);
  }
  const result = decision === 'approve' ? await deps.store.approve(id, { kind: 'operator' }) : await deps.store.deny(id, { kind: 'operator' });
  if (!result.ok) return refusal(result.reason);
  approvalsChanged();
  await recordDecision(deps, core.operatorAttribution(), result.record, decision, { decidedBy: 'host operator' });
  return json({ ok: true, state: result.record.state });
}

/** The requester (an app's server) uses up a `user.confirm` approval it was handed. */
async function consumeConfirm(request: Request, id: string, deps: ApprovalRouteDeps): Promise<Response> {
  const principal = await deps.authenticate(request);
  if (principal instanceof Response) return principal;
  const body = await readBody(request);
  if (body instanceof Response) return body;
  const payload = confirmPayload(body['payload']);
  if (!payload) return json({ error: 'invalid-payload' }, 400);
  const result = await consumeApproval(deps, principal, id, 'user.confirm', payload);
  return result.ok ? json({ ok: true }) : refusal(result.reason);
}

// ── DELETE /api/approvals/blocked/<appId> ───────────────────────────────────

const APP_ID_RE = /^[A-Za-z0-9._-]{1,200}$/;

export async function unblockApp(ctx: RouteCtx, appId: string | undefined, deps: ApprovalRouteDeps): Promise<Response> {
  const { request } = ctx;
  if (!appId || !APP_ID_RE.test(appId)) return json({ error: 'invalid-app' }, 400);
  const body = await readBody(request);
  if (body instanceof Response) return body;
  let by: Parameters<ApprovalRouteDeps['audit']>[0]['by'];
  if (body['operatorCode'] !== undefined) {
    const ticket = typeof body['operatorCode'] === 'string' ? await deps.tickets.claim(body['operatorCode'], 'operator') : null;
    if (!ticket || ticket.subject !== `unblock:${appId}`) return json({ error: 'operator-code-invalid' }, 403);
    by = core.operatorAttribution();
  } else {
    if (!isShellDocumentRequest(request)) return refusal('not-a-decider');
    const shell = await deps.shellOwner(ctx);
    if ('error' in shell) return json({ error: shell.error }, shell.status);
    by = core.userAttribution({ userId: shell.owner.userId, sessionId: shell.owner.sessionId });
  }
  const removed = await deps.store.unblock(appId);
  if (removed) {
    approvalsChanged();
    try { await deps.audit({ by, action: 'approval.unblocked', target: `app:${appId}`, outcome: 'ok' }); } catch { /* best effort */ }
  }
  return json({ ok: true, removed });
}
