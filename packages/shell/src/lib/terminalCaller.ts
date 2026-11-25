import type * as core from '@aura/core';
import type { APIContext } from 'astro';
import { gatewayInstance } from './access/identify.ts';
import { shellOwner } from './appHostHandoff.ts';
import { authenticate } from './auth.ts';
import { isSystemTerminal } from '../../server/terminal-embed.mjs';

/**
 * The app making a call, when that is proved: an App Host gateway claim, or
 * the instance token the OS injects into every app container
 * (`Authorization: Bearer $AURA_INSTANCE_TOKEN`, the SDK's server side).
 * `invalid` = a claim that doesn't verify. Null = no app identity (the owner's
 * desktop, the CLI, an unverified machine call), which these Terminal rules
 * leave to Phase 3 (see server/terminal-embed.mjs).
 */
export function verifiedAppCaller(
  request: Request,
  mgr: Pick<ReturnType<typeof core.getAppManager>, 'getInstance' | 'tokens'>,
): { appId: string; instanceId: string } | 'invalid' | null {
  const gw = gatewayInstance(request, mgr);
  if (gw === 'invalid') return 'invalid';
  if (gw) return { appId: gw.appId, instanceId: gw.instanceId };
  const token = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
  if (!token) return null;
  const claims = mgr.tokens.verify(token);
  if (!claims) return null;
  const inst = mgr.getInstance(claims.instanceId);
  return inst ? { appId: inst.appId, instanceId: inst.instanceId } : 'invalid';
}

/**
 * The app a Terminal route holds to its grants: a verified app other than the
 * System Terminal (which keeps full control). Null for a caller without an
 * app identity, which the manifest rule decides alone.
 */
export async function grantedAppCaller(
  request: Request,
  mgr: Pick<ReturnType<typeof core.getAppManager>, 'getInstance' | 'tokens'>,
): Promise<{ appId: string; instanceId: string } | 'invalid' | null> {
  const caller = verifiedAppCaller(request, mgr);
  if (caller && caller !== 'invalid' && await isSystemTerminal(caller.appId)) return null;
  return caller;
}

/**
 * Whether the owner made this call: the desktop's own page (exact Origin and
 * the owner's session, or login dark; appHostHandoff `shellOwner`) or an
 * admin session (`aura admin login`). For the one Terminal action that needs
 * it (OPEN_TERMINAL `command`); never throws.
 */
export async function isOwnerCaller(ctx: Pick<APIContext, 'request' | 'cookies'> & { clientAddress?: string }): Promise<boolean> {
  try {
    const p = await authenticate(ctx.request);
    // A `user` principal (the owner's login, or the owner through a trusted
    // system UI) is not enough on its own: `shellOwner` below also wants the
    // desktop's exact Origin, since a sibling App Host's page sends the login
    // cookie too (same site) and this types a line as the owner (D29).
    if (!(p instanceof Response) && p.kind === 'admin') return true;
  } catch { /* not an admin session */ }
  try {
    return !('error' in await shellOwner(ctx));
  } catch {
    return false;
  }
}
