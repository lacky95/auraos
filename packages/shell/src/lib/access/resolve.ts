import { ROUTE_METHODS } from './types.ts';
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
