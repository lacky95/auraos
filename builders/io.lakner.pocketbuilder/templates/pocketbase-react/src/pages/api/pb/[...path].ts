/**
 * Reverse proxy: /pb/<path> → the PocketBase sibling container.
 *
 * The browser can only reach this app through the OS proxy
 * (/api/proxy/<instanceId>/…), and the sibling is only addressable on the
 * internal `aura-net` network — so all PocketBase traffic (REST API and the
 * admin UI) hops through here. The frontend talks to a relative `/api/pb`
 * base and never needs to know the container name.
 */
import type { APIRoute } from 'astro';
import { pbBase } from '../../../lib/pocketbase.ts';

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'host', 'content-length']);

const proxy: APIRoute = async ({ params, request }) => {
  const path  = params['path'] ?? '';
  const query = new URL(request.url).search;
  const target = `${pbBase()}/${path}${query}`;

  const headers = new Headers();
  for (const [k, v] of request.headers) if (!HOP_BY_HOP.has(k.toLowerCase())) headers.set(k, v);

  try {
    const upstream = await fetch(target, {
      method:  request.method,
      headers,
      body:    ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer(),
      redirect: 'manual',
      signal:  AbortSignal.timeout(30_000),
    });
    const out = new Headers();
    for (const [k, v] of upstream.headers) if (!HOP_BY_HOP.has(k.toLowerCase())) out.set(k, v);
    return new Response(upstream.body, { status: upstream.status, headers: out });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: 'pocketbase-unreachable', message: (err as Error).message, target }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    );
  }
};

export const GET     = proxy;
export const POST    = proxy;
export const PUT     = proxy;
export const PATCH   = proxy;
export const DELETE  = proxy;
export const OPTIONS = proxy;
