import * as core from '@aura/core';
import type { AccessPrincipal, AuditInput, UserPrincipal } from '@aura/core';
import { accessMode } from '../../../server/access-mode.mjs';
import { gatewayClaimOf } from '../../../server/gateway-identity.mjs';
import { afterResponse } from '../afterResponse.ts';
import { presentsApproval } from '../approvals/service.ts';
import { systemMode } from '../systemMode.ts';
import { decide as liveDecide } from './decide.ts';
import { readJsonBody, refused, TOO_LARGE } from './enforce.ts';
import { errorResponse } from '../appResponse.ts';
import { refusalBody, type RefusalView } from './refusalText.ts';
import { OWNER_UI_EXCLUDED_TARGETS, gatewayInstance, gatewayOwner, type GatewayOwnerDeps } from './identify.ts';
import { combineCandidates, concreteRule, kvNamespace, resourceFor, type ObserverManager } from './observer.ts';
import { candidateRules, handlersOf, manifestRoute, normalizeMethod, readsBody as routeReadsBody } from './resolve.ts';
import { ROUTE_ACCESS_MANIFEST } from './routeManifest.ts';
import type { AccessLabel, Decide, DecideResult, RequestSnapshot, RouteAccessManifest } from './types.ts';

/**
 * The enforcement of `/_aura/os/*`. The gateway proves who is calling; this
 * asks the route access manifest whether that app instance may make this call,
 * on the route Astro actually matched, so no second path list can drift from
 * it. A request whose body could select a stricter variant gets the strictest
 * candidate, unless the variant is marked `read`: then the body is parsed here
 * exactly as the route will parse it. An unclassified route is refused. This
 * runs in every access mode; `enforce` only stops core's auto-grants counting.
 *
 * A trusted system UI (D45, identify.ts `gatewayOwner`) is checked a second
 * time, as the owner acting through it, when its instance rules refuse a call.
 * Its mutations are audited once the route has answered, with that outcome
 * (lib/afterResponse.ts, run by the middleware).
 * `gatewayOwner` holds the one scope decision (the API groups and routes its
 * OWNER_UI_APPS entry lists), and here it never reaches a login session, a
 * shell screen or another app's upstream. Freshness and approvals on a rule
 * still apply to the owner.
 *
 * A refusal keeps the code `gateway-denied` and status 403 it always had,
 * and says why (refusalText.ts): the decided reason and what is missing, as
 * the calling app may know it. The app page reads it, so it is always worded
 * for an app, also when the owner acted through a trusted UI.
 */

export interface GatewayEnforceDeps {
  mgr: ObserverManager;
  decide: Decide;
  manifest?: RouteAccessManifest;
  /** App Host services for the D45 owner check; loaded when absent. */
  ownerServices?: GatewayOwnerDeps['services'];
  /** Where an owner action through a trusted UI is recorded. */
  audit?: (entry: AuditInput) => Promise<unknown>;
  /** The access mode (server/access-mode.mjs) when absent. */
  mode?: () => string;
}

const liveAudit = (entry: AuditInput): Promise<unknown> => core.getAuthServices().audit.record(entry);

export interface GatewayRequestContext {
  request: Request;
  url: URL;
  routePattern?: string;
  params?: Record<string, string | undefined>;
}

/** The gateway's refusal of a decision: code and status as before, the body says why. */
function gatewayRefusal(result: DecideResult, view: RefusalView): Response {
  const { body } = refusalBody(result, { ...view, gateway: true });
  return errorResponse(403, { ...body, error: 'gateway-denied' });
}

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
  // One class (error-messages review §4.4): never which part of the claim failed.
  if (!claim || !inst || inst === 'invalid') {
    return refused(401, 'gateway-identity-invalid', 'The App Host could not prove which app instance is calling.', {
      category: 'not-authenticated', hint: 'Open the app again from AuraOS.',
    });
  }

  const manifest = deps.manifest ?? ROUTE_ACCESS_MANIFEST;
  const route = manifestRoute(manifest, ctx.routePattern ?? '');
  const method = normalizeMethod(ctx.request.method);
  const view: RefusalView = { audience: 'app', callerAppId: inst.appId, method, ...scopeView(deps.mgr) };
  const unclassified = () => gatewayRefusal({ outcome: 'deny', reason: 'unclassified' }, { ...view, route: route.startsWith('/api/') ? route : undefined });
  if (!route.startsWith('/api/')) return unclassified();

  const snapshot: RequestSnapshot = {
    method: ctx.request.method,
    routePattern: route,
    pathname: ctx.url.pathname,
    search: ctx.url.search,
    params: { ...(ctx.params ?? {}) },
    https: ctx.url.protocol === 'https:',
    status: 0,
    internal: null,
    identity: { verified: null, referer: null, instanceId: inst.instanceId },
  };
  const info = { route, handlers: handlersOf(manifest, route) };
  const readsBody = routeReadsBody(manifest, info, method);
  const body = readsBody ? await readJsonBody(ctx.request) : undefined;
  if (body === TOO_LARGE) {
    return refused(413, 'gateway-body-too-large', 'The request body is larger than any request an access rule reads (1 MiB).', { category: 'invalid-request' });
  }
  const candidates = candidateRules(manifest, info, method, {
    query: new URLSearchParams(ctx.url.search),
    namespace: kvNamespace(snapshot),
    params: snapshot.params,
    ...(readsBody ? { body } : {}),
  });
  if (candidates.length === 0) return unclassified();

  const transport = snapshot.https ? 'https' as const : 'http' as const;
  const strict = (deps.mode ?? accessMode)() === 'enforce';
  const decideAs = (principal: AccessPrincipal) => Promise.all(candidates.map(async ({ variant, rule }) => {
    if (principal.kind !== 'instance' && OWNER_UI_EXCLUDED_TARGETS.has(rule.target)) {
      return { variant, result: { outcome: 'deny' as const, reason: 'wrong-principal' as const } };
    }
    const concrete = concreteRule(rule, snapshot, principal, deps.mgr);
    const result = await deps.decide({
      principal,
      action: {
        surface: 'api', subject: route as AccessLabel, method,
        variant: variant ? variant as AccessLabel : null, rule: concrete,
      },
      resource: resourceFor(concrete, snapshot, deps.mgr),
      transport,
      // A presented approval meets the fresh-auth precondition; the handler consumes it.
      auth: { fresh: presentsApproval(ctx.request), via: 'gateway' },
      strict,
      accessProfile: 'open',
      systemMode: systemMode(),
      deployment: 'private',
    });
    return { variant, result };
  }));
  const verdict = (results: Awaited<ReturnType<typeof decideAs>>) => combineCandidates(results).result;

  const instance: AccessPrincipal = {
    kind: 'instance', appId: inst.appId, instanceId: inst.instanceId, verification: 'verified',
  };
  const asInstance = verdict(await decideAs(instance));
  if (asInstance.outcome === 'allow') return null;
  // Every refusal below says the app's own: the owner path adds nothing an app page may learn.
  const denied = () => gatewayRefusal(asInstance, { ...view, route });

  // D45: the owner acting through a trusted system UI, on that UI's routes only.
  if (!claim.owner) return denied();
  const owner = await gatewayOwner(ctx.request, { mgr: deps.mgr as unknown as GatewayOwnerDeps['mgr'], services: deps.ownerServices });
  if (!owner) return denied();
  if (verdict(await decideAs(owner)).outcome !== 'allow') return denied();
  if (method !== 'GET' && method !== 'HEAD') {
    const audit = deps.audit ?? liveAudit;
    afterResponse(ctx.request, (status) => recordOwnerAction(audit, owner, route, method, status));
  }
  return null;
}

/** A system app's permissions ship with AuraOS: no grant hint for those. */
function scopeView(mgr: ObserverManager): Pick<RefusalView, 'scopeOf'> {
  const registry = mgr.registry;
  return registry?.getScopeId ? { scopeOf: (id: string) => registry.getScopeId!(id) } : {};
}

/** The audit outcome of a route's final status. */
const outcomeOf = (status: number): 'ok' | 'denied' | 'failed' =>
  status < 400 ? 'ok' : status === 401 || status === 403 ? 'denied' : 'failed';

/** Audit: who (the owner's session), through which app, and how the route answered. Never blocks the call. */
async function recordOwnerAction(
  audit: NonNullable<GatewayEnforceDeps['audit']>, owner: UserPrincipal, route: string, method: string, status: number,
): Promise<void> {
  try {
    await audit({
      by: core.userAttribution(owner),
      action: 'gateway.owner-ui',
      target: route,
      outcome: outcomeOf(status),
      detail: { method, status, through: owner.through?.appId, instance: owner.through?.instanceId },
    });
  } catch (err) {
    console.warn(`[gateway] audit write failed: ${(err as Error).message}`);
  }
}
