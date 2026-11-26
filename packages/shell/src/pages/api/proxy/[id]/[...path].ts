import { APP_HOST_ROUTE_HEADER, lifecycleRequestPath } from '@aura/core/host-rules';
import type { APIContext, APIRoute } from 'astro';
import { browserDocumentRequest, plainProxyPath } from '../../../../../server/host-policy.mjs';
import { dropServiceWorkerScope, stripShellCredentials } from '../../../../../server/shell-credentials.mjs';
import { getAppManager, resolveProxyConfig, INTERFACE_PATH_KINDS, RELAY_CLAIM_HEADER } from '@aura/core';
import { relayCaller, relayClaimFor, type RelaySigner } from '../../../../lib/access/relay.ts';

/**
 * The machine proxy: a call to a running app's server, for machine callers
 * only. Agents' MCP URLs (`/api/proxy/com.aura.docs/mcp`), lifecycle probes,
 * one app's server calling another, the shell's own fetches.
 *
 * Path param `id` may be either:
 *   - a bare appId (e.g. "com.aura.terminal") — the first running instance
 *   - an instanceId (e.g. "com.aura.terminal-2") — that exact backend process
 *
 * The `/api/proxy/<id>` prefix is stripped, and the body passes through
 * untouched. An app's `/api/lifecycle/*` routes are the kernel's alone (the
 * runner calls them directly, with the lifecycle token): refused here. It is never executable browser content on the shell's origin
 * (D40, D43): a navigation or frame load is refused, responses carry no
 * cookies and a `sandbox` policy. An app's pages are served on its own App
 * Host (server/app-hosts.mjs).
 */
export const ALL: APIRoute = async (ctx) => machineOnly(dropServiceWorkerScope(await forward(ctx)));

/**
 * appId → in-flight cold-start. Collapses concurrent cold calls (e.g. several
 * MCP clients initializing at once) into a single AppManager.start(), which
 * resolves only once the instance is resumed with a port — no state polling
 * needed. Capped so a wedged start can't hold every later request hostage.
 */
const coldStarts = new Map<string, Promise<unknown>>();
const COLD_START_TIMEOUT_MS = 30_000;

function ensureInstance(mgr: ReturnType<typeof getAppManager>, appId: string): Promise<unknown> {
  let p = coldStarts.get(appId);
  if (!p) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = mgr.start(appId);
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${COLD_START_TIMEOUT_MS}ms`)), COLD_START_TIMEOUT_MS);
    });
    p = Promise.race([started, timeout])
      .finally(() => { clearTimeout(timer); coldStarts.delete(appId); });
    started.catch(() => {}); // the race surfaces the rejection; keep the loser from tripping unhandledRejection
    coldStarts.set(appId, p);
  }
  return p;
}

function jsonError(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/**
 * Whatever the app answered, the browser can't run it on the shell's origin:
 * no cookie for the shell's origin, no sniffing, a sandboxed opaque origin if
 * it is ever rendered, and no cross-origin embedding.
 */
function machineOnly(res: Response): Response {
  try {
    res.headers.delete('set-cookie');
    res.headers.set('Content-Security-Policy', 'sandbox');
    res.headers.set('X-Content-Type-Options', 'nosniff');
    res.headers.set('Cross-Origin-Resource-Policy', 'same-origin');
    return res;
  } catch {
    // Immutable headers: copy into a response we own.
    const headers = new Headers(res.headers);
    headers.delete('set-cookie');
    headers.set('Content-Security-Policy', 'sandbox');
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Cross-Origin-Resource-Policy', 'same-origin');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
}

const forward = async ({ params, request, locals }: APIContext): Promise<Response> => {
  const id   = params['id'];
  const path = params['path'] ?? '';

  if (!id) return jsonError(400, { error: 'missing-instance-id' });
  // H1: the upstream must get the path the access rules judged.
  if (!plainProxyPath(new URL(request.url).pathname)) return jsonError(400, { error: 'unplain-proxy-path' });

  // A browser loading this as a page, frame or worker: never on this origin.
  if (browserDocumentRequest(request.method, (name: string) => request.headers.get(name) ?? undefined)) {
    return jsonError(403, {
      error: 'browser-document-refused',
      message: 'App pages open on their App Host, from the AuraOS desktop. /api/proxy serves machine calls only.',
    });
  }

  // Lifecycle hooks and health belong to the kernel's runner, never a caller.
  const reqUrl = new URL(request.url);
  const upstreamPrefix = `/api/proxy/${id}/`;
  const forwardPath = reqUrl.pathname.startsWith(upstreamPrefix)
    ? reqUrl.pathname.slice(upstreamPrefix.length)
    : path;
  if (lifecycleRequestPath('/' + forwardPath) !== null || lifecycleRequestPath('/' + path) !== null) {
    return jsonError(403, {
      error: 'lifecycle-path-refused',
      message: 'An app\'s /api/lifecycle routes are called by AuraOS only.',
    });
  }

  const mgr = getAppManager();
  // Prefer a live exact-instanceId match; fall back to the first non-dead
  // instance of the bare appId. Skipping error/destroyed instances avoids
  // routing to a stale port that the PortAllocator may have already handed
  // to another app.
  const isLive = (state: string) =>
    state !== 'error' && state !== 'destroyed' && state !== 'destroying';

  // Resolution rules:
  //   - Exact instanceId match: serve it (even if it's a pool member — that
  //     only happens when something inside the AppManager hands the id out,
  //     e.g. immediately after claimFromPool returns).
  //   - Bare appId match: pick a USER-OWNED live instance (skip inPool=true),
  //     never a pool member that hasn't been handed over yet, nor a preview
  //     (Track P: it is reached by its own instance id and App Host only).
  const exact = mgr.getInstance(id);
  let instance = exact && isLive(exact.state)
    ? exact
    : mgr.getInstancesByApp(id).find((i) => !i.inPool && !i.preview && isLive(i.state) && i.port != null);

  if (!instance?.port) {
    // Cold-start: a bare-appId request for a path the app's manifest declares
    // as a provided interface (e.g. the terminal's /mcp/terminal) starts an
    // instance instead of 503ing — the app-level interface alias in the
    // registry promises exactly this. The provides gate keeps stray probes
    // from spawning containers, and an exact-instanceId request for a dead
    // instance stays 503 (getManifest only resolves bare appIds) rather than
    // silently becoming a different instance.
    const coldManifest = mgr.getManifest(id);
    const reqPath = '/' + path;
    const servesPath = coldManifest?.provides.some((p) =>
      INTERFACE_PATH_KINDS.has(p.kind)
      && (reqPath === p.address || reqPath.startsWith(p.address + '/')));
    if (servesPath) {
      try {
        await ensureInstance(mgr, id);
        instance = mgr.getInstancesByApp(id)
          .find((i) => !i.inPool && !i.preview && isLive(i.state) && i.port != null);
      } catch (err) {
        console.error(`[proxy] cold-start of ${id} failed: ${(err as Error).message}`);
      }
    }
    if (!instance?.port) return jsonError(503, { error: 'not-ready', id });
  }

  // Services are headless by contract. The OS exposes their API surface
  // (lifecycle, content providers, custom /api endpoints) here, but nothing
  // else, unless the manifest opens a protocol path (`proxy.exposeAllPaths`,
  // e.g. the registry's /v2/ for OCI clients).
  const manifest = mgr.getManifest(instance.appId) ?? null;
  if (manifest?.componentType === 'service' && !resolveProxyConfig(manifest).exposeAllPaths
    && !path.startsWith('api/') && !path.startsWith('_aura_')) {
    return jsonError(403, {
      error: 'service-has-no-ui',
      message: `${instance.appId} is a service (componentType='service'). Only its /api/ paths are reachable here.`,
      appId: instance.appId,
      instanceId: instance.instanceId,
      blockedPath: '/' + path,
    });
  }

  // For container-sandbox instances, the upstream lives on the shared docker
  // network with a hostname like `aura-com.aura.terminal-3`. For PRoot-
  // sandbox instances it's 127.0.0.1. getUpstreamUrl encapsulates the choice.
  const up = mgr.getUpstreamUrl?.(instance.instanceId);
  const upHost = up?.host ?? 'localhost';
  const upPort = up?.port ?? instance.port;
  // Astro's `[...path]` param drops a trailing page-format extension (a
  // request for `.../blank.html` arrives as `.../blank`), so the forwarded
  // path comes from `reqUrl.pathname` (above), which keeps it.
  const targetUrl = `http://${upHost}:${upPort}/${forwardPath}${reqUrl.search}`;

  try {
    const headers = stripShellCredentials(new Headers(request.headers), 'proxy-http');
    headers.delete(APP_HOST_ROUTE_HEADER);
    headers.set('X-Aura-App-Id', instance.appId);
    headers.set('X-Aura-Instance-Id', instance.instanceId);
    // D89 B4: to an owner-agent app, the shell's relay claim (who it authorized), never the caller's credential.
    const relay = relayClaimFor(mgr as unknown as RelaySigner, {
      appId: instance.appId, instanceId: instance.instanceId, method: request.method, path: `/${forwardPath}${reqUrl.search}`,
    }, relayCaller(locals?.access?.principal));
    if (relay) headers.set(RELAY_CLAIM_HEADER, relay);

    // Tell the app which origin the caller used, before we drop the Host
    // header, so absolute URLs it builds don't name `aura-<instance>:<port>`,
    // which exists only on aura-net. Standard names, so a framework behind a
    // reverse proxy picks them up with its normal config. X-Forwarded-Prefix
    // is deliberately NOT set: apps receive the prefix-stripped path.
    const fwdHost  = request.headers.get('host') ?? reqUrl.host;
    const fwdProto = reqUrl.protocol.replace(':', '');
    if (fwdHost) headers.set('X-Forwarded-Host', fwdHost);
    headers.set('X-Forwarded-Proto', fwdProto);
    const fwdPort = fwdHost?.includes(':') ? fwdHost.split(':').pop() : (fwdProto === 'https' ? '443' : '80');
    if (fwdPort) headers.set('X-Forwarded-Port', fwdPort);
    headers.delete('host');

    // The caller's abort signal keeps streams (SSE, long-poll) alive exactly
    // as long as the caller does. 3xx goes back to the caller unchanged except
    // for its Location (below): a POST body is a stream undici can't replay.
    const hasBody = !['GET', 'HEAD'].includes(request.method);
    const upstream = await fetch(targetUrl, {
      method:  request.method,
      headers,
      body:    hasBody ? request.body : undefined,
      signal:  request.signal,
      redirect: 'manual',
      // @ts-expect-error Node fetch supports this
      duplex: 'half',
    });

    // Identity gate: the upstream must echo X-Aura-App-Id (and, when set, the
    // instance id) matching the instance we resolved against. A mismatch means
    // another process is squatting our port — refuse to forward.
    const declaredApp  = upstream.headers.get('x-aura-app-id');
    const declaredInst = upstream.headers.get('x-aura-instance-id');
    if (declaredApp && declaredApp !== instance.appId) {
      console.error(`[proxy] identity mismatch routing ${id}: expected appId=${instance.appId} but upstream on port ${instance.port} declared ${declaredApp}. Refusing to forward.`);
      try { upstream.body?.cancel(); } catch { /* ignore */ }
      return jsonError(502, { error: 'identity-mismatch', id });
    }
    if (declaredInst && declaredInst !== instance.instanceId) {
      console.error(`[proxy] instance-id mismatch routing ${id}: expected ${instance.instanceId} but upstream declared ${declaredInst}.`);
      try { upstream.body?.cancel(); } catch { /* ignore */ }
      return jsonError(502, { error: 'identity-mismatch', id });
    }

    // Node's fetch() decodes the body but keeps Content-Encoding; the length
    // no longer matches either.
    const outHeaders = new Headers(upstream.headers);
    outHeaders.delete('content-encoding');
    outHeaders.delete('content-length');

    // A redirect's Location must be one the caller can follow: upstream names
    // its own origin (`http://aura-<instance>:4002/…`) or root paths that
    // escape this prefix. Both go back under `/api/proxy/<id>/…`; an off-site
    // absolute URL (an OAuth provider, say) is left exactly as is.
    if (upstream.status >= 300 && upstream.status < 400) {
      const loc = upstream.headers.get('location');
      const proxyPrefix = `/api/proxy/${id}`;
      let next: string | null = null;
      if (loc?.startsWith('/') && !loc.startsWith('//')) next = loc;
      else if (loc && /^https?:\/\//i.test(loc)) {
        try {
          const u = new URL(loc);
          if (u.host === `${upHost}:${upPort}`) next = `${u.pathname}${u.search}${u.hash}`;
        } catch { /* malformed Location: leave it alone */ }
      }
      if (next !== null && !next.startsWith(`${proxyPrefix}/`) && next !== proxyPrefix) next = `${proxyPrefix}${next}`;
      if (next !== null) outHeaders.set('location', next);
    }

    return new Response(upstream.body ? wrapSafeStream(upstream.body) : null, {
      status:  upstream.status,
      headers: outHeaders,
    });
  } catch (err) {
    if (isExpectedAbort(err)) return new Response(null, { status: 499 });
    console.error(`[proxy] fetch failed routing ${id} → ${targetUrl}: ${(err as Error).message}`);
    return jsonError(502, { error: 'upstream-failed', id });
  }
};

/**
 * Wrap an upstream `ReadableStream` so that aborts / socket terminations
 * during forwarding don't bubble up as uncaught errors. These happen
 * constantly during normal operation — every time a caller drops an SSE
 * stream, the proxy aborts the upstream fetch, undici tears down the socket,
 * and the read throws `TypeError: terminated` or a `UND_ERR_SOCKET`. We close
 * the stream cleanly instead so the response pipeline doesn't log noise.
 */
function wrapSafeStream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) { controller.close(); return; }
        controller.enqueue(value);
      } catch (err) {
        if (isExpectedAbort(err)) { controller.close(); return; }
        controller.error(err);
      }
    },
    cancel(reason) { reader.cancel(reason).catch(() => { /* ignore */ }); },
  });
}

function isExpectedAbort(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; code?: string; message?: string; cause?: { code?: string; name?: string } };
  if (e.name === 'AbortError') return true;
  if (e.code === 'UND_ERR_SOCKET' || e.code === 'UND_ERR_ABORTED') return true;
  if (typeof e.message === 'string' && /terminated|aborted|socket hang up/i.test(e.message)) return true;
  if (e.cause && (e.cause.code === 'UND_ERR_SOCKET' || e.cause.code === 'UND_ERR_ABORTED' || e.cause.name === 'AbortError')) return true;
  return false;
}
