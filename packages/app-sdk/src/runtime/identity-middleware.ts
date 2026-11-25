/**
 * Astro middleware injected by `auraAppIntegration` (order `pre`, so it runs
 * before the app's own middleware and every route):
 *
 *   • refuses `/api/lifecycle/*` without the kernel's lifecycle token with 401
 *     before any handler runs — injected, factory-made and hand-written hook
 *     files alike (see ./lifecycle-guard);
 *   • stamps every rendered response with `X-Aura-App-Id` /
 *     `X-Aura-Instance-Id`, the identity the shell (App Host router, machine
 *     path) and the reconciler check (port-squatter protection).
 *
 * Middleware runs in `astro dev` AND in a production build — the
 * integration's `astro:server:setup` hook (which also stamps the assets Vite
 * serves) only ever ran under `astro dev`, so built apps sent no identity.
 */
import { LIFECYCLE_TOKEN_HEADER, lifecycleRefusalResponse, lifecycleRequestRefused } from './lifecycle-guard.js';

type Next = () => Promise<Response>;
interface Ctx { url: URL; request: Request }

export async function onRequest(ctx: Ctx, next: Next): Promise<Response> {
  if (lifecycleRequestRefused(ctx.url.pathname, ctx.request.headers.get(LIFECYCLE_TOKEN_HEADER))) {
    return lifecycleRefusalResponse();
  }
  const res = await next();
  const appId      = process.env['APP_ID'];
  const instanceId = process.env['APP_INSTANCE_ID'];
  if (!appId && !instanceId) return res;
  try {
    if (appId)      res.headers.set('X-Aura-App-Id', appId);
    if (instanceId) res.headers.set('X-Aura-Instance-Id', instanceId);
    return res;
  } catch {
    // Immutable headers (a Response passed through from fetch): copy once.
    const copy = new Response(res.body, res);
    if (appId)      copy.headers.set('X-Aura-App-Id', appId);
    if (instanceId) copy.headers.set('X-Aura-Instance-Id', instanceId);
    return copy;
  }
}
