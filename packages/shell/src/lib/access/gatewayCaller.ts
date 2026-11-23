import * as core from '@aura/core';
import type { AccessPrincipal } from '@aura/core';
import { gatewayClaimOf } from '../../../server/gateway-identity.mjs';
import { decide as liveDecide } from './decide.ts';
import { gatewayInstance } from './identify.ts';
import { combineCandidates, concreteRule, kvNamespace, resourceFor, type ObserverManager } from './observer.ts';
import { candidateRules, handlersOf, normalizeMethod } from './resolve.ts';
import { ROUTE_ACCESS_MANIFEST } from './routeManifest.ts';
import type { AccessLabel, Decide, RequestSnapshot, RouteAccessManifest } from './types.ts';

/**
 * The enforcement of `/_aura/os/*`. The gateway proves who is calling; this
 * asks the route access manifest whether that app instance may make this call,
 * on the route Astro actually matched, so no second path list can drift from
 * it. A request whose body could select a stricter variant gets the strictest
 * candidate. An unclassified route is refused.
 */

export interface GatewayEnforceDeps {
  mgr: ObserverManager;
  decide: Decide;
  manifest?: RouteAccessManifest;
}

export interface GatewayRequestContext {
  request: Request;
  url: URL;
  routePattern?: string;
  params?: Record<string, string | undefined>;
}

const refused = (status: number, error: string): Response =>
  new Response(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

/** Null when the call may proceed, else the refusal. */
export async function enforceGateway(
  ctx: GatewayRequestContext,
  deps: GatewayEnforceDeps = {
    mgr: core.getAppManager() as unknown as ObserverManager,
    decide: liveDecide,
  },
): Promise<Response | null> {
  const claim = gatewayClaimOf(ctx.request);
  const inst = gatewayInstance(ctx.request, deps.mgr as unknown as Parameters<typeof gatewayInstance>[1]);
  if (!claim || !inst || inst === 'invalid') return refused(401, 'gateway-identity-invalid');

  const route = ctx.routePattern ?? '';
  if (!route.startsWith('/api/')) return refused(403, 'gateway-denied');

  const manifest = deps.manifest ?? ROUTE_ACCESS_MANIFEST;
  const method = normalizeMethod(ctx.request.method);
  const snapshot: RequestSnapshot = {
    method: ctx.request.method,
    routePattern: route,
    pathname: ctx.url.pathname,
    search: ctx.url.search,
    params: { ...(ctx.params ?? {}) },
    https: ctx.url.protocol === 'https:',
    status: 0,
    internal: null,
    identity: { authorization: null, sessionCookie: false, referer: null, instanceId: inst.instanceId },
  };
  const candidates = candidateRules(
    manifest,
    { route, handlers: handlersOf(manifest, route) },
    method,
    { query: new URLSearchParams(ctx.url.search), namespace: kvNamespace(snapshot) },
  );
  if (candidates.length === 0) return refused(403, 'gateway-denied');

  const principal: AccessPrincipal = {
    kind: 'instance', appId: inst.appId, instanceId: inst.instanceId, verification: 'verified',
  };
  const results = await Promise.all(candidates.map(async ({ variant, rule }) => {
    const concrete = concreteRule(rule, snapshot, principal, deps.mgr);
    const result = await deps.decide({
      principal,
      action: {
        surface: 'api', subject: route as AccessLabel, method,
        variant: variant ? variant as AccessLabel : null, rule: concrete,
      },
      resource: resourceFor(concrete, snapshot, deps.mgr),
      transport: snapshot.https ? 'https' : 'http',
      auth: { fresh: false },
      accessProfile: 'open',
      systemMode: 'normal',
      deployment: 'private',
    });
    return { variant, result };
  }));
  return combineCandidates(results).result.outcome === 'allow' ? null : refused(403, 'gateway-denied');
}
