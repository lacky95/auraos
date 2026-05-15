import type { APIRoute } from 'astro';
import { getAppManager } from '@aura/core';

/**
 * Content-Provider Proxy.
 *
 * Routes `GET|PUT|POST|PATCH|DELETE /api/data/<authority>/<path>` to the running
 * app instance that declared `manifest.dataProvider.authority === <authority>`.
 *
 * Source-app identification: extracted from the `Referer` header. If the
 * referer matches `/api/proxy/<X>/...` we treat X as the requesting app.
 * Missing/unknown referer = `'system'` (privileged, e.g. curl, SSR call).
 *
 * Permission check: looks up read- or writePermission on the matched provider
 * entry. Same-app access is always allowed. Otherwise delegated to
 * `PermissionManager.hasPermission` — currently auto-grants but logs.
 */
export const ALL: APIRoute = async ({ params, request }) => {
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
  const sourceAppId = identifySource(request.headers.get('referer'), mgr);

  // ---- Permission check ----
  const method = request.method.toUpperCase();
  const isRead = method === 'GET' || method === 'HEAD';
  const requiredPerm = isRead
    ? resolved.entry.readPermission
    : resolved.entry.writePermission;

  if (requiredPerm && sourceAppId !== 'system' && sourceAppId !== resolved.appId) {
    // Permission keys flow as `data:<authority>:<perm-name>` to be consistent with manifests
    const permKey = `data:${authority}:${requiredPerm}`;
    if (!mgr.permissions.hasPermission(sourceAppId, permKey)) {
      return jsonError(`Permission denied: ${permKey}`, 403);
    }
  }

  // ---- Forward to the provider ----
  const reqUrl = new URL(request.url);
  // Container-sandbox providers live on the shared docker network; PRoot
  // providers on 127.0.0.1. getUpstreamUrl picks the right host.
  const up = mgr.getUpstreamUrl?.(resolved.instance.instanceId);
  const upHost = up?.host ?? 'localhost';
  const upPort = up?.port ?? resolved.instance.port;
  const targetUrl = `http://${upHost}:${upPort}${requestPath}${reqUrl.search}`;

  try {
    const headers = new Headers(request.headers);
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

    return new Response(upstream.body, {
      status:  upstream.status,
      headers: upstream.headers,
    });
  } catch (err) {
    return jsonError(`Provider upstream error: ${String(err)}`, 502);
  }
};

function identifySource(referer: string | null, mgr: ReturnType<typeof getAppManager>): string {
  if (!referer) return 'system';
  try {
    const url = new URL(referer);
    const match = url.pathname.match(/^\/api\/proxy\/([^/]+)\//);
    if (!match) return 'system';
    const idOrInstanceId = match[1]!;
    // The proxy id can be either an instanceId or a bare appId
    const inst = mgr.getInstance(idOrInstanceId) ?? mgr.getInstancesByApp(idOrInstanceId)[0];
    return inst?.appId ?? idOrInstanceId;
  } catch {
    return 'system';
  }
}

function jsonError(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
