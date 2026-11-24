/**
 * The shell's public assets (theme, icons) as the app's own routes, injected by
 * `auraAppIntegration`.
 *
 * On an App Host this sends the browser to the same file through the gateway,
 * so existing tags, their cache-busting and their `load` listeners keep
 * working unchanged. Any other request (the machine path) gets 404.
 */
import { APP_HOST_ROUTE_HEADER } from '../hostRules.js';
import { appHostAssetLocation } from './loader.js';

export const prerender = false;

export function GET({ request }: { request: Request }): Response {
  const location = appHostAssetLocation(request.headers.get(APP_HOST_ROUTE_HEADER), request.url);
  if (!location) return new Response(null, { status: 404 });
  return new Response(null, { status: 307, headers: { location, 'cache-control': 'no-store' } });
}
