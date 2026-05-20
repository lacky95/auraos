/**
 * `proxyFetch` — safe fetch + Response copier for apps proxying upstream
 * HTTP services through their own Astro API routes.
 *
 * Why this exists:
 *   Node's built-in `fetch` (undici) transparently decompresses gzip / br /
 *   deflate responses, but it leaves the upstream `Content-Encoding` and
 *   `Content-Length` headers describing the *compressed* bytes that no
 *   longer exist in the body it hands you. Forwarding those headers makes
 *   the downstream consumer (browser, shell proxy, curl) try to decompress
 *   already-decompressed bytes — symptoms: blank iframes, garbage HTML,
 *   "incorrect header check" errors.
 *
 *   The fix is one line of header manipulation, but every app that proxies
 *   an upstream service reinvents it (and forgets it the first time).
 *   This helper bakes it in.
 *
 * Behaviour:
 *   - Drops `Content-Encoding` and `Content-Length` from the forwarded
 *     headers (undici decompressed, so neither value is true any more).
 *   - Strips the standard hop-by-hop header set (RFC 7230) so the upstream
 *     can't confuse the downstream proxy chain.
 *   - Returns a fresh `Response` whose body is the already-decoded
 *     upstream body, ready to `return` from an `APIRoute`.
 *
 * Usage in an Astro APIRoute:
 *   import { proxyFetch } from '@aura/app-sdk/proxy';
 *   export const GET: APIRoute = async ({ request, params }) => {
 *     const upstream = `https://upstream.example.com/${params.path ?? ''}`;
 *     return proxyFetch(upstream, request);
 *   };
 *
 * It is deliberately a thin wrapper. Apps that need to rewrite URLs in the
 * body, inject scripts, or merge custom headers can call `proxyFetch.raw`
 * to get the unwrapped upstream Response + a `sanitizeHeaders` helper and
 * compose themselves.
 */

const HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
] as const;

/** Headers that lie about the body after undici decompressed it. */
const STALE_AFTER_DECOMPRESSION = ['content-encoding', 'content-length'] as const;

export interface ProxyFetchOptions {
  /**
   * Whether to forward request headers to the upstream. When `true` (the
   * default) the inbound headers are passed through verbatim except for
   * Host / Connection / Content-Length which are recomputed by `fetch`.
   * Set to `false` for fully decoupled passthrough (auth tokens etc. stay
   * on the gateway, not on the upstream).
   */
  forwardRequestHeaders?: boolean;
  /** Extra headers to merge into the upstream request. */
  extraRequestHeaders?: HeadersInit;
  /** Extra headers to merge into the downstream response. */
  extraResponseHeaders?: HeadersInit;
}

/**
 * Strip hop-by-hop + post-decompression headers from a Headers instance.
 * Returns a fresh Headers, never mutates the input.
 */
export function sanitizeHeaders(input: Headers): Headers {
  const out = new Headers(input);
  for (const h of HOP_BY_HOP) out.delete(h);
  for (const h of STALE_AFTER_DECOMPRESSION) out.delete(h);
  return out;
}

/**
 * Forward an Astro route's inbound Request to an upstream URL and return a
 * sanitised Response. See module docstring for the gzip-bug it prevents.
 */
export async function proxyFetch(
  upstreamUrl: string | URL,
  request: Request,
  opts: ProxyFetchOptions = {},
): Promise<Response> {
  const headers = opts.forwardRequestHeaders === false
    ? new Headers()
    : new Headers(request.headers);
  // Host is computed by fetch from the URL — forwarding the inbound Host
  // would make the upstream think it's serving a different vhost.
  headers.delete('host');
  // Same story for hop-by-hop on the OUTBOUND side: most are forbidden
  // request headers in fetch (it'll silently drop them) but stripping
  // explicitly avoids the warning spam.
  for (const h of HOP_BY_HOP) headers.delete(h);
  if (opts.extraRequestHeaders) {
    new Headers(opts.extraRequestHeaders).forEach((v, k) => headers.set(k, v));
  }

  const upstreamRes = await fetch(upstreamUrl, {
    method:  request.method,
    headers,
    body:    methodAllowsBody(request.method) ? request.body : undefined,
    // duplex is required by undici when streaming a body. TS lib.dom.d.ts
    // doesn't know about it yet — cast through unknown to silence.
    ...(methodAllowsBody(request.method) ? ({ duplex: 'half' } as unknown as RequestInit) : {}),
    redirect: 'manual',
  });

  const outHeaders = sanitizeHeaders(upstreamRes.headers);
  if (opts.extraResponseHeaders) {
    new Headers(opts.extraResponseHeaders).forEach((v, k) => outHeaders.set(k, v));
  }

  return new Response(upstreamRes.body, {
    status:     upstreamRes.status,
    statusText: upstreamRes.statusText,
    headers:    outHeaders,
  });
}

/**
 * Escape hatch for apps that need to inspect or rewrite the upstream body.
 * Returns the raw `Response` plus a pre-sanitised Headers copy ready to
 * merge into the final response.
 *
 *   const { upstream, headers } = await proxyFetch.raw(url, request);
 *   const text = await upstream.text();
 *   return new Response(text.replace(/foo/g, 'bar'), { headers });
 */
proxyFetch.raw = async function rawProxyFetch(
  upstreamUrl: string | URL,
  request: Request,
  opts: ProxyFetchOptions = {},
): Promise<{ upstream: Response; headers: Headers }> {
  const res = await proxyFetch(upstreamUrl, request, opts);
  // proxyFetch already sanitised — clone so the caller gets a streamable
  // body AND a Headers it can mutate without affecting the returned res.
  return { upstream: res.clone(), headers: new Headers(res.headers) };
};

function methodAllowsBody(method: string): boolean {
  const m = method.toUpperCase();
  return m !== 'GET' && m !== 'HEAD';
}
