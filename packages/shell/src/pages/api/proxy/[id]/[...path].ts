import type { APIRoute } from 'astro';
import { getAppManager } from '@aura/core';

/**
 * Reverse-proxy to a running app instance.
 *
 * Path param `id` may be either:
 *   - a bare appId (e.g. "com.aura.terminal") — resolves to the first running instance
 *   - an instanceId (e.g. "com.aura.terminal-2") — resolves to that exact backend process
 *
 * Activity routing is done via the `_aura_activity` query parameter:
 *   /api/proxy/com.aura.notepad/?_aura_activity=com.aura.notepad%23a3
 * The proxy strips `_aura_activity` from the upstream URL and sets it as
 * `X-Aura-Activity-Id` header on the upstream request. Apps that don't
 * care about activities can ignore the header.
 */
export const ALL: APIRoute = async ({ params, request }) => {
  const id   = params['id'];
  const path = params['path'] ?? '';

  if (!id) return new Response('Missing instance id', { status: 400 });

  const mgr = getAppManager();
  const instance = mgr.getInstance(id) ?? mgr.getInstancesByApp(id)[0];

  if (!instance?.port) {
    return new Response(notReadyHtml(id), {
      status: 503,
      headers: { 'Content-Type': 'text/html' },
    });
  }

  // Strip _aura_activity from query before forwarding upstream
  const reqUrl = new URL(request.url);
  const activityId = reqUrl.searchParams.get('_aura_activity');
  if (activityId !== null) reqUrl.searchParams.delete('_aura_activity');
  const search = reqUrl.search; // includes '?' or empty

  const targetUrl = `http://localhost:${instance.port}/${path}${search}`;

  try {
    const headers = new Headers(request.headers);
    headers.set('X-Aura-App-Id', instance.appId);
    headers.set('X-Aura-Instance-Id', instance.instanceId);
    if (activityId) headers.set('X-Aura-Activity-Id', activityId);
    headers.delete('host');

    const upstream = await fetch(targetUrl, {
      method:  request.method,
      headers,
      body:    ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      signal:  AbortSignal.timeout(30_000),
      // @ts-expect-error Node fetch supports this
      duplex: 'half',
    });

    return new Response(upstream.body, {
      status:  upstream.status,
      headers: upstream.headers,
    });
  } catch {
    return new Response(notReadyHtml(id), {
      status: 502,
      headers: { 'Content-Type': 'text/html' },
    });
  }
};

function notReadyHtml(id: string): string {
  return `<!DOCTYPE html><html><head><style>
    body{background:#0a0a0a;color:#557755;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}
    .msg{text-align:center;} .id{color:#00ff41;font-size:1.1em;}
    </style></head><body><div class="msg">
      <div class="id">${id}</div>
      <div>NOT READY — WAITING FOR PROCESS...</div>
    </div></body></html>`;
}
