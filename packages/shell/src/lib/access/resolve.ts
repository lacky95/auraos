import { HTTP_METHODS, ROUTE_METHODS } from './types.ts';
import type { AccessRule, RouteAccessManifest, RouteMethod } from './types.ts';

/**
 * Pure lookups over the route access manifest. No I/O, so the audit test and
 * the Phase 1 observer resolve a rule the same way.
 */

/** The part of a route the lookups need. `handlers` are its exports, as written. */
export interface RouteHandlers {
  route: string;
  handlers: readonly string[];
}

/** Every method Astro dispatches to one of these handlers. */
export function dispatchedMethods(handlers: readonly string[]): RouteMethod[] {
  if (handlers.includes('ALL')) return [...ROUTE_METHODS];
  const methods = new Set(handlers as RouteMethod[]);
  if (methods.has('GET')) methods.add('HEAD');
  return ROUTE_METHODS.filter((m) => methods.has(m));
}

/** The group of `/api/<group>/…`. */
export const groupOf = (route: string): string => route.split('/')[2] ?? '';

/** The rule for a method, before any variant applies. */
export function effectiveRule(
  manifest: RouteAccessManifest,
  info: RouteHandlers,
  method: RouteMethod,
): AccessRule | undefined {
  const methods = manifest.routes[info.route]?.methods;
  const own = methods?.[method];
  if (own) return own;
  if (method === 'HEAD' && !info.handlers.includes('ALL') && !info.handlers.includes('HEAD') && methods?.GET) return methods.GET;
  return manifest.groups[groupOf(info.route)];
}

/** Whether a variant listing `methods` covers this method, including implicit HEAD. */
export const variantApplies = (methods: readonly RouteMethod[], method: RouteMethod, info: RouteHandlers): boolean =>
  methods.includes(method)
  || (method === 'HEAD' && methods.includes('GET') && !info.handlers.includes('ALL') && !info.handlers.includes('HEAD'));

/** A request method as a rule names it: anything non-standard is `OTHER`. */
export function normalizeMethod(method: string): RouteMethod {
  const m = method.toUpperCase();
  return (HTTP_METHODS as readonly string[]).includes(m) ? m as RouteMethod : 'OTHER';
}

/**
 * A route's handlers as the manifest records them. An `ALL` route lists every
 * method there (the manifest test holds that), and a route without an entry
 * falls back to its group.
 */
export function handlersOf(manifest: RouteAccessManifest, route: string): string[] {
  const methods = manifest.routes[route]?.methods;
  if (!methods) return [];
  const names = Object.keys(methods);
  return ROUTE_METHODS.every((m) => names.includes(m)) ? ['ALL'] : names;
}

/** The request facts a variant can match on, short of its body. */
export interface VariantFacts {
  query: URLSearchParams;
  namespace: 'os' | 'app' | null;
}

export interface RuleCandidate {
  variant: string | null;
  rule: AccessRule;
}

/**
 * Every rule this request could fall under, in first-match order. A body
 * variant is never read, so it stays a candidate and the walk goes on; a
 * variant that definitely matches ends it.
 */
export function candidateRules(
  manifest: RouteAccessManifest, info: RouteHandlers, method: RouteMethod, facts: VariantFacts,
): RuleCandidate[] {
  const out: RuleCandidate[] = [];
  for (const v of manifest.routes[info.route]?.variants ?? []) {
    if (!variantApplies(v.methods, method, info)) continue;
    const m = v.match;
    if (m.on === 'body') {
      out.push({ variant: v.id, rule: v.rule });
      continue;
    }
    const matches = m.on === 'query'
      ? facts.query.has(m.name) && (m.equals === undefined || facts.query.get(m.name) === m.equals)
      : facts.namespace === m.namespace;
    if (matches) {
      out.push({ variant: v.id, rule: v.rule });
      return out;
    }
  }
  const base = effectiveRule(manifest, info, method);
  if (base) out.push({ variant: null, rule: base });
  return out;
}
