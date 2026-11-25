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

const spellings = new WeakMap<RouteAccessManifest, Map<string, string>>();

/**
 * The manifest's spelling of a route pattern. Astro hands `routePattern`
 * lowercased (`/api/instances/[instanceid]/sidecars`), while the manifest
 * writes parameters as the route files name them (`[instanceId]`), so a
 * lookup by Astro's pattern would miss the rule and fall back to the group.
 * A pattern the manifest doesn't list comes back unchanged.
 */
export function manifestRoute(manifest: RouteAccessManifest, pattern: string): string {
  let byLower = spellings.get(manifest);
  if (!byLower) {
    byLower = new Map(Object.keys(manifest.routes).map((r) => [r.toLowerCase(), r]));
    spellings.set(manifest, byLower);
  }
  return byLower.get(pattern.toLowerCase()) ?? pattern;
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
  /** The route's parameters (`[id]` …), for `param` variants. Absent = none match. */
  params?: Readonly<Record<string, string | undefined>>;
  /** The parsed JSON body, for `read` body variants. Undefined = not read. */
  body?: unknown;
  /** Without the body: the `read` body variant an earlier read settled (null: none). Undefined = not settled. */
  bodyVariant?: string | null;
}

/**
 * Whether a parsed body has `field` (and its value, with `equals`). An own
 * `__proto__` on the path counts as a match: a later merge could turn it into
 * the inherited field this check looked for.
 */
export function bodyFieldMatches(body: unknown, field: string, equals?: string | boolean): boolean {
  let current = body;
  for (const part of field.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return false;
    if (Object.hasOwn(current, '__proto__')) return true;
    if (!Object.hasOwn(current, part)) return false;
    current = (current as Record<string, unknown>)[part];
  }
  return equals === undefined || current === equals;
}

/** Whether some body variant of this route that applies to `method` is to be read. */
export function readsBody(manifest: RouteAccessManifest, info: RouteHandlers, method: RouteMethod): boolean {
  return (manifest.routes[info.route]?.variants ?? []).some((v) =>
    v.match.on === 'body' && v.match.read === true && variantApplies(v.methods, method, info));
}

export interface RuleCandidate {
  variant: string | null;
  rule: AccessRule;
}

/**
 * Every rule this request could fall under, in first-match order. A body
 * variant that wasn't read stays a candidate and the walk goes on; a variant
 * that definitely matches ends it.
 */
export function candidateRules(
  manifest: RouteAccessManifest, info: RouteHandlers, method: RouteMethod, facts: VariantFacts,
): RuleCandidate[] {
  const out: RuleCandidate[] = [];
  for (const v of manifest.routes[info.route]?.variants ?? []) {
    if (!variantApplies(v.methods, method, info)) continue;
    const m = v.match;
    if (m.on === 'body') {
      const settled = !m.read ? null
        : facts.body !== undefined ? bodyFieldMatches(facts.body, m.field, m.equals)
          : facts.bodyVariant !== undefined ? facts.bodyVariant === v.id : null;
      if (settled === false) continue;
      out.push({ variant: v.id, rule: v.rule });
      if (settled) return out;
      continue;
    }
    const matches = m.on === 'query'
      ? facts.query.has(m.name) && (m.equals === undefined || facts.query.get(m.name) === m.equals)
      : m.on === 'param'
        ? facts.params?.[m.name] === m.equals
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
