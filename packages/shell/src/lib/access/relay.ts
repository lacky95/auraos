import type { AccessPrincipal } from '@aura/core';
import { DEFAULT_OWNER_ID } from '@aura/core';
import { OWNER_AGENT_APPS } from './identify.ts';

/**
 * D89 B4: the shell's relay claim on a call it forwards to an owner-agent
 * app's server (the Terminal, aurashelld). The claim (core
 * app-hosts/relayClaim.ts, signed by AppManager with the instance's per-start
 * key) proves to that server that the shell relayed the call, and names the
 * caller the shell authorized. Never a credential: no token, cookie or key.
 *
 * One answer for every relay: /api/proxy, the WS proxy and App Hosts (through
 * the access bridge `relayClaim`), and the shell's own calls (terminal-embed.mjs).
 */

export interface RelaySigner {
  relayClaim?(instanceId: string, call: { method: string; path: string; userId?: string; sid?: string; caller?: string }): string | null;
}

/** Who the shell authorized, in the claim's words. */
export function relayCaller(principal: AccessPrincipal | { kind: 'operator' } | null | undefined): { userId?: string; sid?: string; caller: string } {
  const p = principal as (AccessPrincipal & Record<string, unknown>) | null | undefined;
  switch (p?.kind) {
    case 'user': {
      const through = p['through'] as { appId?: string } | undefined;
      return {
        userId: p['userId'] as string,
        ...(typeof p['sessionId'] === 'string' && p['sessionId'] ? { sid: p['sessionId'] as string } : {}),
        caller: through?.appId ? `owner-through:${through.appId}` : 'user',
      };
    }
    case 'instance':
      return {
        ...(typeof p['userId'] === 'string' && p['userId'] ? { userId: p['userId'] as string } : {}),
        caller: `instance:${p['instanceId'] as string}`,
      };
    // The host operator acts for the owner (D29; D69: the claim names the user a session host serves).
    case 'operator': return { userId: DEFAULT_OWNER_ID, caller: 'operator' };
    case 'apiKey': return { caller: 'api-key' };
    default: return { caller: 'anonymous' };
  }
}

/**
 * The `x-aura-relay` value for one forwarded call, or null: only to an
 * OWNER_AGENT_APPS instance, and only when the instance's start has a key.
 * `path` is what the upstream receives (with its query). Never throws.
 */
export function relayClaimFor(
  mgr: RelaySigner | null | undefined,
  call: { appId: string | null | undefined; instanceId: string; method: string; path: string },
  who: { userId?: string; sid?: string; caller: string },
): string | null {
  if (!call.appId || !OWNER_AGENT_APPS.has(call.appId)) return null;
  try {
    return mgr?.relayClaim?.(call.instanceId, {
      method: call.method, path: call.path,
      ...(who.userId ? { userId: who.userId } : {}), ...(who.sid ? { sid: who.sid } : {}), caller: who.caller,
    }) ?? null;
  } catch {
    return null;
  }
}

/** How the shell's plain `.mjs` servers (WS proxy, App Hosts, terminal-embed) reach `relayClaimFor` (server/access-bridge.mjs `relayClaimOf`). */
export const RELAY_SIGNER_KEY = Symbol.for('aura.relay.sign');

export interface RelayRequest {
  appId: string | null | undefined;
  instanceId: string;
  method: string;
  path: string;
  /** The verified caller (the access resolver's principal). */
  principal?: AccessPrincipal | null;
  /** Or an App Host session the router verified: the user it signs in. */
  session?: { userId?: string; sid?: string } | null;
  /** Or the shell itself (a call it makes on its own behalf). */
  system?: boolean;
}

/**
 * Register the signer for the `.mjs` servers, over the live AppManager. In
 * every access mode (unlike the access bridge, which `off` leaves out): the
 * claim is not part of the report. Idempotent; a rebuilt shell replaces it.
 */
export function installRelaySigner(mgr: () => RelaySigner | null): void {
  (globalThis as Record<symbol, unknown>)[RELAY_SIGNER_KEY] = (req: RelayRequest): string | null => {
    let who: { userId?: string; sid?: string; caller: string };
    if (req.system) who = { caller: 'system' };
    else if (req.session?.userId) who = { userId: req.session.userId, ...(req.session.sid ? { sid: req.session.sid } : {}), caller: 'user' };
    else who = relayCaller(req.principal);
    let m: RelaySigner | null = null;
    try { m = mgr(); } catch { m = null; }
    return relayClaimFor(m, req, who);
  };
}
