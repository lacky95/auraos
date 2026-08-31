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
 * On the trust model, stated plainly because it is easy to overclaim:
 * **both sources are self-asserted.** Anything that can reach the shell API
 * can set a Referer or an X-Aura-Instance-Id and register under another app's
 * identity. That is not a hole this route opens — it is the OS's existing
 * app-identity model (`/api/kv` and `/api/data` trust the same Referer, and
 * the KV route additionally treats a *missing* Referer as privileged
 * `'system'`). Apps here are assumed cooperating, not adversarial.
 *
 * What this route does add is containment: the claimed instance must exist in
 * the live table, writes are refused outright when no instance can be named,
 * and every entry dies with its instance — at the next stop, or at the next
 * reconcile tick. So the blast radius of a forged registration is one
 * advertised address until that app next stops, never a persistent lie.
 *
 * Real instance identity (a per-instance token minted at spawn) would fix
 * this route, /api/kv and /api/data together. It is a whole-OS change and
 * deliberately not invented here.
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
