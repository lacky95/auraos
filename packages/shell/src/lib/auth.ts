// Namespace import: the running shell may cache a core build without the
// auth exports; a named import would 500 every route until restart.
import * as core from '@aura/core';
import type { AdminPrincipal, ApiKeyPrincipal, Principal } from '@aura/core';
import { jsonResponse } from './appResponse.js';
import { authenticateCaller, type CallerAuthManager } from './notificationCaller.js';

/**
 * Central request authentication for the shell API (identity only — what a
 * principal may DO is core auth's `Authorizer`).
 *
 *   Authorization: Bearer aura1.…        → instance (verified AURA_INSTANCE_TOKEN)
 *   Authorization: Bearer aura_k1_…      → apiKey   (admin-issued key, verified)
 *   Authorization: Bearer aura-admin1.…  → admin    (session from the shared credential)
 *   any other / invalid / expired credential → 401 — NEVER downgraded to anonymous
 *   no Authorization                     → anonymous (Referer / X-Aura-Instance-Id = hints only)
 *
 * `SYSTEM_PRINCIPAL` is unreachable from HTTP by construction.
 *
 * Admin credentials are headers, never cookies: the shell proxy forwards
 * request headers to app upstreams, so a cookie would leak to every app.
 */

const API_KEY_PREFIX = 'aura_k1_';
const ADMIN_SESSION_PREFIX = 'aura-admin1.';

export interface AuthDeps {
  mgr: CallerAuthManager;
  apiKeys: { verify(key: string): Promise<{ id: string; name: string; scopes: string[] } | null> };
  admin: { verifySession(token: string): Promise<{ sessionId: string; expiresAt: number } | null> };
}

export function defaultAuthDeps(): AuthDeps {
  const svc = core.getAuthServices();
  return { mgr: core.getAppManager(), apiKeys: svc.apiKeys, admin: svc.admin };
}

function bearer(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (header === null || header.trim() === '') return null;
  return /^Bearer\s+(\S+)\s*$/i.exec(header)?.[1] ?? '';
}

function unauthorized(error: string, message: string): Response {
  return jsonResponse({ error, message }, 401);
}

export async function authenticate(request: Request, deps: AuthDeps = defaultAuthDeps()): Promise<Principal | Response> {
  const token = bearer(request);
  if (token && token.startsWith(API_KEY_PREFIX)) {
    const rec = await deps.apiKeys.verify(token);
    if (!rec) return unauthorized('invalid-api-key', 'invalid or revoked API key');
    const p: ApiKeyPrincipal = { kind: 'apiKey', keyId: rec.id, name: rec.name, scopes: [...rec.scopes], verification: 'verified' };
    return p;
  }
  if (token && token.startsWith(ADMIN_SESSION_PREFIX)) {
    const s = await deps.admin.verifySession(token);
    if (!s) return unauthorized('admin-session-invalid', 'admin session invalid or expired — unlock admin again (aura admin login)');
    const p: AdminPrincipal = { kind: 'admin', credential: 'shared', sessionId: s.sessionId, verification: 'verified' };
    return p;
  }
  // Instance tokens, unsupported schemes (→ 401), hints, anonymous.
  return authenticateCaller(request, deps.mgr) as Principal | Response;
}

/**
 * Route guard: the request must carry a valid admin session. Anything else
 * (no credential, another principal, an invalid or expired session) → 401
 * `{error:'admin-required'}` — the CLI uses that code to offer a login.
 */
export async function requireAdmin(request: Request, deps?: AuthDeps): Promise<AdminPrincipal | Response> {
  const token = bearer(request);
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
