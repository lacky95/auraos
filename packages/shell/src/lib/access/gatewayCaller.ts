import * as core from '@aura/core';
import type { AccessPrincipal, AdminPrincipal, AuditInput, UserPrincipal } from '@aura/core';
import { accessMode } from '../../../server/access-mode.mjs';
import { gatewayClaimOf } from '../../../server/gateway-identity.mjs';
import { afterResponse } from '../afterResponse.ts';
import { decide as liveDecide } from './decide.ts';
import { readJsonBody, refused, TOO_LARGE } from './enforce.ts';
import { gatewayInstance, gatewayOwner, type GatewayOwnerDeps } from './identify.ts';
import { combineCandidates, concreteRule, kvNamespace, resourceFor, type ObserverManager } from './observer.ts';
import { candidateRules, handlersOf, normalizeMethod, readsBody as routeReadsBody } from './resolve.ts';
import { ROUTE_ACCESS_MANIFEST } from './routeManifest.ts';
import type { AccessLabel, AccessTarget, AccessVia, Decide, RequestSnapshot, RouteAccessManifest } from './types.ts';

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
 */

export interface GatewayEnforceDeps {
  mgr: ObserverManager;
  decide: Decide;
  manifest?: RouteAccessManifest;
  /** App Host services for the D45 owner check; loaded when absent. */
  ownerServices?: GatewayOwnerDeps['services'];
  /** Where an owner action through a trusted UI is recorded. */
  audit?: (entry: AuditInput) => Promise<unknown>;
  /** Admin sessions, for a trusted UI's admin bearer; core's when absent. */
  adminSessions?: { verifySession(token: string): Promise<{ sessionId: string } | null> };
  /** The access mode (server/access-mode.mjs) when absent. */
  mode?: () => string;
}

const ADMIN_BEARER = /^Bearer\s+(aura-admin1\.\S+)\s*$/i;

/** The admin session a trusted UI's request carries, verified; else null. */
async function gatewayAdmin(request: Request, deps: GatewayEnforceDeps): Promise<AdminPrincipal | null> {
  const token = ADMIN_BEARER.exec(request.headers.get('authorization') ?? '')?.[1];
  if (!token) return null;
  try {
    const s = await (deps.adminSessions ?? core.getAuthServices().admin).verifySession(token);
    return s ? { kind: 'admin', credential: 'shared', sessionId: s.sessionId, verification: 'verified' } : null;
  } catch {
    return null;
  }
}

/**
 * Targets the owner never reaches through an app, whatever the rule says: its
 * login session and handoff, a shell screen's client session, and another
 * app's upstream (which includes the Terminal, D23, D29).
 */
const OWNER_UI_EXCLUDED_TARGETS: ReadonlySet<AccessTarget> = new Set(['session', 'client-session', 'proxy-upstream']);

const liveAudit = (entry: AuditInput): Promise<unknown> => core.getAuthServices().audit.record(entry);

export interface GatewayRequestContext {
  request: Request;
  url: URL;
  routePattern?: string;
  params?: Record<string, string | undefined>;
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
    identity: { verified: null, referer: null, instanceId: inst.instanceId },
  };
  const info = { route, handlers: handlersOf(manifest, route) };
  const readsBody = routeReadsBody(manifest, info, method);
  const body = readsBody ? await readJsonBody(ctx.request) : undefined;
  if (body === TOO_LARGE) return refused(413, 'gateway-body-too-large');
  const candidates = candidateRules(manifest, info, method, {
    query: new URLSearchParams(ctx.url.search),
    namespace: kvNamespace(snapshot),
    ...(readsBody ? { body } : {}),
  });
  if (candidates.length === 0) return refused(403, 'gateway-denied');

  const transport = snapshot.https ? 'https' as const : 'http' as const;
  const strict = (deps.mode ?? accessMode)() === 'enforce';
  const decideAs = (principal: AccessPrincipal, via: AccessVia = 'gateway') => Promise.all(candidates.map(async ({ variant, rule }) => {
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
      auth: { fresh: false, via },
      strict,
      accessProfile: 'open',
      systemMode: 'normal',
      deployment: 'private',
    });
    return { variant, result };
  }));
  const allowed = (results: Awaited<ReturnType<typeof decideAs>>) => combineCandidates(results).result.outcome === 'allow';

  const instance: AccessPrincipal = {
    kind: 'instance', appId: inst.appId, instanceId: inst.instanceId, verification: 'verified',
  };
  if (allowed(await decideAs(instance))) return null;

  // D45: the owner acting through a trusted system UI, on that UI's routes only.
  if (!claim.owner) return refused(403, 'gateway-denied');
  const owner = await gatewayOwner(ctx.request, { mgr: deps.mgr as unknown as GatewayOwnerDeps['mgr'], services: deps.ownerServices });
  if (!owner) return refused(403, 'gateway-denied');
  // With the admin session the shell's own unlock dialog handed it (the
  // gateway forwards that bearer for a trusted UI alone), it is that session.
  const admin = await gatewayAdmin(ctx.request, deps);
  if (!allowed(await (admin ? decideAs(admin, 'admin-session') : decideAs(owner)))) return refused(403, 'gateway-denied');
  if (method !== 'GET' && method !== 'HEAD') {
    const audit = deps.audit ?? liveAudit;
    afterResponse(ctx.request, (status) => recordOwnerAction(audit, owner, route, method, status));
  }
  return null;
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
