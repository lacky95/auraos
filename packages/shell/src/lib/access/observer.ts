import { createHash, timingSafeEqual } from 'node:crypto';
import * as core from '@aura/core';
import type { AccessPrincipal, AppManager, InstancePrincipal } from '@aura/core';
import { GATEWAY_IDENTITY_HEADER } from '@aura/core/host-rules';
import { defaultRedis } from '@aura/kv-store';
import { accessMode, wouldEnforce } from '../../../server/access-mode.mjs';
import { userSessionOf, sessionCookieToken } from '../authSurface.ts';
import { createDecide, freshAuthRequiresHttps, liveInstallationOf, liveInstanceOwner, type DecideDeps } from './decide.ts';
import {
  isTrustedOwnerAgent, normalizePeer, resolvePrincipal, type AppHostSession, type PrincipalDeps,
} from './identify.ts';
import { refererProxyId } from './legacyReferer.ts';
import { followSocket } from '../streamSession.ts';
import { systemMode } from '../systemMode.ts';
import { AccessReport, type ReportRedis } from './report.ts';
import { candidateRules, handlersOf, manifestRoute, normalizeMethod } from './resolve.ts';
import { ROUTE_ACCESS_MANIFEST } from './routeManifest.ts';
import { SURFACE_MANIFEST } from './surfaceManifest.ts';
import {
  ACCESS_BRIDGE_KEY, CONTRACT_SIGNALS, CREDENTIAL_COUNT_KINDS, CREDENTIAL_SURFACES, UNRESOLVED_VARIANT,
} from './types.ts';
import type {
  AccessBridge, AccessBridgeHost, AccessEvent, AccessEventMethod, AccessEventSurface, AccessLabel,
  AccessRule, AccessStatusClass, AccessSurface, AccessVia, Decide, DecideResult, PolicyResource,
  RequestSnapshot, RouteAccessManifest, SurfaceDecision, SurfaceFacts, SurfaceIdentity, SurfaceObservation,
  VerifiedIdentity,
} from './types.ts';
import { ACCESS_VIAS } from './types.ts';

/**
 * The report-only observer: identity observed without touching anything, one
 * decision per request or surface event, counted in `AccessReport`. Nothing
 * here can reach a response, and every entry point swallows its own errors.
 */

/**
 * Calls that may carry the internal label (server/access-bridge.mjs): the WS
 * proxy's and the App Host router's own loopback lookups. The label is a
 * per-boot secret that never leaves the shell process, so these calls are
 * the shell itself: `system` in the report, and let through by the gate.
 */
export const INTERNAL_CALLS: ReadonlyArray<{ method: string; route: string; path?: string }> = [
  { method: 'GET', route: '/api/apps' },
  { method: 'POST', route: '/api/apps/[id]/start' },
];

const INTERNAL_SECRET = Symbol.for('aura.access.internal');
const EARLY_EVENTS = Symbol.for('aura.access.early');
const AUTH_SERVICES = '__auraAuthServices';

const ANONYMOUS: AccessPrincipal = { kind: 'anonymous', verification: 'unverified' };
const label = (s: string) => s as AccessLabel;
const closed = <T extends string>(list: readonly T[], v: unknown): v is T => list.includes(v as T);

export function statusClass(status: number): AccessStatusClass {
  return status >= 100 && status < 600 ? `${Math.floor(status / 100)}xx` as AccessStatusClass : 'none';
}

/** The live objects the observer reads. Each may be missing while booting. */
export interface ObserverDeps extends DecideDeps {
  mgr(): ObserverManager | null;
  services(): ObserverServices | null;
  redisReady(): boolean;
  internalSecret(): string | null;
}

export interface ObserverManager {
  getAllInstances?(): ReadonlyArray<{ appId: string; instanceId: string; sandbox?: string; state?: string; inPool?: boolean }>;
  tokens: {
    hasNonce(instanceId: string, sidecar?: string): boolean;
    verify(token: string): { instanceId: string; sidecar?: string; userId?: string } | null;
  };
  getInstance(id: string): { appId: string; instanceId: string; owner?: string } | undefined;
  getInstancesByApp(appId: string): ReadonlyArray<{ appId: string; instanceId: string }>;
  getActivity?(id: string): { appId?: string; parentInstanceId?: string; instanceId?: string } | undefined;
  getManifest?(id: string): unknown;
  /** AppManager `isTrustedSystemCopy`: the active copy is the system installation. */
  isTrustedSystemCopy?(appId: string): boolean;
  /** AppManager `getInstanceAddresses`: the sandbox's addresses on every network (D28; B7 binding signal). */
  getInstanceAddresses?(instanceId: string): string[];
  registry?: { getById(id: string): unknown; getScopeId?(id: string): string | undefined };
  providers?: {
    resolveProvider(authority: string, path: string): {
      appId: string;
      instance: { instanceId: string };
      entry: { readPermission?: string; writePermission?: string };
    } | null;
  };
}

export interface ObserverServices {
  apiKeys?: { peek?(key: string): Promise<{ id: string; name: string; scopes: string[] } | null> };
  loginSessions?: Parameters<typeof userSessionOf>[1]['loginSessions'];
  users?: Parameters<typeof userSessionOf>[1]['users'];
  setupTickets?: { peek?(code: string, purpose: 'operator'): Promise<{ subject?: string } | null> };
}

interface Observed {
  principal: AccessPrincipal;
  via: AccessVia;
  hintAppId: string | null;
  /** The resolver ran and failed (a store that could not be read): counted as an error. */
  failed?: true;
}

// ── identity, without side effects ──────────────────────────────────────────

/**
 * The resolver's inputs as the report reads them: API keys and operator
 * tickets are peeked (no last-used write, nothing used up), and nothing that
 * needs Valkey is looked up while it is down.
 */
export function observerPrincipalDeps(deps: ObserverDeps): PrincipalDeps {
  const svc = deps.services();
  const ready = deps.redisReady();
  const peekKey = svc?.apiKeys?.peek;
  const loginSessions = svc?.loginSessions;
  const users = svc?.users;
  const peekTicket = svc?.setupTickets?.peek;
  return {
    mgr: deps.mgr() as unknown as PrincipalDeps['mgr'],
    apiKeys: peekKey && ready ? { verify: (key) => peekKey.call(svc!.apiKeys, key) } : null,
    login: loginSessions && users && ready ? {
      cookieToken: sessionCookieToken,
      userSession: async (token) => {
        const found = await userSessionOf(token, { loginSessions, users });
        return found ? { sessionId: found.session.sessionId, userId: found.user.id, role: found.user.role } : null;
      },
    } : null,
    // Peek only: the gate or the route uses the ticket up (identify.ts `resolveOperator`).
    operatorTickets: peekTicket ? { peek: (code, purpose) => peekTicket.call(svc!.setupTickets, code, purpose) } : null,
  };
}

/** The verified identity of a request, for its snapshot. Never throws; null when it can't tell. */
export async function identifyRequest(
  request: Request, deps: ObserverDeps, appHost: AppHostSession | null = null,
): Promise<VerifiedIdentity | null> {
  try {
    const { principal, via } = await resolvePrincipal(request, observerPrincipalDeps(deps), { appHost });
    return { principal, via };
  } catch {
    return null;
  }
}

const first = (v: unknown): string | undefined => {
  const x = Array.isArray(v) ? v[0] : v;
  return typeof x === 'string' ? x : undefined;
};

const WEB_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
/** The only headers the resolver reads. */
const IDENTITY_HEADERS = ['authorization', 'cookie', GATEWAY_IDENTITY_HEADER, 'referer', 'x-aura-instance-id'];

/** What a `.mjs` server hands over, as a web Request with the identity headers only. All of it is checked. */
export function requestFromFacts(facts: SurfaceFacts): Request | null {
  try {
    const given = (facts?.headers ?? {}) as Record<string, unknown>;
    const headers = new Headers();
    for (const name of IDENTITY_HEADERS) {
      const v = first(given[name]);
      if (v !== undefined) headers.set(name, v);
    }
    const method = typeof facts.method === 'string' && WEB_METHODS.has(facts.method.toUpperCase()) ? facts.method.toUpperCase() : 'GET';
    const url = typeof facts.url === 'string' && facts.url.startsWith('/') ? facts.url : '/';
    return new Request(new URL(url, 'http://shell'), { method, headers });
  } catch {
    return null;
  }
}

/** An App Host session as app-hosts.mjs verified it, or null when it has another shape. */
function appHostOf(v: unknown): AppHostSession | null {
  const o = v as Partial<AppHostSession> | null;
  if (!o || typeof o !== 'object') return null;
  const str = (x: unknown) => typeof x === 'string' && x.length > 0;
  if (!str(o.appId) || !str(o.userId) || !str(o.sid) || (o.instanceId !== undefined && !str(o.instanceId))) return null;
  // The record's role, as the live check read it (C2); anything else is no role, i.e. a member.
  const role = o.role === 'owner' || o.role === 'member' ? { role: o.role } : {};
  return { appId: o.appId!, userId: o.userId!, sid: o.sid!, ...(o.instanceId ? { instanceId: o.instanceId } : {}), ...role };
}

function isVerified(v: unknown): v is VerifiedIdentity {
  const o = v as VerifiedIdentity | null;
  return !!o && typeof o === 'object' && typeof o.principal?.kind === 'string' && closed(ACCESS_VIAS, o.via);
}

function hintApp(identity: SurfaceIdentity, mgr: ObserverManager | null): { appId: string | null; via: AccessVia | null } {
  if (!mgr) return { appId: null, via: null };
  const proxied = refererProxyId(identity.referer);
  if (proxied) {
    const inst = mgr.getInstance(proxied) ?? mgr.getInstancesByApp(proxied)[0];
    return { appId: inst?.appId ?? proxied, via: 'referer-hint' };
  }
  if (identity.instanceId) {
    const inst = mgr.getInstance(identity.instanceId);
    if (inst) return { appId: inst.appId, via: 'instance-id-hint' };
  }
  return { appId: null, via: null };
}

/** The snapshot's verified identity; an anonymous caller also gets its hint, for the app column. */
export async function observeIdentity(identity: SurfaceIdentity | null, deps: ObserverDeps): Promise<Observed> {
  if (!identity) return { principal: ANONYMOUS, via: 'none', hintAppId: null };
  let verified: unknown = null;
  try { verified = await identity.verified; } catch { /* unverified below */ }
  const v: VerifiedIdentity = isVerified(verified) ? verified : { principal: ANONYMOUS, via: 'unverified' };
  if (v.principal.kind !== 'anonymous') return { principal: v.principal, via: v.via, hintAppId: null };
  const hint = hintApp(identity, deps.mgr());
  return {
    principal: ANONYMOUS, via: v.via === 'none' ? hint.via ?? 'none' : v.via, hintAppId: hint.appId,
    // Started, and came back empty: the resolver failed.
    ...(identity.verified !== null && !isVerified(verified) ? { failed: true as const } : {}),
  };
}

/** The app a principal speaks for: an instance's own, or the app a user acts through. */
function principalApp(p: AccessPrincipal): string | null {
  if (p.kind === 'instance') return p.appId;
  if (p.kind === 'user') return p.through?.appId ?? null;
  return null;
}

// ── resources and placeholders ──────────────────────────────────────────────

const kvSegments = (s: RequestSnapshot) => (s.params['path'] ?? '').split('/').filter(Boolean);

export function kvNamespace(s: RequestSnapshot): 'os' | 'app' | null {
  if (s.routePattern !== '/api/kv/[...path]') return null;
  const first = kvSegments(s)[0];
  return first === 'os' || first === 'app' ? first : null;
}

function provider(s: RequestSnapshot, mgr: ObserverManager | null) {
  const authority = s.params['authority'];
  if (!authority || !mgr?.providers) return null;
  try { return mgr.providers.resolveProvider(authority, `/api/data/${s.params['path'] ?? ''}`); } catch { return null; }
}

export function resourceFor(rule: AccessRule, s: RequestSnapshot, mgr: ObserverManager | null): PolicyResource {
  const r: PolicyResource = { target: rule.target };
  if (rule.systemApp) {
    // The built-in app: its active system copy, never a same-id copy.
    if (mgr?.isTrustedSystemCopy?.(rule.systemApp)) r.appId = rule.systemApp;
    return r;
  }
  const { instanceId, activityId, id, name } = s.params;
  if (instanceId) {
    r.instanceId = instanceId;
    const appId = mgr?.getInstance(instanceId)?.appId;
    if (appId) r.appId = appId;
  }
  if (name && rule.target === 'sidecar') r.sidecar = name;
  if (activityId) {
    let decoded = activityId;
    try { decoded = decodeURIComponent(activityId); } catch { /* keep as written */ }
    const a = mgr?.getActivity?.(decoded);
    // An AppActivity names its instance `parentInstanceId`.
    const owner = a?.parentInstanceId ?? a?.instanceId;
    if (owner) r.instanceId = owner;
    if (a?.appId) r.appId = a.appId;
  }
  if (id) {
    const inst = mgr?.getInstance(id);
    if (inst) { r.instanceId = inst.instanceId; r.appId = inst.appId; }
    else if (mgr?.getManifest?.(id)) r.appId = id;
  }
  if (kvNamespace(s) === 'app') {
    const appId = kvSegments(s)[1];
    if (appId) r.appId = appId;
  }
  if (rule.target === 'data-provider') {
    const p = provider(s, mgr);
    if (p) { r.appId = p.appId; r.instanceId = p.instance.instanceId; }
  }
  return r;
}

/** Fill the manifest's `<placeholder>` permissions from this request. */
export function concreteRule(
  rule: AccessRule, s: RequestSnapshot, principal: AccessPrincipal, mgr: ObserverManager | null,
): AccessRule {
  if (!rule.permissions?.some((p) => p.includes('<'))) return rule;
  const permissions: string[] = [];
  for (const permission of rule.permissions) {
    if (permission.startsWith('data:<authority>')) {
      const p = provider(s, mgr);
      if (!p) { permissions.push(permission); continue; }
      const m = normalizeMethod(s.method);
      const needed = m === 'GET' || m === 'HEAD' ? p.entry.readPermission : p.entry.writePermission;
      if (!needed || (principal.kind === 'instance' && principal.appId === p.appId)) continue;
      permissions.push(`data:${s.params['authority']}:${needed}`);
    } else if (permission === 'system.kv.os.<topic>.write') {
      const topic = kvSegments(s).slice(1).join('/').split(/[./]/, 1)[0];
      permissions.push(topic ? `system.kv.os.${topic}.write` : permission);
    } else {
      permissions.push(permission);
    }
  }
  return { ...rule, permissions };
}

// ── one decision over a request's candidate rules ───────────────────────────

/** What a request's decision needs besides its rules. */
export interface CandidateRequest {
  snapshot: RequestSnapshot;
  principal: AccessPrincipal;
  via: AccessVia;
  surface: AccessEventSurface;
  subject: string;
  method: AccessEventMethod;
  /** `enforce`: core's auto-grants don't count (decide.ts). */
  strict: boolean;
}

/** `decide()` for one candidate rule, with its placeholders and target filled from the request. */
export function decideRule(
  decideFn: Decide, mgr: ObserverManager | null, rule: AccessRule, variant: string | null, req: CandidateRequest,
  principal: AccessPrincipal = req.principal,
): Promise<DecideResult> {
  const concrete = concreteRule(rule, req.snapshot, principal, mgr);
  return decideFn({
    principal,
    action: {
      surface: req.surface, subject: label(req.subject), method: req.method,
      variant: variant ? label(variant) : null, rule: concrete,
    },
    resource: resourceFor(concrete, req.snapshot, mgr),
    transport: req.snapshot.https ? 'https' : 'http',
    // A presented approval meets the fresh-auth precondition; the handler consumes it.
    auth: { fresh: req.snapshot.approval === true, via: req.via },
    strict: req.strict,
    accessProfile: 'open',
    systemMode: systemMode(),
    deployment: 'private',
  });
}

/**
 * D89 B7, report-only: a verified instance token that arrived from an address
 * its instance does not have. For runtimes that report addresses (containers);
 * PRoot instances, sidecars (their own containers) and unknown peers are never
 * flagged. Never proof and never required: an address may legitimately differ
 * behind NAT or a remote runtime, so this only counts
 * (`binding|token-address-mismatch|<appId>` in the access report).
 */
export function tokenAddressMismatch(
  seen: { principal: AccessPrincipal; via: AccessVia },
  peer: string | null | undefined,
  mgr: Pick<ObserverManager, 'getInstanceAddresses'> | null,
): boolean {
  if (seen.via !== 'instance-token' || seen.principal.kind !== 'instance') return false;
  const p = seen.principal as InstancePrincipal;
  if (p.sidecar) return false;
  const a = normalizePeer(peer);
  if (!a) return false;
  let addresses: string[] = [];
  try { addresses = mgr?.getInstanceAddresses?.(p.instanceId) ?? []; } catch { return false; }
  if (addresses.length === 0) return false;
  return !addresses.some((x) => normalizePeer(x) === a);
}

const MISMATCH_LOG_EVERY_MS = 10 * 60_000;
const mismatchLogged = new Map<string, number>();

/** Count it, and say it in the shell log once per instance and address every 10 minutes (no credential). */
function noteAddressMismatch(report: AccessReport, appId: string | null, instanceId: string, peer: string | null | undefined): void {
  report.note(`binding|token-address-mismatch|${appId ?? 'unknown'}`);
  const key = `${instanceId} ${normalizePeer(peer)}`;
  const t = Date.now();
  if (t - (mismatchLogged.get(key) ?? 0) < MISMATCH_LOG_EVERY_MS) return;
  if (mismatchLogged.size > 500) mismatchLogged.clear();
  mismatchLogged.set(key, t);
  console.warn(`[access] token-address-mismatch (report-only, D89 B7): ${instanceId}'s token from ${normalizePeer(peer)}, `
    + 'not an address of that instance');
}

// ── the observer ────────────────────────────────────────────────────────────

const RESTRICTIVENESS: readonly DecideResult['outcome'][] = [
  'deny', 'needs-operator', 'needs-https', 'needs-fresh-auth', 'needs-approval', 'allow',
];

/** One outcome for all candidates: theirs if they agree, else the strictest as `unresolved`. */
export function combineCandidates(results: ReadonlyArray<{ variant: string | null; result: DecideResult }>): {
  variant: string | null;
  result: DecideResult;
} {
  const [first] = results;
  if (!first) return { variant: null, result: { outcome: 'deny', reason: 'unclassified' } };
  if (results.length === 1) return first;
  const agree = results.every((r) => r.result.outcome === first.result.outcome && r.result.reason === first.result.reason);
  if (agree) return { variant: null, result: first.result };
  const outcome = RESTRICTIVENESS.find((o) => results.some((r) => r.result.outcome === o)) ?? 'deny';
  return { variant: UNRESOLVED_VARIANT, result: { outcome, reason: 'ambiguous-rule' } };
}

function safeEqual(a: string, b: string): boolean {
  const x = createHash('sha256').update(a).digest();
  const y = createHash('sha256').update(b).digest();
  return timingSafeEqual(x, y);
}

/** Whether a request is one of INTERNAL_CALLS carrying this boot's internal label. */
export function isInternalCall(s: Pick<RequestSnapshot, 'internal' | 'method' | 'routePattern' | 'pathname'>, secret: string | null): boolean {
  if (!s.internal || !secret || !safeEqual(s.internal, secret)) return false;
  const method = normalizeMethod(s.method);
  return INTERNAL_CALLS.some((c) => c.method === method && c.route === s.routePattern && (!c.path || c.path === s.pathname));
}

export interface ObserverOptions {
  deps: ObserverDeps;
  report: AccessReport;
  manifest?: RouteAccessManifest;
  surfaces?: readonly AccessSurface[];
}

export function createObserver({ deps, report, manifest = ROUTE_ACCESS_MANIFEST, surfaces = SURFACE_MANIFEST }: ObserverOptions) {
  const decideFn = createDecide(deps);
  const surfaceById = new Map(surfaces.map((s) => [s.id, s]));
  const pagesByRoute = new Map(surfaces.filter((s) => s.page).map((s) => [s.page!, s]));

  /** A registered app id, or null when it isn't one (or the registry isn't up). */
  const knownApp = (appId: string | null | undefined): string | null => {
    if (!appId) return null;
    try { return deps.mgr()?.registry?.getById(appId) ? appId : null; } catch { return null; }
  };

  // The report counts what `enforce` decides: strict, whatever the mode.
  const policy = (rule: AccessRule | null, resource: PolicyResource, principal: AccessPrincipal, via: AccessVia, https: boolean, action: {
    surface: AccessEventSurface; subject: string; method: AccessEventMethod; variant: string | null;
  }) => decideFn({
    principal,
    action: { ...action, subject: label(action.subject), variant: action.variant ? label(action.variant) : null, rule },
    resource,
    transport: https ? 'https' : 'http',
    auth: { fresh: false, via },
    strict: true,
    accessProfile: 'open',
    systemMode: systemMode(),
    deployment: 'private',
  });

  const isInternal = (s: RequestSnapshot): boolean => isInternalCall(s, deps.internalSecret());

  async function evaluateRequest(s: RequestSnapshot): Promise<AccessEvent> {
    const method = normalizeMethod(s.method);
    const page = pagesByRoute.get(s.routePattern);
    const route = manifestRoute(manifest, s.routePattern);
    const isApi = route.startsWith('/api/');
    const surface: AccessEventSurface = page ? 'page' : 'api';
    const subject = page?.id ?? (isApi ? route : 'unmatched');
    const status = statusClass(s.status);

    if (isInternal(s)) {
      return {
        surface, subject: label(subject), method, variant: null, principal: 'system', appId: null,
        decision: 'allow', reason: 'system', status, via: 'internal', wouldEnforce: false,
      };
    }

    const observed = await observeIdentity(s.identity, deps);
    if (observed.failed) report.note('errors');
    const mgr = deps.mgr();
    if (tokenAddressMismatch(observed, s.identity?.peer, mgr)) {
      const p = observed.principal as InstancePrincipal;
      noteAddressMismatch(report, knownApp(p.appId), p.instanceId, s.identity?.peer);
    }
    let candidates: ReadonlyArray<{ variant: string | null; rule: AccessRule }> = [];
    if (page) candidates = [{ variant: null, rule: page.rule }];
    else if (isApi) {
      candidates = candidateRules(
        manifest,
        { route, handlers: handlersOf(manifest, route) },
        method,
        { query: new URLSearchParams(s.search), namespace: kvNamespace(s), params: s.params, bodyVariant: s.bodyVariant },
      );
    }

    const seen = observed;
    const req: CandidateRequest = {
      snapshot: s, principal: seen.principal, via: seen.via, surface, subject, method, strict: true,
    };
    const results = candidates.length
      ? await Promise.all(candidates.map(async ({ variant, rule }) => ({
        variant, result: await decideRule(decideFn, mgr, rule, variant, req),
      })))
      : [{ variant: null, result: await policy(null, { target: 'system' }, seen.principal, seen.via, s.https, { surface, subject, method, variant: null }) }];

    const { variant, result } = combineCandidates(results);
    const callerApp = principalApp(seen.principal) ?? seen.hintAppId;
    const targetApp = candidates[0] ? resourceFor(candidates[0].rule, s, mgr).appId : null;
    return {
      surface, subject: label(subject), method,
      variant: variant ? label(variant) : null,
      principal: seen.principal.kind,
      appId: knownApp(callerApp ?? targetApp) as AccessLabel | null,
      decision: result.outcome, reason: result.reason, status, via: seen.via,
      // A gateway call was already decided by enforceGateway, in every mode: a
      // refusal is its own. One it served can still be refused by `enforce`,
      // where an auto-granted permission stops counting.
      wouldEnforce: wouldEnforce(accessMode(), result.outcome, seen.via === 'gateway' && s.status >= 400),
    };
  }

  async function observeRequest(snapshot: RequestSnapshot): Promise<void> {
    try {
      report.add(await evaluateRequest(snapshot));
    } catch {
      report.note('errors');
    }
  }

  async function evaluateSurface(o: SurfaceObservation): Promise<AccessEvent | null> {
    const surface = surfaceById.get(o?.subject);
    if (!surface) return null;
    const rawMethod = typeof o.method === 'string' ? o.method.toUpperCase() : '';
    const method: AccessEventMethod = rawMethod === 'UPGRADE' ? 'UPGRADE' : normalizeMethod(rawMethod);
    if (o.via !== undefined && o.via !== 'sse-mux') return null;

    let appId: string | null = null;
    if (o.appId !== undefined && o.appId !== null) {
      if (typeof o.appId !== 'string') return null;
      // No registry yet: keep the event, without an app it can't vouch for.
      if (deps.mgr()?.registry) {
        appId = knownApp(o.appId);
        if (!appId) return null;
      }
    }

    let instanceId: string | null = null;
    if (o.instanceId !== undefined && o.instanceId !== null) {
      const inst = typeof o.instanceId === 'string' ? deps.mgr()?.getInstance(o.instanceId) : undefined;
      if (!inst) return null;
      instanceId = inst.instanceId;
      appId = knownApp(inst.appId) ?? inst.appId;
    }

    const observed = await observeIdentity(o.identity ?? null, deps);
    if (tokenAddressMismatch(observed, o.identity?.peer, deps.mgr())) {
      const p = observed.principal as InstancePrincipal;
      noteAddressMismatch(report, knownApp(p.appId), p.instanceId, o.identity?.peer);
    }
    const seen = observed;
    const https = false;
    const result = await policy(
      surface.rule,
      { target: surface.rule.target, ...(appId ? { appId } : {}), ...(instanceId ? { instanceId } : {}) },
      seen.principal,
      seen.via,
      https,
      { surface: surface.kind, subject: surface.id, method, variant: null },
    );
    const caller = principalApp(seen.principal) ?? seen.hintAppId;
    return {
      surface: surface.kind, subject: label(surface.id), method, variant: null,
      principal: seen.principal.kind,
      appId: knownApp(caller ?? appId) as AccessLabel | null,
      decision: result.outcome, reason: result.reason,
      status: statusClass(Number(o.status)), via: o.via ?? seen.via,
      wouldEnforce: wouldEnforce(accessMode(), result.outcome),
    };
  }

  const DENIED: SurfaceDecision = { outcome: 'deny', reason: 'policy-error' };

  const bridge: AccessBridge = {
    identify(facts) {
      const request = requestFromFacts(facts);
      return request ? identifyRequest(request, deps, appHostOf(facts?.appHost)) : Promise.resolve(null);
    },
    observeSurface(observation) {
      void evaluateSurface(observation)
        .then((event) => { if (event) report.add(event); else report.note('dropped'); })
        .catch(() => report.note('dropped'));
    },
    decideSurface(observation) {
      // An observation the bridge would drop (an unknown surface or app) is refused.
      return evaluateSurface(observation)
        .then((event) => (event ? { outcome: event.decision, reason: event.reason } : DENIED))
        .catch(() => DENIED);
    },
    instanceOwner(instanceId) {
      try { return deps.instanceOwner?.(instanceId) ?? null; } catch { return null; }
    },
    followSession(principal, end) {
      try { return followSocket(principal, end); } catch { return null; }
    },
    countEvent(subject) {
      if (surfaceById.has(subject)) report.note(`event|${subject}`);
      else report.note('dropped');
    },
    countCredential(kind, surface) {
      if (closed(CREDENTIAL_COUNT_KINDS, kind) && closed(CREDENTIAL_SURFACES, surface)) report.note(`cred|${kind}|${surface}`);
      else report.note('dropped');
    },
    countContract(signal, appId) {
      const app = knownApp(appId);
      if (closed(CONTRACT_SIGNALS, signal) && app) report.note(`contract|${signal}|${app}`);
      else report.note('dropped');
    },
    pending: () => report.pending(),
    dispose() {
      report.stop();
      void report.flush().catch(() => undefined);
    },
  };

  return { observeRequest, bridge };
}

// ── the running shell ───────────────────────────────────────────────────────

function liveRedis(): (ReportRedis & { status?: string }) | null {
  try {
    const r = defaultRedis();
    return r.status === 'ready' ? r as unknown as ReportRedis & { status?: string } : null;
  } catch {
    return null;
  }
}

const liveMgr = (): ObserverManager | null => {
  try { return core.getAppManager() as unknown as ObserverManager; } catch { return null; }
};

export const liveDeps: ObserverDeps = {
  authorizer: {
    authorize: (principal, action) => {
      const svc = (globalThis as Record<string, unknown>)[AUTH_SERVICES] as { authorizer?: DecideDeps['authorizer'] } | undefined;
      if (!svc?.authorizer) throw new Error('auth services not ready');
      return svc.authorizer.authorize(principal, action);
    },
  },
  mgr: liveMgr,
  ownerAgent: (p) => isTrustedOwnerAgent(p, liveMgr() as unknown as Pick<AppManager, 'isTrustedSystemCopy' | 'getInstance'> | null),
  freshAuthRequiresHttps: () => freshAuthRequiresHttps(
    ((globalThis as Record<string, unknown>)[AUTH_SERVICES] as { securityPolicy?: core.SecurityPolicyStore } | undefined)?.securityPolicy ?? null),
  // D69 and I.2: a session host is its user's, and a member reaches only its own instances.
  instanceOwner: (id) => (liveMgr() ? liveInstanceOwner(id) : null),
  installationOf: (appId) => (liveMgr() ? liveInstallationOf(appId) : Promise.resolve(null)),
  // Read, never created: creating them has side effects of its own.
  services: () => ((globalThis as Record<string, unknown>)[AUTH_SERVICES] as ObserverServices | undefined) ?? null,
  redisReady: () => liveRedis() !== null,
  internalSecret: () => {
    const v = (globalThis as Record<symbol, unknown>)[INTERNAL_SECRET];
    return typeof v === 'string' ? v : null;
  },
};

type Installed = ReturnType<typeof createObserver>;
let installed: Installed | null = null;

function install(): Installed {
  if (installed) return installed;
  const report = new AccessReport({ redis: liveRedis });
  const observer = createObserver({ deps: liveDeps, report });
  const host = globalThis as AccessBridgeHost & Record<symbol, unknown>;
  // A rebuilt shell replaces the previous module's observer in this process.
  try { host[ACCESS_BRIDGE_KEY]?.dispose?.(); } catch { /* the old one is going away */ }
  const early = Number(host[EARLY_EVENTS] ?? 0);
  if (early > 0) report.note('early', early);
  host[EARLY_EVENTS] = 0;
  host[ACCESS_BRIDGE_KEY] = observer.bridge;
  report.start();
  installed = observer;
  return observer;
}

export function observeRequest(snapshot: RequestSnapshot): Promise<void> {
  return install().observeRequest(snapshot);
}

/** The verified identity of an Astro request, started by the middleware (guard.ts). */
export function identifyAccess(request: Request): Promise<VerifiedIdentity | null> {
  install();
  return identifyRequest(request, liveDeps);
}
