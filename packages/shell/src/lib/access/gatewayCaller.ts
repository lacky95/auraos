import * as core from '@aura/core';
import type { AccessPrincipal } from '@aura/core';
import { gatewayClaimOf } from '../../../server/gateway-identity.mjs';
import { decide as liveDecide } from './decide.ts';
import { gatewayInstance } from './identify.ts';
import { combineCandidates, concreteRule, kvNamespace, resourceFor, type ObserverManager } from './observer.ts';
import { candidateRules, handlersOf, normalizeMethod, variantApplies } from './resolve.ts';
import { ROUTE_ACCESS_MANIFEST } from './routeManifest.ts';
import type { AccessLabel, Decide, RequestSnapshot, RouteAccessManifest } from './types.ts';

/**
 * The enforcement of `/_aura/os/*`. The gateway proves who is calling; this
 * asks the route access manifest whether that app instance may make this call,
 * on the route Astro actually matched, so no second path list can drift from
 * it. A request whose body could select a stricter variant gets the strictest
 * candidate, unless the variant is marked `readAtGateway`: then the body is
 * parsed here exactly as the route will parse it. An unclassified route is
 * refused.
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

/** Above any real intent. The route itself reads the body without a limit. */
const MAX_GATEWAY_BODY_BYTES = 1024 * 1024;
const TOO_LARGE = Symbol('too-large');

/** The JSON body from a clone (null if it isn't JSON), or `too-large`. */
async function readJsonBody(request: Request): Promise<unknown> {
  const reader = request.clone().body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_GATEWAY_BODY_BYTES) {
      // Not awaited: cancelling one branch of a clone settles only once the other is cancelled too.
      void reader.cancel().catch(() => undefined);
      return TOO_LARGE;
    }
    chunks.push(value);
  }
  try { return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))); } catch { return null; }
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
  const info = { route, handlers: handlersOf(manifest, route) };
  const readsBody = manifest.routes[route]?.variants?.some((v) =>
    v.match.on === 'body' && v.match.readAtGateway && variantApplies(v.methods, method, info));
  const body = readsBody ? await readJsonBody(ctx.request) : undefined;
  if (body === TOO_LARGE) return refused(413, 'gateway-body-too-large');
  const candidates = candidateRules(manifest, info, method, {
    query: new URLSearchParams(ctx.url.search),
    namespace: kvNamespace(snapshot),
    ...(readsBody ? { body } : {}),
  });
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
