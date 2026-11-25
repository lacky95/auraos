// Namespace import: the running shell may cache a core build without the
// auth exports; a named import would 500 every route until restart.
import * as core from '@aura/core';
import type { AdminPrincipal, AppManager, Principal } from '@aura/core';
import { errorResponse, jsonResponse } from './appResponse.js';
import {
  bearerToken, resolvePrincipal, type CredentialRejection, type GatewayOwnerDeps, type PrincipalDeps,
  type ResolvedPrincipal,
} from './access/identify.js';
import { coreAuthServices, ownerSessionOf, sessionCookieToken } from './authSurface.js';

/**
 * Central request authentication for the shell API (identity only — what a
 * principal may DO is core auth's `Authorizer`). The principal comes from the
 * one resolver the access report uses too (access/identify.ts
 * `resolvePrincipal`); this turns its verdict into a route's answer:
 *
 *   Authorization: Bearer aura1.…        → instance (verified AURA_INSTANCE_TOKEN; `userId` = its user)
 *   Authorization: Bearer aura_k1_…      → apiKey   (admin-issued key, verified)
 *   Authorization: Bearer aura-admin1.…  → admin    (session from the shared credential)
 *   Authorization: Bearer aura-sess1.…   → user     (the owner's live login session)
 *   any other / invalid / expired credential → 401 — NEVER downgraded to anonymous
 *   login cookie (no Authorization)      → user; an expired or revoked one → anonymous
 *   no credentials                       → anonymous (Referer / X-Aura-Instance-Id = hints only)
 *   signed App Host gateway claim        → instance, acting for the App Host session's user
 *                                          (checked first; the gateway forwards no bearer)
 *   … from a trusted system UI (D45)     → user through that UI; admin with a valid admin
 *                                          session bearer, which the gateway forwards for that
 *                                          UI alone, and only on a path that UI covers
 *                                          (identify.ts `gatewayOwner`, the one D45 scope decision)
 *
 * Who may call a route is not decided here: the route access manifest says,
 * and the middleware applies it (lib/access/enforce.ts). Routes ask this for
 * the caller they act for.
 *
 * `SYSTEM_PRINCIPAL` is unreachable from HTTP by construction.
 *
 * Admin credentials are headers, never cookies: the shell proxy forwards
 * request headers to app upstreams, so a cookie would leak to every app.
 */

export interface AuthDeps {
  mgr: Pick<AppManager, 'tokens' | 'getInstance' | 'getManifest'>;
  /** App Host services for the D45 owner check; loaded when absent. */
  ownerServices?: GatewayOwnerDeps['services'];
  apiKeys: { verify(key: string): Promise<{ id: string; name: string; scopes: string[] } | null> };
  admin: { verifySession(token: string): Promise<{ sessionId: string; expiresAt: number } | null> };
  /** The owner's login sessions. Absent: a login cookie is not read, a login bearer is refused. */
  login?: PrincipalDeps['login'];
}

/** The login check of the desktop's sign-in (authSurface), on core's live stores. */
const coreLogin: NonNullable<PrincipalDeps['login']> = {
  // Called, not referenced: authSurface imports this module, so its exports are not ready at load.
  cookieToken: (request) => sessionCookieToken(request),
  ownerSession: async (token) => {
    const svc = coreAuthServices();
    const found = svc ? await ownerSessionOf(token, svc) : null;
    return found ? { sessionId: found.session.sessionId, userId: found.user.id } : null;
  },
};

export function defaultAuthDeps(): AuthDeps {
  const svc = core.getAuthServices();
  return { mgr: core.getAppManager(), apiKeys: svc.apiKeys, admin: svc.admin, login: coreLogin };
}

function unauthorized(error: string, message: string): Response {
  return jsonResponse({ error, message }, 401);
}

/** The 401 for a credential that did not verify, worded as each case always was. */
function refusal(rejected: { reason: CredentialRejection; instanceId?: string }): Response {
  switch (rejected.reason) {
    case 'gateway-identity-invalid':
      return unauthorized('gateway-identity-invalid', 'invalid gateway identity');
    case 'gateway-admin-session-invalid':
      return unauthorized('admin-session-invalid', 'admin session invalid or expired — unlock admin again');
    case 'api-key-invalid':
      return unauthorized('invalid-api-key', 'invalid or revoked API key');
    case 'admin-session-invalid':
      return unauthorized('admin-session-invalid', 'admin session invalid or expired — unlock admin again (aura admin login)');
    case 'unsupported-scheme':
      return errorResponse('unsupported Authorization header — send Authorization: Bearer $AURA_INSTANCE_TOKEN (or an API key / admin session), or no Authorization at all', 401);
    case 'instance-not-running':
      return errorResponse(`token belongs to ${rejected.instanceId}, which is not running`, 401);
    case 'credential-invalid':
    default:
      return errorResponse('invalid or expired credential (instance token, API key or admin session)', 401);
  }
}

/** The verifying resolver behind `authenticate()`. The middleware's access gate decides on it too. */
export function resolveCaller(request: Request, deps: AuthDeps = defaultAuthDeps()): Promise<ResolvedPrincipal> {
  return resolvePrincipal(request, {
    mgr: deps.mgr as unknown as PrincipalDeps['mgr'],
    apiKeys: deps.apiKeys,
    admin: deps.admin,
    login: deps.login ?? null,
    ownerServices: deps.ownerServices,
  });
}

export async function authenticate(request: Request, deps: AuthDeps = defaultAuthDeps()): Promise<Principal | Response> {
  const r = await resolveCaller(request, deps);
  if (r.rejected) return refusal(r.rejected);
  if (r.principal.kind !== 'anonymous') return r.principal;
  // A credential that could not be checked is never anonymous.
  if (r.via === 'unverified' && bearerToken(request) !== null) return refusal({ reason: 'credential-invalid' });
  return { kind: 'anonymous', verification: 'unverified' };
}

/**
 * The admin session a route's rule required (routeManifest `credentials`), as
 * the middleware's gate verified it (`locals.access`), for audit attribution.
 */
export function adminOf(locals: App.Locals | undefined): AdminPrincipal | null {
  const p = locals?.access?.principal;
  return p?.kind === 'admin' ? p as AdminPrincipal : null;
}

/** Append an admin change to the `audit:admin` stream (never throws). */
export async function auditAdmin(
  principal: AdminPrincipal | null,
  action: string,
  opts: { target?: string; outcome?: 'ok' | 'denied' | 'failed'; detail?: Record<string, unknown> } = {},
): Promise<void> {
  try {
    await core.getAuthServices().audit.record({
      by: principal ? core.adminAttribution(principal) : { kind: 'anonymous' },
      action, ...opts,
    });
  } catch (err) {
    console.warn(`[auth] audit write failed: ${(err as Error).message}`);
  }
}
