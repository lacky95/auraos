/**
 * The one legacy Referer parser (D36). Referer is self-asserted and trusts
 * nothing since Phase 3: only the access report's app column reads it, as a hint.
 */

/** The `<id>` of a Referer on `/api/proxy/<id>/…`, or null. */
export function refererProxyId(referer: string | null | undefined): string | null {
  if (!referer) return null;
  try {
    return new URL(referer).pathname.match(/^\/api\/proxy\/([^/]+)\//)?.[1] ?? null;
  } catch {
    return null;
  }
}
