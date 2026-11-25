// Namespace import: the running shell may cache a core build without the
// auth exports; a named import would 500 every route until restart.
import * as core from '@aura/core';
import type { AdminPrincipal, Principal, UserPrincipal } from '@aura/core';
import { errorResponse, jsonResponse } from './appResponse.js';
import {
  bearerToken, resolvePrincipal, type CredentialRejection, type GatewayOwnerDeps, type PrincipalDeps,
} from './access/identify.js';
import { coreAuthServices, ownerSessionOf, sessionCookieToken } from './authSurface.js';
import { anonymousCaller, type CallerAuthManager } from './notificationCaller.js';

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
 * Phase 3 Stage 0 is report-only: the routes that act on a principal call
 * `authenticateLegacy`, which answers as before for the new `user` cases.
 *
 * `SYSTEM_PRINCIPAL` is unreachable from HTTP by construction.
 *
 * Admin credentials are headers, never cookies: the shell proxy forwards
 * request headers to app upstreams, so a cookie would leak to every app.
 */

const ADMIN_SESSION_PREFIX = 'aura-admin1.';

export interface AuthDeps {
  mgr: CallerAuthManager;
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

export async function authenticate(request: Request, deps: AuthDeps = defaultAuthDeps()): Promise<Principal | Response> {
  const r = await resolvePrincipal(request, {
    mgr: deps.mgr as unknown as PrincipalDeps['mgr'],
    apiKeys: deps.apiKeys,
    admin: deps.admin,
    login: deps.login ?? null,
    ownerServices: deps.ownerServices,
  });
  if (r.rejected) return refusal(r.rejected);
  if (r.principal.kind !== 'anonymous') return r.principal;
  // A credential that could not be checked is never anonymous.
  if (r.via === 'unverified' && bearerToken(request) !== null) return refusal({ reason: 'credential-invalid' });
  return anonymousCaller(request, deps.mgr);
}

/** What `authenticate()` returned before Phase 3 Stage 0: never a `user`. */
export type LegacyPrincipal = Exclude<Principal, UserPrincipal>;

/**
 * PHASE3-ENFORCE: `authenticate()` as it answered before Stage 0, for the
 * routes that act on the principal today (notifications, whoami). Stage 0
 * resolves the owner's login and the user an instance acts for, and only
 * reports them, so these routes keep their outcomes. Stage 2 (A. Enforcement)
 * gives them the user rules and removes this:
 *   - a login cookie → anonymous with hints (a shell screen then reads
 *     notifications through its client session, as before)
 *   - an `aura-sess1.` bearer → 401, as before
 *   - the owner through a trusted system UI (D45), without its admin bearer
 *     → that UI's instance, as before
 *   - an instance acting for a user → the instance, without `userId`
 */
export async function authenticateLegacy(request: Request, deps: AuthDeps = defaultAuthDeps()): Promise<LegacyPrincipal | Response> {
  const p = await authenticate(request, deps);
  if (p instanceof Response) return p;
  if (p.kind === 'instance') {
    const { userId: _user, systemId: _system, ...instance } = p;
    return instance;
  }
  if (p.kind !== 'user') return p;
  if (p.through?.instanceId) {
    return { kind: 'instance', appId: p.through.appId, instanceId: p.through.instanceId, verification: 'verified' };
  }
  if (bearerToken(request) !== null) return refusal({ reason: 'credential-invalid' });
  return anonymousCaller(request, deps.mgr);
}

/**
 * Route guard: the request must carry a valid admin session. Anything else
 * (no credential, another principal, an invalid or expired session) → 401
 * `{error:'admin-required'}` — the CLI uses that code to offer a login.
 */
export async function requireAdmin(request: Request, deps?: AuthDeps): Promise<AdminPrincipal | Response> {
  const token = bearerToken(request);
  if (!token || !token.startsWith(ADMIN_SESSION_PREFIX)) {
    return unauthorized('admin-required',
      'admin session required — run `aura admin login` (CLI) or use "Unlock admin" in Settings → Notifications & access, then send Authorization: Bearer <session>');
  }
  const p = await authenticate(request, deps ?? defaultAuthDeps());
  if (p instanceof Response) {
    return unauthorized('admin-required', 'admin session invalid or expired — unlock admin again (`aura admin login`)');
  }
  if (p.kind !== 'admin') return unauthorized('admin-required', 'admin session required');
  return p;
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
