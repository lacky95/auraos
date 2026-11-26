// Namespace import: the running shell may cache a core build without the
// auth exports; a named import would 500 every route until restart.
import * as core from '@aura/core';
import type { AppManager } from '@aura/core';
import { errorResponse, jsonResponse } from './appResponse.js';
import {
  bearerToken, resolvePrincipal, type CallerPrincipal, type CredentialRejection, type GatewayOwnerDeps, type PrincipalDeps,
  type ResolvedPrincipal,
} from './access/identify.js';
import { coreAuthServices, userSessionOf, sessionCookieToken } from './authSurface.js';

/**
 * Central request authentication for the shell API (identity only — what a
 * principal may DO is core auth's `Authorizer`). The principal comes from the
 * one resolver the access report uses too (access/identify.ts
 * `resolvePrincipal`); this turns its verdict into a route's answer:
 *
 *   Authorization: Bearer aura1.…        → instance (verified AURA_INSTANCE_TOKEN; `userId` = its user)
 *     + the router's owner SSR claim     → user through a trusted system UI's server (D45, its
 *                                          page reads; identify.ts `ssrOwner`, the same scope)
 *   Authorization: Bearer aura_k1_…      → apiKey   (owner-issued key, verified)
 *   Authorization: Bearer aura-sess1.…   → user     (the owner's live login session)
 *   X-Aura-Operator: <one-time code>     → operator (the host CLI in the master, its
 *                                          ticket for exactly this request)
 *   any other / invalid / expired credential → 401 — NEVER downgraded to anonymous
 *   login cookie (no Authorization)      → user; an expired or revoked one → anonymous
 *   no credentials                       → anonymous (Referer / X-Aura-Instance-Id = hints only)
 *   signed App Host gateway claim        → instance, acting for the App Host session's user
 *                                          (checked first; the gateway forwards no bearer)
 *   … from a trusted system UI (D45)     → user through that UI, only on a path that UI covers
 *                                          (identify.ts `gatewayOwner`, the one D45 scope decision)
 *
 * Who may call a route is not decided here: the route access manifest says,
 * and the middleware applies it (lib/access/enforce.ts). Routes ask this for
 * the caller they act for.
 *
 * `SYSTEM_PRINCIPAL` is unreachable from HTTP by construction.
 *
 * The shared admin credential is gone (D50): the owner's management routes
 * take the owner, the operator, or the owner's approval (lib/approvals/admin.ts).
 */

export interface AuthDeps {
  mgr: Pick<AppManager, 'tokens' | 'getInstance' | 'getManifest' | 'isTrustedSystemCopy'>;
  /** App Host services for the D45 owner check; loaded when absent. */
  ownerServices?: GatewayOwnerDeps['services'];
  apiKeys: { verify(key: string): Promise<{ id: string; name: string; scopes: string[] } | null> };
  /** The users' login sessions. Absent: a login cookie is not read, a login bearer is refused. */
  login?: PrincipalDeps['login'];
  /** The host operator's one-time tickets. Absent: an operator header is not verified. */
  operatorTickets?: PrincipalDeps['operatorTickets'];
}

/** The login check of the desktop's sign-in (authSurface), on core's live stores. */
const coreLogin: NonNullable<PrincipalDeps['login']> = {
  // Called, not referenced: authSurface imports this module, so its exports are not ready at load.
  cookieToken: (request) => sessionCookieToken(request),
  userSession: async (token) => {
    const svc = coreAuthServices();
    const found = svc ? await userSessionOf(token, svc) : null;
    return found ? { sessionId: found.session.sessionId, userId: found.user.id, role: found.user.role } : null;
  },
};

export function defaultAuthDeps(): AuthDeps {
  const svc = core.getAuthServices();
  return { mgr: core.getAppManager(), apiKeys: svc.apiKeys, login: coreLogin, operatorTickets: svc.setupTickets };
}

function unauthorized(error: string, message: string): Response {
  return jsonResponse({ error, message }, 401);
}

/** The 401 for a credential that did not verify, worded as each case always was. */
function refusal(rejected: { reason: CredentialRejection; instanceId?: string }): Response {
  switch (rejected.reason) {
    case 'gateway-identity-invalid':
      return unauthorized('gateway-identity-invalid', 'invalid gateway identity');
    case 'api-key-invalid':
      return unauthorized('invalid-api-key', 'invalid or revoked API key');
    case 'unsupported-scheme':
      return errorResponse('unsupported Authorization header — send Authorization: Bearer $AURA_INSTANCE_TOKEN (or an API key / login session), or no Authorization at all', 401);
    case 'instance-not-running':
      return errorResponse(`token belongs to ${rejected.instanceId}, which is not running`, 401);
    case 'operator-ticket-invalid':
      return unauthorized('operator-ticket-invalid', 'operator code invalid, used or expired — run the aura command on the host again');
    case 'credential-invalid':
    default:
      return errorResponse('invalid or expired credential (instance token, API key or login session)', 401);
  }
}

/** The verifying resolver behind `authenticate()`. The middleware's access gate decides on it too. */
export function resolveCaller(request: Request, deps: AuthDeps = defaultAuthDeps()): Promise<ResolvedPrincipal> {
  return resolvePrincipal(request, {
    mgr: deps.mgr as unknown as PrincipalDeps['mgr'],
    apiKeys: deps.apiKeys,
    login: deps.login ?? null,
    ownerServices: deps.ownerServices,
    operatorTickets: deps.operatorTickets ?? null,
  });
}

export async function authenticate(request: Request, deps: AuthDeps = defaultAuthDeps()): Promise<CallerPrincipal | Response> {
  const r = await resolveCaller(request, deps);
  if (r.rejected) return refusal(r.rejected);
  if (r.principal.kind !== 'anonymous') return r.principal;
  // A credential that could not be checked is never anonymous.
  if (r.via === 'unverified' && bearerToken(request) !== null) return refusal({ reason: 'credential-invalid' });
  return { kind: 'anonymous', verification: 'unverified' };
}
