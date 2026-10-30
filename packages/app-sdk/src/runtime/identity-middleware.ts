/**
 * Astro middleware injected by `auraAppIntegration`: stamps every rendered
 * response with `X-Aura-App-Id` / `X-Aura-Instance-Id`, the identity the
 * shell proxy and the reconciler check (port-squatter protection).
 *
 * Middleware runs in `astro dev` AND in a production build — the
 * integration's `astro:server:setup` hook (which also stamps the assets Vite
 * serves) only ever ran under `astro dev`, so built apps sent no identity.
 */

type Next = () => Promise<Response>;

export async function onRequest(_ctx: unknown, next: Next): Promise<Response> {
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
