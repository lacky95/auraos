import type { AppInstance, AppManager } from '@aura/core';

/**
 * Resolve the calling INSTANCE for a write to the Interface Registry.
 *
 * The existing `identifySource` helpers (kv, data-provider routes) resolve a
 * caller to an *appId*, which is not enough here: a registration belongs to one
 * running instance and dies with it, so an app id that maps to three instances
 * would be ambiguous about which one just opened a port.
 *
 * Two sources, in order:
 *
 *   1. `Referer` — a browser-context caller inside an app iframe, whose URL is
 *      always `/api/proxy/<instanceId>/…`. Same mechanism the KV and
 *      data-provider routes already trust.
 *   2. `X-Aura-Instance-Id` — a server-context caller (the app's own Astro
 *      route or a lifecycle hook), which has no Referer at all. The app reads
 *      the value from the `APP_INSTANCE_ID` the OS injected at spawn. This is
 *      the case that matters most in practice, because an MCP or WS server
 *      lives in the app's server code, not its page.
 *
 * Deliberately **no `'system'` fallback**. The KV route treats a missing
 * Referer as privileged; for writes that would let any unattributed caller
 * register interfaces, so an unidentifiable caller is simply refused.
 *
 * On the trust model: this matches what the OS already assumes everywhere
 * (apps are cooperating, not adversarial) while being strictly tighter than
 * the neighbouring routes — the claimed instance must exist in the live table,
 * and there is no field in the request that can name a *different* instance,
 * so a cross-app write is inexpressible rather than merely forbidden. Even a
 * spoofed registration dies at that instance's next stop, or at the next
 * reconcile tick. Cryptographic instance identity would fix /api/kv and
 * /api/data too and is a whole-OS change; it is not this feature's to invent.
 */
export function identifyInstance(request: Request, mgr: AppManager): AppInstance | null {
  const referer = request.headers.get('referer');
  if (referer) {
    try {
      const match = new URL(referer).pathname.match(/^\/api\/proxy\/([^/]+)\//);
      if (match) {
        const idOrAppId = match[1]!;
        const inst = mgr.getInstance(idOrAppId)
          // A bare appId in the proxy path: pick the app's one real instance.
          // Pool members are excluded — the proxy won't route to them either.
          ?? mgr.getInstancesByApp(idOrAppId).find((i) => !i.inPool && i.port !== null);
        if (inst) return inst;
      }
    } catch { /* malformed Referer — fall through to the header */ }
  }

  const claimed = request.headers.get('x-aura-instance-id');
  if (claimed) return mgr.getInstance(claimed) ?? null;

  return null;
}
