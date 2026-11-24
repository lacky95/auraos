import type { AppInstance, AppManager, UserPrincipal } from '@aura/core';
import { loadAppHostServices, type AppHostServices } from '../../../server/app-host-auth.mjs';
import { gatewayClaimOf, ownerUiActs, ownerUiApp } from '../../../server/gateway-identity.mjs';
import { refererProxyId } from './legacyReferer.ts';

/**
 * Resolve the calling INSTANCE for a write to the Interface Registry.
 *
 * The existing `identifySource` helpers (kv, data-provider routes) resolve a
 * caller to an *appId*, which is not enough here: a registration belongs to one
 * running instance and dies with it, so an app id that maps to three instances
 * would be ambiguous about which one just opened a port.
 *
 * Two sources, in order:
 *
 *   1. `Referer` — a browser-context caller inside an app iframe, whose URL is
 *      always `/api/proxy/<instanceId>/…`. Same mechanism the KV and
 *      data-provider routes already trust.
 *   2. `X-Aura-Instance-Id` — a server-context caller (the app's own Astro
 *      route or a lifecycle hook), which has no Referer at all. The app reads
 *      the value from the `APP_INSTANCE_ID` the OS injected at spawn. This is
 *      the case that matters most in practice, because an MCP or WS server
 *      lives in the app's server code, not its page.
 *
 * Deliberately **no `'system'` fallback**. The KV route treats a missing
 * Referer as privileged; for writes that would let any unattributed caller
 * register interfaces, so an unidentifiable caller is simply refused.
 *
 * On the trust model, stated plainly because it is easy to overclaim:
 * **both sources are self-asserted.** Anything that can reach the shell API
 * can set a Referer or an X-Aura-Instance-Id and register under another app's
 * identity. That is not a hole this route opens — it is the OS's existing
 * app-identity model (`/api/kv` and `/api/data` trust the same Referer, and
 * the KV route additionally treats a *missing* Referer as privileged
 * `'system'`). Apps here are assumed cooperating, not adversarial.
 *
 * What this route does add is containment: the claimed instance must exist in
 * the live table, writes are refused outright when no instance can be named,
 * and every entry dies with its instance — at the next stop, or at the next
 * reconcile tick. So the blast radius of a forged registration is one
 * advertised address until that app next stops, never a persistent lie.
 *
 * Real instance identity now exists: every instance gets a per-instance
 * token at spawn (`AURA_INSTANCE_TOKEN`, core's InstanceTokens), and the
 * OS-sidecar routes require it (lib/instanceAuth.ts `requireInstanceToken`).
 * A valid token, like a gateway claim, names the instance before either
 * hint is read; the SDK's server side sends it. Requiring it here, and moving
 * /api/kv and /api/data onto it, is the remaining step: every caller (apps
 * outside the SDK too) has to send it first.
 */
export function identifyInstance(request: Request, mgr: AppManager): AppInstance | null {
  const gateway = gatewayInstance(request, mgr);
  if (gateway !== null) return gateway === 'invalid' ? null : gateway;

  // An instance token proves the caller, so it wins over the hints below. The
  // SDK sends it from an app's server instead of a self-set id header.
  const token = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get('authorization') ?? '')?.[1];
  const verified = token ? mgr.tokens.verify(token) : null;
  if (verified) return mgr.getInstance(verified.instanceId) ?? null;

  const idOrAppId = refererProxyId(request.headers.get('referer'));
  if (idOrAppId) {
    const inst = mgr.getInstance(idOrAppId)
      // A bare appId in the proxy path: pick the app's one real instance.
      // Pool members are excluded — the proxy won't route to them either.
      ?? mgr.getInstancesByApp(idOrAppId).find((i) => !i.inPool && i.port !== null);
    if (inst) return inst;
  }

  const claimed = request.headers.get('x-aura-instance-id');
  if (claimed) return mgr.getInstance(claimed) ?? null;

  return null;
}

/**
 * The instance a signed App Host gateway claim names (server/app-gateway.mjs).
 * Null when the request has no claim, `invalid` when it has one that doesn't
 * verify or whose instance is no longer that app. The only caller identity
 * here that is proved rather than asserted, and it never falls back.
 */
export function gatewayInstance(
  request: Request,
  mgr: Pick<AppManager, 'getInstance'>,
): AppInstance | 'invalid' | null {
  const claim = gatewayClaimOf(request);
  if (claim === null) return null;
  if (!claim || !claim.instanceId) return 'invalid';
  const inst = mgr.getInstance(claim.instanceId);
  return inst && inst.appId === claim.appId ? inst : 'invalid';
}

/** What `gatewayOwner` reads. Structural, so tests can fake it. */
export interface GatewayOwnerDeps {
  mgr: Pick<AppManager, 'getInstance' | 'getManifest'>;
  services?: () => Promise<Pick<AppHostServices, 'registry' | 'sessionLive'> | null>;
}

const owners = new WeakMap<Request, Promise<UserPrincipal | null>>();

/**
 * D45: the owner acting through a trusted system UI, or null. The gateway
 * signs an `owner` claim only for such a UI; this checks it again against the
 * live state, so a claim minted a moment before any of it changed buys nothing:
 *
 *   - a verified claim for a live instance of that app (gatewayInstance)
 *   - its installed copy is the `system` one, and the one scope decision
 *     (gateway-identity.mjs `ownerUiActs`) holds for the path called: an
 *     OWNER_UI_APPS entry that covers it, the claim's installation is that
 *     active `system` installation, and the owner's session is live
 *
 * The route manifest check (gatewayCaller.ts) and `authenticate()` (auth.ts)
 * both ask this, so no caller can skip the path scope.
 * The principal is the user, carrying the app it acts through. Cached per request.
 */
export function gatewayOwner(request: Request, deps: GatewayOwnerDeps): Promise<UserPrincipal | null> {
  let found = owners.get(request);
  if (!found) {
    found = resolveGatewayOwner(request, deps).catch(() => null);
    owners.set(request, found);
  }
  return found;
}

async function resolveGatewayOwner(request: Request, deps: GatewayOwnerDeps): Promise<UserPrincipal | null> {
  const claim = gatewayClaimOf(request);
  if (!claim || !claim.owner || claim.owner.userId !== claim.userId) return null;
  const inst = gatewayInstance(request, deps.mgr);
  if (!inst || inst === 'invalid' || !ownerUiApp(inst.appId)) return null;
  const installed = deps.mgr.getManifest(inst.appId) as { scopeId?: string } | undefined;
  if (installed?.scopeId !== 'system') return null;
  const svc = await (deps.services ?? loadAppHostServices)();
  if (!svc) return null;
  const path = new URL(request.url).pathname;
  if (!(await ownerUiActs({ appId: inst.appId, installationId: claim.installationId, sid: claim.owner.sid, path }, svc))) return null;
  return {
    kind: 'user', userId: claim.owner.userId, role: 'owner', sessionId: claim.owner.sid,
    verification: 'verified', through: { appId: inst.appId, instanceId: inst.instanceId },
  };
}
