/**
 * Vocabulary of the route access manifest (routeManifest.ts, surfaceManifest.ts).
 *
 * AURA_ACCESS_ENFORCE (server/access-mode.mjs) picks what a rule does: in
 * `enforce` the middleware and the surface gate refuse what it denies
 * (enforce.ts, access-bridge.mjs `surfaceGate`); in `report` it is only
 * counted (observer.ts). A rule's `guard` is applied in every mode: it is
 * the check its route made itself before Phase 3 (D36).
 */
import type { AccessPrincipal, PrincipalClass } from '@aura/core';

export const ACCESS_LEVELS = ['public', 'owner', 'own-instance', 'app-permission'] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

export const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/**
 * A method a rule can name. `OTHER` is every token outside HTTP_METHODS: an
 * `ALL` handler receives those too (Astro: `mod[method] ?? mod.ALL`).
 */
export const ROUTE_METHODS = [...HTTP_METHODS, 'OTHER'] as const;
export type RouteMethod = (typeof ROUTE_METHODS)[number];

/** What a rule's levels are checked against. */
export type AccessTarget =
  | 'system'          // the OS as a whole
  | 'session'         // the caller's own login session
  | 'client-session'  // one shell screen (lock-state view, not a credential)
  | 'app'             // an app id: `own-instance` means an instance of that app
  | 'instance'        // one running instance
  | 'instance-pair'   // two instances/apps: source AND target are both checked
  | 'sidecar'         // one sidecar of an instance
  | 'activity'        // one window, checked through its owning instance
  | 'notification'
  | 'interface'
  | 'kv-entry'
  | 'data-provider'
  | 'proxy-upstream'; // the instance or app a proxied request reaches

/** An open question, and the phase that has to answer it. */
export interface AccessDecision {
  note: string;
  phase: number;
}

export interface AccessRule {
  /** The levels that satisfy this rule (any one). Empty = denied. */
  allow: readonly AccessLevel[];
  target: AccessTarget;
  /** Held by the calling app (all of them). An `owner` caller doesn't need them. */
  permissions?: readonly string[];
  /** Held by the TARGET instance's app (all of them), whoever is calling. */
  targetPermissions?: readonly string[];
  /** The right rule isn't settled yet. Requires `decision`. */
  ambiguous?: true;
  decision?: AccessDecision;
  /** Needs a fresh authentication (5.11): a presented approval, which the handler consumes (Aura Context writes). */
  freshAuth?: true;
  /**
   * Only a principal established this way counts (identify.ts
   * `resolvePrincipal`). The rest are refused, whatever their level.
   */
  credentials?: readonly AccessVia[];
  /**
   * D28: a caller without any credential counts as the app instance whose
   * container network address it calls from (identify.ts `networkInstance`),
   * and that is enough for this rule. Never a gateway or token caller.
   */
  networkCaller?: true;
  /**
   * What the route checked itself before Phase 3, which moved here (D36). The
   * middleware applies it in EVERY access mode; the rest of the rule only in
   * `enforce`. Permissions are read as before (core's MVP auto-grant counts).
   *   rule                the whole rule, for every caller
   *   app-callers         the whole rule, for a caller that is an app: an
   *                       instance, or a user acting through one (judged as
   *                       that app). Anyone else passes, as `system` did.
   *   target-permissions  only `targetPermissions`, for every caller, once
   *                       the target is known (else the route answers 404)
   */
  guard?: AccessGuard;
  /** Why the rule is what it is, once its open question was answered. */
  note?: string;
  /**
   * The `app` target is this app, and only while its system-scope copy is the
   * one installed: an app of the same id in another scope doesn't qualify.
   */
  systemApp?: string;
}

export const ACCESS_GUARDS = ['rule', 'app-callers', 'target-permissions'] as const;
export type AccessGuard = (typeof ACCESS_GUARDS)[number];

/** The part of a request, beyond its method, that selects a variant. */
export type AccessMatch =
  | { on: 'query'; name: string; equals?: string }
  | { on: 'namespace'; namespace: 'os' | 'app' }
  /** A route parameter (`[id]`) with exactly this value, e.g. one system app's id. */
  | { on: 'param'; name: string; equals: string }
  | {
    on: 'body';
    /** Dotted path into the JSON body. */
    field: string;
    equals?: string | boolean;
    /**
     * The middleware and the App Host gateway parse the JSON body (a clone,
     * capped) and settle this variant. Otherwise a body variant stays unread
     * and counts at its strictest. The report never reads a body: it takes
     * the variant the gate settled (`RequestSnapshot.bodyVariant`).
     */
    read?: true;
  };

/** A rule for some requests of a method. First match wins, else the method's rule. */
export interface AccessVariant {
  id: string;
  methods: readonly RouteMethod[];
  match: AccessMatch;
  rule: AccessRule;
}

/**
 * Per-route refinement of the group baseline. A `GET` entry also covers the
 * implicit `HEAD` of a route without an `ALL` export; an `ALL` route lists
 * every RouteMethod.
 */
export interface RouteRefinement {
  methods?: Partial<Record<RouteMethod, AccessRule>>;
  variants?: readonly AccessVariant[];
}

export interface RouteAccessManifest {
  /** Baseline per first path segment after `/api`. */
  groups: Readonly<Record<string, AccessRule>>;
  routes: Readonly<Record<string, RouteRefinement>>;
  /** Files Astro registers as routes that export no handler, with the reason. */
  nonRoutes: Readonly<Record<string, string>>;
}

export type SurfaceKind =
  | 'listener'
  | 'websocket'
  | 'host-router'
  | 'app-upstream'
  | 'page'
  | 'static'
  | 'dev-server';

/** A way into the shell that doesn't go through an Astro API route. */
export interface AccessSurface {
  id: string;
  kind: SurfaceKind;
  /** Where it is implemented. */
  source: string;
  paths: readonly string[];
  /** The function `attachShellServers` calls for it. */
  attach?: string;
  /** The Astro page route, for `kind: 'page'`. */
  page?: string;
  rule: AccessRule;
}

// ── access events ───────────────────────────────────────────────────────────

declare const accessLabel: unique symbol;
/**
 * A value taken from a closed list: a manifest route pattern, surface id or
 * variant id, or an installed app id. Never a request value, so a raw path,
 * query, header, token, cookie, Referer, body or KV key can't be typed here.
 * `.mjs` callers have no types: the bridge must check these against the
 * manifest and app registry, and drop an event that doesn't match.
 */
export type AccessLabel = string & { readonly [accessLabel]: true };

export const POLICY_OUTCOMES = [
  'allow', 'deny', 'needs-approval', 'needs-fresh-auth', 'needs-https', 'needs-operator',
] as const;
export type PolicyOutcome = (typeof POLICY_OUTCOMES)[number];

export const ACCESS_REASONS = [
  // allowed, by the level that matched
  'public', 'owner', 'own-instance', 'app-permission', 'system',
  // allowed only because core has not enforced this permission yet (never in `enforce`)
  'auto-granted',
  // D28: a tokenless call from an app container's network address
  'network-caller',
  // refused
  'unclassified', 'unauthenticated', 'wrong-principal', 'wrong-target',
  'missing-permission', 'missing-target-permission', 'rule-denied', 'ambiguous-rule',
  // a further step is needed
  'approval-required', 'fresh-auth-required', 'https-required', 'operator-required',
  'policy-error',
] as const;
export type AccessReason = (typeof ACCESS_REASONS)[number];

/** How the caller's identity was established. The `*-hint` values prove nothing. */
export const ACCESS_VIAS = [
  'login-session', 'instance-token', 'api-key', 'operator-ticket',
  // a signed App Host gateway claim / a verified App Host cookie session
  'gateway', 'app-host',
  'referer-hint', 'instance-id-hint', 'internal', 'sse-mux',
  // D28: no credential, but the container network address of a running instance
  'network',
  // a credential that isn't a valid Aura one / one that can't be checked right now
  'foreign-or-invalid', 'unverified',
  'none',
] as const;
export type AccessVia = (typeof ACCESS_VIAS)[number];

export const ACCESS_STATUS_CLASSES = ['1xx', '2xx', '3xx', '4xx', '5xx', 'none'] as const;
/** `none`: no status was sent, such as a dropped socket. */
export type AccessStatusClass = (typeof ACCESS_STATUS_CLASSES)[number];

/** `api` is an Astro route. The rest are the manifest's surface kinds. */
export type AccessEventSurface = 'api' | SurfaceKind;

/** `UPGRADE` is a WebSocket handshake. */
export type AccessEventMethod = RouteMethod | 'UPGRADE';
export const ACCESS_EVENT_METHODS = [...ROUTE_METHODS, 'UPGRADE'] as const;

/** Reported when a request's candidate rules disagree and only its body could tell. */
export const UNRESOLVED_VARIANT = 'unresolved';

/** One observed decision, on any surface. Plain JSON: every field is closed. */
export interface AccessEvent {
  surface: AccessEventSurface;
  /** The manifest route pattern, or the surface id. */
  subject: AccessLabel;
  method: AccessEventMethod;
  variant: AccessLabel | null;
  principal: PrincipalClass;
  appId: AccessLabel | null;
  decision: PolicyOutcome;
  reason: AccessReason;
  status: AccessStatusClass;
  via: AccessVia;
  /**
   * Recorded in `report` mode: `enforce` would refuse this request, which
   * was served (server/access-mode.mjs `wouldEnforce`). Always false in
   * `enforce`, and for a gateway call, which is refused in every mode.
   */
  wouldEnforce: boolean;
}

/**
 * How `.mjs` servers reach the observer, which they can't import:
 *
 *   globalThis[Symbol.for('aura.access')]?.observeSurface(observation)
 *
 * The bridge builds each event itself, so a sender can't write report rows.
 * Its methods never throw and are never awaited, so they can't change a response.
 */
export const ACCESS_BRIDGE_KEY: unique symbol = Symbol.for('aura.access');

export interface AccessBridge {
  /**
   * Start resolving a `.mjs` server's request to its verified identity
   * (access-bridge.mjs `surfaceIdentity`). The facts are read at once and
   * not kept; the promise holds only the result.
   */
  identify(facts: SurfaceFacts): Promise<VerifiedIdentity | null>;
  /** A surface event: the bridge checks it, runs `decide()` and counts it. */
  observeSurface(observation: SurfaceObservation): void;
  /** The decision for a surface about to proceed, as `enforce` applies it. Never counted, never throws. */
  decideSurface(observation: SurfaceObservation): Promise<SurfaceDecision>;
  /** M4: end a socket with the session its verdict rides on (lib/streamSession.ts `followSocket`). */
  followSession(principal: AccessPrincipal | null, end: () => void): { stop(): void } | null;
  /** A high-frequency event on a surface: a counter only. */
  countEvent(subject: string): void;
  countCredential(kind: string, surface: string): void;
  /** An app contract signal (CONTRACT_SIGNALS) of an installed app: a counter only. */
  countContract(signal: string, appId: string): void;
  pending(): { keys: number; events: number; meta: Record<string, number> };
  dispose(): void;
}

/** What a `.mjs` server hands to `identify`: its Node request headers, method, URL and a verified App Host session. */
export interface SurfaceFacts {
  headers: unknown;
  method?: unknown;
  url?: unknown;
  appHost?: unknown;
}

/** What `.mjs` surfaces ask the surface gate (access-bridge.mjs `surfaceGate`). */
export interface SurfaceDecision {
  outcome: PolicyOutcome;
  reason: AccessReason;
}

/** What the principal resolver (identify.ts `resolvePrincipal`) made of a request. Never a credential. */
export interface VerifiedIdentity {
  principal: AccessPrincipal;
  via: AccessVia;
}

/** What an observation knows of its caller. Transient, never stored, and never a credential. */
export interface SurfaceIdentity {
  /**
   * The resolver's verdict, started while the request was in hand. The
   * credentials it read are not kept. Null: it could not run (the observer
   * was not loaded yet, or it failed).
   */
  verified: Promise<VerifiedIdentity | null> | VerifiedIdentity | null;
  /** Hints for the report's app column only. */
  referer: string | null;
  instanceId: string | null;
  /** The socket peer address: names an app container for a `networkCaller` rule (D28). */
  peer?: string | null;
}

/** What a `.mjs` server sends. Untyped there, so all of it is validated. */
export interface SurfaceObservation {
  subject: string;
  method: string;
  status: number;
  appId?: string | null;
  via?: 'sse-mux';
  identity?: SurfaceIdentity | null;
}

/** What the middleware copies from a request. Never stored. */
export interface RequestSnapshot {
  method: string;
  routePattern: string;
  pathname: string;
  search: string;
  params: Record<string, string | undefined>;
  https: boolean;
  status: number;
  internal: string | null;
  identity: SurfaceIdentity;
  /**
   * The request names an approval (`X-Aura-Approval`): decide()'s fresh-auth
   * precondition. Its handler consumes it; presenting proves nothing alone.
   */
  approval?: boolean;
  /**
   * The body variant the gate settled when it read the body (null: none of
   * them matched); absent when it did not read it. The id only, never the body.
   */
  bodyVariant?: string | null;
}

/**
 * App contract signals (D48), counted per app as `contract|<signal>|<appId>`:
 *   context-get          a declared Context key read through `osClient.context.get`
 *   context-undeclared   a Context key the manifest doesn't declare (refused)
 *   interface-undeclared an interface looked up by name that `consumes[]` doesn't name
 * Report only: the D39 gate reads them like the would-denies.
 */
export const CONTRACT_SIGNALS = ['context-get', 'context-undeclared', 'interface-undeclared'] as const;
export type ContractSignal = (typeof CONTRACT_SIGNALS)[number];

export const CREDENTIAL_COUNT_KINDS = [
  'stripped-session-cookie', 'stripped-login-bearer', 'stripped-admin-bearer',
  'stripped-instance-token', 'stripped-api-key',
  // Counted before D89 (B2), when they were still forwarded: kept so older report days read.
  'forwarded-instance-token', 'forwarded-api-key',
] as const;
export const CREDENTIAL_SURFACES = [
  'proxy-http', 'data', 'ws-proxy', 'sse-mux', 'app-hosts-http', 'app-hosts-upgrade',
] as const;

export type AccessBridgeHost = typeof globalThis & { [ACCESS_BRIDGE_KEY]?: AccessBridge };

// ── decide() ────────────────────────────────────────────────────────────────

export type PolicyTransport = 'https' | 'http';
export type AccessProfile = 'open' | 'zero-trust';
export type SystemMode = 'normal' | 'developer';
export type DeploymentKind = 'private' | 'public';

export interface PolicyAction {
  surface: AccessEventSurface;
  subject: AccessLabel;
  method: AccessEventMethod;
  variant: AccessLabel | null;
  /** The effective rule. Null is an unclassified request, which is denied (Q28). */
  rule: AccessRule | null;
}

/** The specific target, as far as it could be resolved. */
export interface PolicyResource {
  target: AccessTarget;
  appId?: string;
  instanceId?: string;
  sidecar?: string;
  /** The other side of an `instance-pair`. */
  peerInstanceId?: string;
}

export interface DecideInput {
  principal: AccessPrincipal;
  action: PolicyAction;
  resource: PolicyResource;
  transport: PolicyTransport;
  /** `via`: how the principal was established, for `credentials` and `networkCaller`. */
  auth: { fresh: boolean; via?: AccessVia };
  /**
   * `enforce` (D36 fold of core's ENFORCED_PERMISSIONS): a permission core
   * only auto-grants does not count. Outside `enforce` it does, as before.
   */
  strict?: boolean;
  accessProfile: AccessProfile;
  systemMode: SystemMode;
  deployment: DeploymentKind;
}

export interface DecideResult {
  outcome: PolicyOutcome;
  reason: AccessReason;
}

export type Decide = (input: DecideInput) => Promise<DecideResult>;
