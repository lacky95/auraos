/**
 * Vocabulary of the route access manifest (routeManifest.ts, surfaceManifest.ts).
 *
 * Phase 0 is data only: nothing in the running shell imports `lib/access`, and
 * no request is allowed or refused because of it. Phase 1 reads these rules in
 * report-only mode; Phase 3 enforces them.
 */

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
}

/** The part of a request, beyond its method, that selects a variant. */
export type AccessMatch =
  | { on: 'query'; name: string; equals?: string }
  | { on: 'namespace'; namespace: 'os' | 'app' }
  | { on: 'body'; field: string; equals?: string };

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
