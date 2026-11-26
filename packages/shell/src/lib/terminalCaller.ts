import type { APIContext } from 'astro';
import { actingInstance, bearerToken } from './access/identify.ts';
import { actingUser, liveInstanceOwner } from './access/decide.ts';
import { shellOwner } from './appHostHandoff.ts';
import { authenticate, resolveCaller, type AuthDeps } from './auth.ts';
import { isSystemTerminal } from '../../server/terminal-embed.mjs';

/** The app a Terminal rule holds to its grants. */
export interface AppCaller { appId: string; instanceId: string }

/**
 * Who called, for the Terminal routes and the intent target check (M3), from
 * the one resolver (identify.ts `resolvePrincipal`, through auth.ts
 * `resolveCaller`), never a second reading of the bearer:
 *
 *   invalid   a credential was presented and did not verify, or could not be
 *             checked: 401, never "no app identity"
 *   app       an app instance (its token, or the gateway), the owner acting
 *             through an app's page (D45, App Hosts), or an API key, which is
 *             held to the per-app grants like an app that has none (its id
 *             `api-key:<id>` is no app's); null for the owner's own login,
 *             the operator and an anonymous caller, which the manifest rule
 *             decided alone
 *   key       one caller, for per-caller limits (lib/terminalScreen.ts)
 */
export async function terminalCaller(
  request: Request, deps?: AuthDeps,
): Promise<'invalid' | { app: AppCaller | null; key: string }> {
  const r = await resolveCaller(request, deps);
  if (r.rejected || (r.via === 'unverified' && bearerToken(request) !== null)) return 'invalid';
  const p = r.principal;
  const acting = actingInstance(p);
  if (acting) return { app: { appId: acting.appId, instanceId: acting.instanceId }, key: `app:${acting.appId}` };
  if (p.kind === 'apiKey') {
    const appId = `api-key:${p.keyId}`;
    return { app: { appId, instanceId: appId }, key: appId };
  }
  if (p.kind === 'user') return { app: null, key: `user:${p.userId}` };
  return { app: null, key: p.kind };
}

/** The app a call is held to (see terminalCaller), or `invalid`. */
export async function verifiedAppCaller(request: Request): Promise<AppCaller | 'invalid' | null> {
  const c = await terminalCaller(request);
  return c === 'invalid' ? c : c.app;
}

/**
 * The app a Terminal route holds to its grants: a verified app other than the
 * System Terminal (which keeps full control). Null for a caller without an
 * app identity, which the manifest rule decides alone.
 */
export async function grantedAppCaller(request: Request): Promise<AppCaller | 'invalid' | null> {
  const caller = await verifiedAppCaller(request);
  if (caller && caller !== 'invalid' && await isSystemTerminal(caller.appId)) return null;
  return caller;
}

/**
 * Whether the owner made this call: the desktop's own page (exact Origin and
 * the owner's session, or login dark; appHostHandoff `shellOwner`), or the
 * host operator (its one-time ticket). A `user` principal alone is not
 * enough: a sibling App Host's page sends the login cookie too (same site)
 * and this types a line as the owner (D29). For the one Terminal action that
 * needs it (OPEN_TERMINAL `command`); never throws.
 */
export async function isOwnerCaller(ctx: Pick<APIContext, 'request' | 'cookies'> & { clientAddress?: string }): Promise<boolean> {
  try {
    const p = await authenticate(ctx.request);
    if (!(p instanceof Response) && p.kind === 'operator') return true;
  } catch { /* not the operator */ }
  try {
    return !('error' in await shellOwner(ctx));
  } catch {
    return false;
  }
}

/**
 * D69 (stream T): whether the caller of `request` acts for the user whose
 * session host `instanceId` is (decide.ts `actingUser`, the instance's
 * `owner`). A Terminal instance of another user, or of nobody yet (an
 * unclaimed pool member), is not the caller's: the routes answer as if it
 * were not running. Never throws.
 */
export async function callerOwnsTerminal(
  request: Request, instanceId: string | null,
  deps: { owner(instanceId: string): string | null } = { owner: liveInstanceOwner },
): Promise<boolean> {
  if (!instanceId) return false;
  try {
    const r = await resolveCaller(request);
    if (r.rejected) return false;
    const user = actingUser(r.principal);
    const owner = deps.owner(instanceId);
    return !!user && owner !== null && owner === user;
  } catch {
    return false;
  }
}
