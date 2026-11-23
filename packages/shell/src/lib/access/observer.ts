import { createHash, timingSafeEqual } from 'node:crypto';
import * as core from '@aura/core';
import type { AccessPrincipal } from '@aura/core';
import { defaultRedis } from '@aura/kv-store';
import { createDecide, type DecideDeps } from './decide.ts';
import { refererProxyId } from './legacyReferer.ts';
import { AccessReport, type ReportRedis } from './report.ts';
import { candidateRules, handlersOf, normalizeMethod } from './resolve.ts';
import { ROUTE_ACCESS_MANIFEST } from './routeManifest.ts';
import { SURFACE_MANIFEST } from './surfaceManifest.ts';
import {
  ACCESS_BRIDGE_KEY, CREDENTIAL_COUNT_KINDS, CREDENTIAL_SURFACES, UNRESOLVED_VARIANT,
} from './types.ts';
import type {
  AccessBridge, AccessBridgeHost, AccessEvent, AccessEventMethod, AccessEventSurface, AccessLabel,
  AccessRule, AccessStatusClass, AccessSurface, AccessVia, DecideResult, PolicyResource,
  RequestSnapshot, RouteAccessManifest, SurfaceIdentity, SurfaceObservation,
} from './types.ts';

/**
 * The report-only observer: identity observed without touching anything, one
 * decision per request or surface event, counted in `AccessReport`. Nothing
 * here can reach a response, and every entry point swallows its own errors.
 */

/** Calls that may carry the internal label. It labels the report and grants nothing. */
const INTERNAL_CALLS: ReadonlyArray<{ method: string; route: string; path?: string }> = [
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
  tokens: {
    hasNonce(instanceId: string, sidecar?: string): boolean;
    verify(token: string): { instanceId: string; sidecar?: string } | null;
  };
  getInstance(id: string): { appId: string; instanceId: string } | undefined;
  getInstancesByApp(appId: string): ReadonlyArray<{ appId: string; instanceId: string }>;
  getActivity?(id: string): { appId?: string; instanceId?: string } | undefined;
  getManifest?(id: string): unknown;
  registry?: { getById(id: string): unknown };
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
  admin?: { peekSession?(token: string): Promise<{ sessionId: string } | null> };
}

interface Observed {
  principal: AccessPrincipal;
  via: AccessVia;
  hintAppId: string | null;
}

// ── identity, without side effects ──────────────────────────────────────────

/** Skips the MAC for an unknown nonce, so a stray token can't create the key file. */
function instanceClaims(token: string, mgr: ObserverManager) {
  const payload = token.split('.')[1];
  if (!payload) return null;
  let p: { i?: unknown; s?: unknown };
  try { p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as typeof p; } catch { return null; }
  if (typeof p.i !== 'string' || (p.s !== undefined && typeof p.s !== 'string')) return null;
  if (!mgr.tokens.hasNonce(p.i, p.s)) return null;
  return mgr.tokens.verify(token);
}

async function observeBearer(token: string, deps: ObserverDeps): Promise<Pick<Observed, 'principal' | 'via'>> {
  const mgr = deps.mgr();
  if (token.startsWith('aura1.')) {
    if (!mgr) return { principal: ANONYMOUS, via: 'unverified' };
    const claims = instanceClaims(token, mgr);
    const inst = claims ? mgr.getInstance(claims.instanceId) : undefined;
    if (!claims || !inst) return { principal: ANONYMOUS, via: 'foreign-or-invalid' };
    return {
      principal: {
        kind: 'instance', appId: inst.appId, instanceId: inst.instanceId,
        ...(claims.sidecar ? { sidecar: claims.sidecar } : {}), verification: 'verified',
      },
      via: 'instance-token',
    };
  }
  if (token.startsWith('aura_k1_')) {
    const peek = deps.services()?.apiKeys?.peek;
    if (!peek || !deps.redisReady()) return { principal: ANONYMOUS, via: 'unverified' };
    const rec = await deps.services()!.apiKeys!.peek!(token);
    if (!rec) return { principal: ANONYMOUS, via: 'foreign-or-invalid' };
    return {
      principal: { kind: 'apiKey', keyId: rec.id, name: rec.name, scopes: [...rec.scopes], verification: 'verified' },
      via: 'api-key',
    };
  }
  if (token.startsWith('aura-admin1.')) {
    const peek = deps.services()?.admin?.peekSession;
    if (!peek || !deps.redisReady()) return { principal: ANONYMOUS, via: 'unverified' };
    const s = await deps.services()!.admin!.peekSession!(token);
    if (!s) return { principal: ANONYMOUS, via: 'foreign-or-invalid' };
    return { principal: { kind: 'admin', credential: 'shared', sessionId: s.sessionId, verification: 'verified' }, via: 'admin-session' };
  }
  // A login session is observed, never authority, until Phase 2 (D37).
  if (token.startsWith('aura-sess1.')) return { principal: ANONYMOUS, via: 'login-session' };
  return { principal: ANONYMOUS, via: 'foreign-or-invalid' };
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

export async function observeIdentity(identity: SurfaceIdentity | null, deps: ObserverDeps): Promise<Observed> {
  if (!identity) return { principal: ANONYMOUS, via: 'none', hintAppId: null };
  const mgr = deps.mgr();
  const header = identity.authorization;
  if (header !== null && header.trim() !== '') {
    const token = /^Bearer\s+(\S+)\s*$/i.exec(header)?.[1];
    if (!token) return { principal: ANONYMOUS, via: 'foreign-or-invalid', hintAppId: null };
    return { ...(await observeBearer(token, deps)), hintAppId: null };
  }
  const hint = hintApp(identity, mgr);
  if (identity.sessionCookie) return { principal: ANONYMOUS, via: 'login-session', hintAppId: hint.appId };
  return { principal: ANONYMOUS, via: hint.via ?? 'none', hintAppId: hint.appId };
}

// ── resources and placeholders ──────────────────────────────────────────────

const kvSegments = (s: RequestSnapshot) => (s.params['path'] ?? '').split('/').filter(Boolean);

function kvNamespace(s: RequestSnapshot): 'os' | 'app' | null {
  if (s.routePattern !== '/api/kv/[...path]') return null;
  const first = kvSegments(s)[0];
  return first === 'os' || first === 'app' ? first : null;
}

function provider(s: RequestSnapshot, mgr: ObserverManager | null) {
  const authority = s.params['authority'];
  if (!authority || !mgr?.providers) return null;
  try { return mgr.providers.resolveProvider(authority, `/api/data/${s.params['path'] ?? ''}`); } catch { return null; }
}

function resourceFor(rule: AccessRule, s: RequestSnapshot, mgr: ObserverManager | null): PolicyResource {
  const r: PolicyResource = { target: rule.target };
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
    if (a?.instanceId) r.instanceId = a.instanceId;
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
function concreteRule(
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

export interface ObserverOptions {
  deps: ObserverDeps;
  report: AccessReport;
  manifest?: RouteAccessManifest;
  surfaces?: readonly AccessSurface[];
}

export function createObserver({ deps, report, manifest = ROUTE_ACCESS_MANIFEST, surfaces = SURFACE_MANIFEST }: ObserverOptions) {
  const decideRule = createDecide(deps);
  const surfaceById = new Map(surfaces.map((s) => [s.id, s]));
  const pagesByRoute = new Map(surfaces.filter((s) => s.page).map((s) => [s.page!, s]));

  /** A registered app id, or null when it isn't one (or the registry isn't up). */
  const knownApp = (appId: string | null | undefined): string | null => {
    if (!appId) return null;
    try { return deps.mgr()?.registry?.getById(appId) ? appId : null; } catch { return null; }
  };

  const policy = (rule: AccessRule | null, resource: PolicyResource, principal: AccessPrincipal, https: boolean, action: {
    surface: AccessEventSurface; subject: string; method: AccessEventMethod; variant: string | null;
  }) => decideRule({
    principal,
    action: { ...action, subject: label(action.subject), variant: action.variant ? label(action.variant) : null, rule },
    resource,
    transport: https ? 'https' : 'http',
    auth: { fresh: false },
    accessProfile: 'open',
    systemMode: 'normal',
    deployment: 'private',
  });

  function isInternal(s: RequestSnapshot): boolean {
    if (!s.internal) return false;
    const secret = deps.internalSecret();
    if (!secret || !safeEqual(s.internal, secret)) return false;
    const method = normalizeMethod(s.method);
    return INTERNAL_CALLS.some((c) => c.method === method && c.route === s.routePattern && (!c.path || c.path === s.pathname));
  }

  async function evaluateRequest(s: RequestSnapshot): Promise<AccessEvent> {
    const method = normalizeMethod(s.method);
    const page = pagesByRoute.get(s.routePattern);
    const isApi = s.routePattern.startsWith('/api/');
    const surface: AccessEventSurface = page ? 'page' : 'api';
    const subject = page?.id ?? (isApi ? s.routePattern : 'unmatched');
    const status = statusClass(s.status);

    if (isInternal(s)) {
      return {
        surface, subject: label(subject), method, variant: null, principal: 'system', appId: null,
        decision: 'allow', reason: 'system', status, via: 'internal',
      };
    }

    const seen = await observeIdentity(s.identity, deps);
    const mgr = deps.mgr();
    let candidates: ReadonlyArray<{ variant: string | null; rule: AccessRule }> = [];
    if (page) candidates = [{ variant: null, rule: page.rule }];
    else if (isApi) {
      candidates = candidateRules(
        manifest,
        { route: s.routePattern, handlers: handlersOf(manifest, s.routePattern) },
        method,
        { query: new URLSearchParams(s.search), namespace: kvNamespace(s) },
      );
    }

    const results = candidates.length
      ? await Promise.all(candidates.map(async ({ variant, rule }) => {
        const concrete = concreteRule(rule, s, seen.principal, mgr);
        const result = await policy(concrete, resourceFor(concrete, s, mgr), seen.principal, s.https, { surface, subject, method, variant });
        return { variant, result };
      }))
      : [{ variant: null, result: await policy(null, { target: 'system' }, seen.principal, s.https, { surface, subject, method, variant: null }) }];

    const { variant, result } = combineCandidates(results);
    const callerApp = seen.principal.kind === 'instance' ? seen.principal.appId : seen.hintAppId;
    const targetApp = candidates[0] ? resourceFor(candidates[0].rule, s, mgr).appId : null;
    return {
      surface, subject: label(subject), method,
      variant: variant ? label(variant) : null,
      principal: seen.principal.kind === 'admin' ? 'operator' : seen.principal.kind,
      appId: knownApp(callerApp ?? targetApp) as AccessLabel | null,
      decision: result.outcome, reason: result.reason, status, via: seen.via,
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

    const seen = await observeIdentity(o.identity ?? null, deps);
    const https = false;
    const result = await policy(
      surface.rule,
      { target: surface.rule.target, ...(appId ? { appId } : {}) },
      seen.principal,
      https,
      { surface: surface.kind, subject: surface.id, method, variant: null },
    );
    const caller = seen.principal.kind === 'instance' ? seen.principal.appId : seen.hintAppId;
    return {
      surface: surface.kind, subject: label(surface.id), method, variant: null,
      principal: seen.principal.kind === 'admin' ? 'operator' : seen.principal.kind,
      appId: knownApp(caller ?? appId) as AccessLabel | null,
      decision: result.outcome, reason: result.reason,
      status: statusClass(Number(o.status)), via: o.via ?? seen.via,
    };
  }

  const bridge: AccessBridge = {
    observeSurface(observation) {
      void evaluateSurface(observation)
        .then((event) => { if (event) report.add(event); else report.note('dropped'); })
        .catch(() => report.note('dropped'));
    },
    countEvent(subject) {
      if (surfaceById.has(subject)) report.note(`event|${subject}`);
      else report.note('dropped');
    },
    countCredential(kind, surface) {
      if (closed(CREDENTIAL_COUNT_KINDS, kind) && closed(CREDENTIAL_SURFACES, surface)) report.note(`cred|${kind}|${surface}`);
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

const liveDeps: ObserverDeps = {
  authorizer: {
    authorize: (principal, action) => {
      const svc = (globalThis as Record<string, unknown>)[AUTH_SERVICES] as { authorizer?: DecideDeps['authorizer'] } | undefined;
      if (!svc?.authorizer) throw new Error('auth services not ready');
      return svc.authorizer.authorize(principal, action);
    },
  },
  mgr: () => {
    try { return core.getAppManager() as unknown as ObserverManager; } catch { return null; }
  },
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
