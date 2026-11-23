/**
 * The one legacy Referer parser (D36). Referer is self-asserted and is removed
 * as a trust source in Phase 3; until then this keeps its exact semantics.
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

interface RefererAppLookup {
  getInstance(id: string): { appId: string } | undefined;
  getInstancesByApp(appId: string): ReadonlyArray<{ appId: string }>;
}

/**
 * The app a proxied page's Referer names: the instance's app, else the id as
 * written. Null when the Referer isn't a proxy URL, which the KV and data
 * routes treat as `'system'` and the custom-interface check lets through.
 */
export function refererAppId(referer: string | null | undefined, mgr: RefererAppLookup): string | null {
  const id = refererProxyId(referer);
  if (id === null) return null;
  const inst = mgr.getInstance(id) ?? mgr.getInstancesByApp(id)[0];
  return inst?.appId ?? id;
}
