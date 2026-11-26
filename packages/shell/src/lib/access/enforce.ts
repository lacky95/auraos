import type { AccessPrincipal } from '@aura/core';
import { GATEWAY_IDENTITY_HEADER } from '@aura/core/host-rules';
import { accessMode } from '../../../server/access-mode.mjs';
import { createDecide, targetPermissionsHeld } from './decide.ts';
import { snapshotOf, type AccessContext } from './guard.ts';
import { OWNER_UI_EXCLUDED_TARGETS, actingInstance, type ResolvedPrincipal } from './identify.ts';
import { resolveCaller } from '../auth.ts';
import {
  combineCandidates, concreteRule, decideRule, isInternalCall, kvNamespace, liveDeps, resourceFor,
  type CandidateRequest, type ObserverDeps,
} from './observer.ts';
import { candidateRules, handlersOf, manifestRoute, normalizeMethod, readsBody, refinementOf, type RuleCandidate } from './resolve.ts';
import { ROUTE_ACCESS_MANIFEST } from './routeManifest.ts';
import type {
  AccessReason, AccessRule, DecideResult, PolicyOutcome, RequestSnapshot, RouteAccessManifest, VerifiedIdentity,
} from './types.ts';

/**
 * The access gate of the central middleware, for every `/api` route.
 *
 *   enforce   the manifest decides every request (deny by default: a route
 *             without a rule is refused). App Host gateway calls were already
 *             decided by enforceGateway (gatewayCaller.ts) and are not
 *             decided twice.
 *   report    only a rule's `guard` is applied: the check its route made
 *   off       itself before Phase 3 (D36). Everything else is counted, never
 *             refused (observer.ts), and in `off` not even counted.
 *
 * One verdict per request: the principal resolved here (identify.ts
 * `resolvePrincipal`, verifying; never an address, D89 B6) is the one the
 * report counts and the route reads (`locals.access`). A refusal is JSON in
 * the gateway's style: 401 for an unauthenticated caller, 403 otherwise, its
 * `error` the outcome when a further step is needed (`needs-fresh-auth`,
 * `needs-approval`, …).
 */

export interface GateDeps extends ObserverDeps {
  /** The verifying resolver (auth.ts): records API key use. */
  principal(request: Request): Promise<ResolvedPrincipal>;
  mode?(): string;
}

export interface GateResult {
  /** The refusal to send, or null to go on. */
  refused: Response | null;
  /** The verdict this gate decided on, when it resolved one. */
  identity: VerifiedIdentity | null;
  /** The body variant it settled, when it read the body (for the report: RequestSnapshot.bodyVariant). */
  bodyVariant?: string | null;
}

const PASS: GateResult = { refused: null, identity: null };

/** Above any real request a rule reads (an intent, a mount, a port). The route itself reads the body without a limit. */
const MAX_BODY_BYTES = 1024 * 1024;
export const TOO_LARGE = Symbol('too-large');

/** The JSON body from a clone (null if it isn't JSON), or `too-large`. */
export async function readJsonBody(request: Request): Promise<unknown> {
  const reader = request.clone().body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      // Not awaited: cancelling one branch of a clone settles only once the other is cancelled too.
      void reader.cancel().catch(() => undefined);
      return TOO_LARGE;
    }
    chunks.push(value);
  }
  try { return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))); } catch { return null; }
}

/** A refusal, JSON and never cached. */
export const refused = (status: number, error: string, extra: Record<string, string> = {}): Response =>
  new Response(JSON.stringify({ error, ...extra }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

/** The answer to a decision that is not `allow`. */
export function refusal(result: DecideResult): Response {
  const outcome: PolicyOutcome = result.outcome;
  if (outcome !== 'deny') return refused(403, outcome, { reason: result.reason });
  if (result.reason === 'unauthenticated') return refused(401, 'unauthenticated', { reason: result.reason });
  return refused(403, 'access-denied', { reason: result.reason });
}

const allowed = (reason: AccessReason = 'public'): DecideResult => ({ outcome: 'allow', reason });

/**
 * `decide()`; as at the gateway, a user acting through an app (D45, App
 * Hosts) also has that app's instance rules when its own do not allow, and
 * never reaches a target the owner keeps out of apps (OWNER_UI_EXCLUDED_TARGETS).
 */
async function decideActing(
  decideFn: ReturnType<typeof createDecide>, mgr: ReturnType<GateDeps['mgr']>, rule: AccessRule, variant: string | null,
  req: CandidateRequest,
): Promise<DecideResult> {
  const app = req.principal.kind === 'user' ? actingInstance(req.principal) : null;
  if (app && OWNER_UI_EXCLUDED_TARGETS.has(rule.target)) return decideRule(decideFn, mgr, rule, variant, req, app);
  const result = await decideRule(decideFn, mgr, rule, variant, req);
  return result.outcome === 'allow' || !app ? result : decideRule(decideFn, mgr, rule, variant, req, app);
}

/** A rule's `guard`, as the route applied it before Phase 3: core's auto-grants count. */
async function guardDecision(
  deps: GateDeps, decideFn: ReturnType<typeof createDecide>, c: RuleCandidate, req: CandidateRequest,
): Promise<DecideResult> {
  const mgr = deps.mgr();
  const rule = c.rule;
  switch (rule.guard) {
    case undefined:
      return allowed();
    case 'rule':
      return decideActing(decideFn, mgr, rule, c.variant, req);
    case 'app-callers': {
      const app = actingInstance(req.principal);
      if (!app) return allowed();
      // A provider that isn't there: the route answers 404, as it did.
      if (concreteRule(rule, req.snapshot, app, mgr).permissions?.some((p) => p.includes('<'))) return allowed();
      return decideRule(decideFn, mgr, rule, c.variant, req, app);
    }
    case 'target-permissions': {
      const resource = resourceFor(rule, req.snapshot, mgr);
      // An instance that isn't there: the route answers 404, as it did.
      if (!resource.appId) return allowed();
      return targetPermissionsHeld(deps, rule, resource, false);
    }
  }
}

export async function accessGate(
  ctx: AccessContext, deps: GateDeps, manifest: RouteAccessManifest = ROUTE_ACCESS_MANIFEST,
): Promise<GateResult> {
  const route = manifestRoute(manifest, ctx.routePattern ?? '');
  if (!route.startsWith('/api/')) return PASS;
  const mode = (deps.mode ?? accessMode)();
  const enforcing = mode === 'enforce';
  const gateway = ctx.request.headers.has(GATEWAY_IDENTITY_HEADER);
  const method = normalizeMethod(ctx.request.method);
  const snapshot: RequestSnapshot = { ...snapshotOf(ctx), routePattern: route };
  const info = { route, handlers: handlersOf(manifest, route) };
  const facts = { query: new URLSearchParams(snapshot.search), namespace: kvNamespace(snapshot), params: snapshot.params };
  let candidates = candidateRules(manifest, info, method, facts);
  const guarded = candidates.some((c) => c.rule.guard);
  if (!enforcing && !guarded) return PASS;

  // The shell's own loopback lookups (the WS proxy, the App Host router).
  if (isInternalCall(snapshot, deps.internalSecret())) return PASS;

  const resolved = await deps.principal(ctx.request);
  const identity: VerifiedIdentity = { principal: resolved.principal, via: resolved.via };

  // Before the gateway's early return too: the report counts the variant the body settles, never both (ambiguous).
  let bodyVariant: string | null | undefined;
  if (readsBody(manifest, info, method)) {
    const body = await readJsonBody(ctx.request);
    if (body === TOO_LARGE) return { refused: refused(413, 'body-too-large'), identity };
    candidates = candidateRules(manifest, info, method, { ...facts, body });
    const read = new Set((refinementOf(manifest, route)?.variants ?? []).filter((v) => v.match.on === 'body' && v.match.read).map((v) => v.id));
    bodyVariant = candidates.find((c) => c.variant !== null && read.has(c.variant))?.variant ?? null;
  }
  const settled = bodyVariant === undefined ? {} : { bodyVariant };
  // Decided at the gateway, in every mode; the route still gets its caller.
  if (enforcing && gateway) return { refused: null, identity, ...settled };

  const seen = identity;
  const req: CandidateRequest = {
    snapshot, principal: seen.principal as AccessPrincipal, via: seen.via,
    surface: 'api', subject: route, method, strict: enforcing,
  };
  const decideFn = createDecide(deps);
  const results = await Promise.all(candidates.map(async (c) => ({
    variant: c.variant,
    result: enforcing ? await decideActing(decideFn, deps.mgr(), c.rule, c.variant, req) : await guardDecision(deps, decideFn, c, req),
  })));
  // No rule at all: unclassified, refused in `enforce` (combineCandidates).
  const { result } = enforcing || results.length ? combineCandidates(results) : { result: allowed() };
  const verdict: VerifiedIdentity = { principal: seen.principal, via: seen.via };
  if (result.outcome === 'allow') return { refused: null, identity: verdict, ...settled };
  return { refused: refusal(result), identity: verdict, ...settled };
}

// ── the running shell ───────────────────────────────────────────────────────

/** The observer's live deps, with the verifying resolver of `authenticate()`. */
const live: GateDeps = { ...liveDeps, principal: (request) => resolveCaller(request) };

export const liveAccessGate = (ctx: AccessContext): Promise<GateResult> => accessGate(ctx, live);
