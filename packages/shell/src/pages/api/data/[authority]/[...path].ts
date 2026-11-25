import type { APIRoute } from 'astro';
import { getAppManager } from '@aura/core';
import { actingInstance } from '../../../../lib/access/identify.ts';
import { dropServiceWorkerScope, stripShellCredentials } from '../../../../../server/shell-credentials.mjs';

/**
 * Content-Provider Proxy.
 *
 * Routes `GET|PUT|POST|PATCH|DELETE /api/data/<authority>/<path>` to the running
 * app instance that declared `manifest.dataProvider.authority === <authority>`.
 *
 * Source app: the verified caller the middleware resolved (`locals.access`):
 * an app instance, or a user acting through one. Anyone else is `'system'`
 * (the owner, the shell). Never a Referer.
 *
 * Permission check: the route access manifest's (routeManifest.ts, `data`),
 * applied by the middleware: the provider entry's read- or writePermission,
 * unless the caller is the provider's own app.
 */
export const ALL: APIRoute = async ({ params, request, locals }) => {
  const authority = params['authority'];
  const subPath   = params['path'] ?? '';
  if (!authority) return jsonError('Missing authority', 400);

  // The provider's own endpoint sits under /api/data/<rest>, so we rebuild it:
  const requestPath = `/api/data/${subPath}`;

  const mgr = getAppManager();
  const resolved = mgr.providers.resolveProvider(authority, requestPath);
  if (!resolved) {
    return jsonError(`No content provider registered for authority '${authority}' at path '${requestPath}'`, 404);
  }

  // ---- Source-app identification ----
  const caller = locals.access ? actingInstance(locals.access.principal) : null;
  const sourceAppId = caller?.appId ?? 'system';
  const method = request.method.toUpperCase();

  // ---- Forward to the provider ----
  const reqUrl = new URL(request.url);
  // Container-sandbox providers live on the shared docker network; PRoot
  // providers on 127.0.0.1. getUpstreamUrl picks the right host.
  const up = mgr.getUpstreamUrl?.(resolved.instance.instanceId);
  const upHost = up?.host ?? 'localhost';
  const upPort = up?.port ?? resolved.instance.port;
  const targetUrl = `http://${upHost}:${upPort}${requestPath}${reqUrl.search}`;

  try {
    const headers = stripShellCredentials(new Headers(request.headers), 'data');
    headers.set('X-Aura-Source-App-Id', sourceAppId);
    headers.set('X-Aura-Source-Permission-Mode', 'auto-granted-mvp');
    headers.delete('host');

    const upstream = await fetch(targetUrl, {
      method:  request.method,
      headers,
      body:    ['GET', 'HEAD'].includes(method) ? undefined : request.body,
      signal:  AbortSignal.timeout(30_000),
      // @ts-expect-error Node fetch supports this
      duplex: 'half',
    });

    return dropServiceWorkerScope(new Response(upstream.body, {
      status:  upstream.status,
      headers: upstream.headers,
    }));
  } catch (err) {
    return jsonError(`Provider upstream error: ${String(err)}`, 502);
  }
};

function jsonError(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
