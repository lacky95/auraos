import type { APIRoute } from 'astro';
import { errorResponse, jsonResponse } from '../../../../../lib/appResponse.js';
import { listAppHosts } from '../../../../../lib/appHosts.js';

/**
 * GET /api/apps/<id>/hosts/<name>[/<path>?query] — the Interface Registry's
 * `url` for an `http/host` entry. Redirects (302) to the host's absolute URL
 * for this caller, `?…` and an optional `path` param carried over. With
 * `Accept: application/json` (or `?format=json`) it answers the DTO instead.
 * 409 when the caller reached the shell by raw IP: there is no host to build.
 */
export const GET: APIRoute = ({ params, request, url }) => {
  const appId = params['id'];
  const name = params['name'];
  if (!appId || !name) return errorResponse('Missing app id or host name', 400);
  const host = listAppHosts(request, appId).find((h) => h.name === name);
  if (!host) return errorResponse(`${appId} declares no host '${name}'`, 404);

  const wantsJson = url.searchParams.get('format') === 'json'
    || (request.headers.get('accept') ?? '').includes('application/json');
  if (wantsJson) return jsonResponse(host);
  if (!host.url) {
    return errorResponse(`No app host URL for a raw IP: open AuraOS at its nip.io address (e.g. http://10-0-0-2.nip.io:3000) or a domain`, 409);
  }
  const path = url.searchParams.get('path') ?? '/';
  const rest = new URLSearchParams(url.searchParams);
  rest.delete('path');
  rest.delete('format');
  const qs = rest.toString();
  const target = `${host.url}${path.startsWith('/') ? path : `/${path}`}${qs ? `?${qs}` : ''}`;
  return new Response(null, { status: 302, headers: { location: target, 'cache-control': 'no-store' } });
};
