/**
 * The app side of the lifecycle token: one check every runtime runs before any
 * `/api/lifecycle/*` handler (the Astro `identity-middleware`, `runtime/next`,
 * `sidecars.createServer`, and raw apps that import it).
 *
 * At each spawn the kernel puts a random `AURA_LIFECYCLE_TOKEN` in the app's
 * env and sends it as `x-aura-lifecycle` on every lifecycle call and its own
 * health probes. Any other caller — another app on `aura-net`, or a request
 * through the shell, which strips the header — gets 401 before a handler runs.
 *
 *   • health without the header still answers (other probes);
 *   • health with a wrong header is refused (the kernel's runtime check);
 *   • every other lifecycle path needs the right token.
 *
 * Without `AURA_LIFECYCLE_TOKEN` (an older OS, or the app started by hand)
 * there is nothing to check against, and the routes answer as before.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { identityResponseHeaders } from '../context.js';
import { LIFECYCLE_HEALTH_PATH, LIFECYCLE_TOKEN_HEADER, lifecycleRequestPath } from '../hostRules.js';

export { LIFECYCLE_TOKEN_HEADER };

const digest = (v: string): Buffer => createHash('sha256').update(v).digest();

/** Constant-time compare (hashing first makes the lengths equal). */
function tokenMatches(presented: string, expected: string): boolean {
  return timingSafeEqual(digest(presented), digest(expected));
}

/**
 * Whether a request must be refused (401) before any handler runs.
 * `presented` is the raw `x-aura-lifecycle` value (Node may hand an array).
 */
export function lifecycleRequestRefused(
  path: string,
  presented: string | string[] | null | undefined,
  expected: string | undefined = process.env['AURA_LIFECYCLE_TOKEN'],
): boolean {
  const route = lifecycleRequestPath(path);
  if (route === null || !expected) return false;
  if (presented === null || presented === undefined) return route !== LIFECYCLE_HEALTH_PATH;
  return typeof presented !== 'string' || !tokenMatches(presented, expected);
}

/** The 401 body every guard answers with. */
export const LIFECYCLE_REFUSAL = { ok: false, error: 'lifecycle-token-required' } as const;

/** The 401 as a web `Response`, stamped with the app's identity. */
export function lifecycleRefusalResponse(): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...identityResponseHeaders() };
  return new Response(JSON.stringify(LIFECYCLE_REFUSAL), { status: 401, headers });
}
