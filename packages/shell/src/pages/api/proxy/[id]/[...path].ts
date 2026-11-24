import { APP_HOST_ROUTE_HEADER } from '@aura/core/host-rules';
import type { APIContext, APIRoute } from 'astro';
import { dropServiceWorkerScope, stripShellCredentials } from '../../../../../server/shell-credentials.mjs';
import { getAppManager, ThemeManager, keymapRegistry, resolveProxyConfig, INTERFACE_PATH_KINDS } from '@aura/core';
import type { AppManifest, ProxyConfig } from '@aura/core';
import { sharedKv } from '../../../../lib/sharedKv.js';
import { SYNTHETIC_RECEIVER_JS } from '../../../../lib/keyboard/receiverScript.js';
import { NATIVE_KEYBOARD_JS } from '../../../../lib/keyboard/nativeKeyboardScript.js';
import { FRAME_RELAY_JS } from '../../../../lib/keyboard/frameRelayScript.js';
import { readShellKeymapState, readShellThemeSelection, resolveBindings } from '../../../../lib/appDocumentState.js';
import { consoleRelayJs, focusOnClickJs, INPUT_COMPAT_JS, keyForwarderJs, sseMuxJs } from '../../../../lib/appDocumentScripts.js';

/**
 * Absolute import URLs Vite emits inside served JS modules. Rewritten to the
 * app's proxy prefix (see the JS branch of the handler). `/@react-refresh` is
 * a bare virtual module (no path segment after it) that @astrojs/react's
 * before-hydration script imports in dev; without it a React island never
 * mounts (the browser asks the shell root and gets 404).
 */
const JS_IMPORT_RE = /(["'`])(\/(?:(?:@fs|@vite|@id|node_modules|src)\/[^"'`\s]*|@react-refresh))\1/g;

/**
 * Version of this proxy's response rewriting, derived from the rules above
 * and mixed into every ETag the proxy hands out. The app's ETag covers the
 * app's bytes, not ours: when the rewrite changes, a browser that revalidates
 * with the app's tag gets a 304 and keeps the body the OLD rewrite produced
 * (how a fix to the import rewriter stayed invisible until caches were
 * cleared). With the version in the tag, a stale cache misses once and is
 * refilled; after that revalidation works as before.
 */
const REWRITE_VERSION = (() => {
  let h = 0x811c9dc5;
  for (const ch of `${JS_IMPORT_RE.source}|1`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return h.toString(36);
})();
const REWRITE_TAG_SUFFIX = `.${REWRITE_VERSION}"`;

/** Stamp the proxy's rewrite version into a response's ETag (idempotent). */
function tagEtag(headers: Headers): void {
  const etag = headers.get('etag');
  if (etag && etag.endsWith('"') && !etag.endsWith(REWRITE_TAG_SUFFIX)) headers.set('etag', etag.slice(0, -1) + REWRITE_TAG_SUFFIX);
}

/**
 * Fallback proxy config for the corner case where the AppManager can't
 * resolve a manifest (race during pool warm-up / app reload). Mirrors the
 * historical Astro-default behaviour so we never silently strip injection.
 */
const DEFAULT_PROXY_CONFIG: ProxyConfig = {
  rewriteHtml:          'astro',
  preservePrefix:       false,
  injectMeta:           true,
  injectConsoleRelay:   true,
  injectKeyForwarder:   true,
  injectIdentityScript: true,
  injectInputCompat:    true,
  injectEventSourceMux: true,
  exposeAllPaths:       false,
};

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
export const ALL: APIRoute = async (ctx) => dropServiceWorkerScope(await forward(ctx));

const forward = async ({ params, request }: APIContext): Promise<Response> => {
  const id   = params['id'];
  const path = params['path'] ?? '';

  if (!id) return new Response('Missing instance id', { status: 400 });

  const mgr = getAppManager();
  // Prefer a live exact-instanceId match; fall back to the first non-dead
  // instance of the bare appId. Skipping error/destroyed instances avoids
  // routing to a stale port that the PortAllocator may have already handed
  // to another app — that mismatch is how App A's iframe ends up showing
  // App B's content after a crash.
  const isLive = (state: string) =>
    state !== 'error' && state !== 'destroyed' && state !== 'destroying';

  // Resolution rules:
  //   - Exact instanceId match: serve it (even if it's a pool member — that
  //     only happens when something inside the AppManager hands the id out,
  //     e.g. immediately after claimFromPool returns).
  //   - Bare appId match: pick a USER-OWNED live instance (skip inPool=true).
  //     Otherwise a freshly-launched iframe would race the AppManager's claim
  //     and route to a pool member that hasn't been handed over yet, leaving
  //     the user's view pointing at an instance the AppManager doesn't think
  //     they own.
  const exact = mgr.getInstance(id);
  let instance = exact && isLive(exact.state)
    ? exact
    : mgr.getInstancesByApp(id).find((i) => !i.inPool && isLive(i.state) && i.port != null);

  if (!instance?.port) {
    // Cold-start: a bare-appId request for a path the app's manifest declares
    // as a provided interface (e.g. the terminal's /mcp/terminal) starts an
    // instance instead of 503ing — the app-level interface alias in the
    // registry promises exactly this. The provides gate keeps stale iframes
    // and asset probes from spawning containers, and an exact-instanceId
    // request for a dead instance stays 503 (getManifest only resolves bare
    // appIds) rather than silently becoming a different instance.
    const coldManifest = mgr.getManifest(id);
    const reqPath = '/' + path;
    const servesPath = coldManifest?.provides.some((p) =>
      INTERFACE_PATH_KINDS.has(p.kind)
      && (reqPath === p.address || reqPath.startsWith(p.address + '/')));
    if (servesPath) {
      try {
        await ensureInstance(mgr, id);
        instance = mgr.getInstancesByApp(id)
          .find((i) => !i.inPool && isLive(i.state) && i.port != null);
      } catch (err) {
        console.error(`[proxy] cold-start of ${id} failed: ${(err as Error).message}`);
      }
    }
    if (!instance?.port) {
      return notReadyResponse(id, path, 503);
    }
  }

  // Architectural guard: services are headless by contract. The OS exposes
  // their API surface (lifecycle, content providers, custom /api endpoints)
  // through the proxy, but NOT their HTML root or any static asset. Even if
  // a caller hand-crafts `/api/proxy/<service-id>/` into an <iframe src>, the
  // OS refuses — the only legitimate way for a service to surface UI is to
  // dispatch an intent (`AppManager.startIntent`) that resolves to a
  // separate `componentType: 'activity'` app. Mirrors the SSR-time guard in
  // packages/shell/src/pages/index.astro that already filters services out
  // of initialViews + workspace.members.
  const manifest: AppManifest | null = mgr.getManifest(instance.appId) ?? null;
  // Resolve the per-app proxy behaviour once. Apps with `runtime: 'raw'` get
  // a near pass-through default (no <base>, no attribute rewriting); Astro
  // apps keep the full inject pipeline. Each flag is overridable per manifest.
  const cfg: ProxyConfig = manifest ? resolveProxyConfig(manifest) : DEFAULT_PROXY_CONFIG;
  if (manifest?.componentType === 'service' && !cfg.exposeAllPaths && !path.startsWith('api/') && !path.startsWith('_aura_')) {
    const payload = {
      error: 'service-has-no-ui',
      message: `${instance.appId} is a service (componentType='service'). Services are headless and cannot be rendered. Use an intent (or a separate activity-component app) to show UI.`,
      appId:      instance.appId,
      instanceId: instance.instanceId,
      blockedPath: '/' + path,
    };
    // Browsers (iframes navigating to a service URL by mistake) get a themed
    // HTML page so the warning is rendered in the OS palette instead of as
    // raw JSON text. API clients (curl, fetch, content-provider probes)
    // keep getting structured JSON for programmatic handling.
    const acceptsHtml = (request.headers.get('accept') ?? '').includes('text/html');
    if (acceptsHtml) {
      return new Response(renderServiceBlockedHtml(payload), {
        status: 403,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }
    return new Response(JSON.stringify(payload, null, 2), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Short-circuit Vite's HMR client: the iframe can't reach the upstream's WS
  // port, so the real client would just flood the console with reconnect
  // errors. We return a stub ES module that exports no-op versions of the
  // names Vite-transformed code imports (createHotContext, updateStyle, …)
  // so imports don't fail with `doesn't provide an export named 'X'`.
  if (path === '@vite/client' || path === '@vite/env' || path.startsWith('@vite/')) {
    const stub = `
// AuraOS proxy stub for /@vite/* — the real Vite HMR client can't reach the
// upstream's WS port from inside the iframe. HMR-side exports are no-ops
// (page works fine without HMR; full iframe reload picks up code changes),
// BUT updateStyle/removeStyle actually mount/unmount <style> tags: when
// an app does \`import 'pkg/foo.css'\`, Vite compiles the CSS-through-a-JS
// module that calls updateStyle(id, css) → without a real impl, npm-
// installed CSS (e.g. xterm.css) never enters the DOM and the widget
// renders unstyled. The impl below mirrors Vite's own client.
const __aura_styles = new Map();
export function updateStyle(id, content) {
  if (typeof document === 'undefined') return;
  let el = __aura_styles.get(id);
  if (!el) {
    el = document.createElement('style');
    el.setAttribute('type', 'text/css');
    el.setAttribute('data-vite-dev-id', id);
    document.head.appendChild(el);
    __aura_styles.set(id, el);
  }
  el.textContent = content;
}
export function removeStyle(id) {
  const el = __aura_styles.get(id);
  if (el) { el.remove(); __aura_styles.delete(id); }
}
export function createHotContext() {
  return {
    accept(){}, acceptExports(){}, acceptDeps(){}, dispose(){}, prune(){},
    decline(){}, invalidate(){}, on(){}, off(){}, send(){}, data:{},
  };
}
export function injectQuery(url){ return url; }
export const ErrorOverlay = class extends (typeof HTMLElement !== 'undefined' ? HTMLElement : Object) {};
export const overlay = false;
export const hot = { send(){}, on(){}, off(){} };
export default {};
`;
    return new Response(stub, {
      status: 200,
      headers: {
        'Content-Type': 'application/javascript',
        'Cache-Control': 'no-store',
      },
    });
  }

  // Strip _aura_activity from query before forwarding upstream
  const reqUrl = new URL(request.url);
  const activityId = reqUrl.searchParams.get('_aura_activity');
  if (activityId !== null) reqUrl.searchParams.delete('_aura_activity');

  // The HTML rewriter below escapes Vite virtual-module query markers so the
  // shell's own Vite middleware doesn't try to compile them as its modules.
  // Restore them before forwarding upstream so the app's Vite recognises them.
  let search = reqUrl.search;
  search = search
    .replace(/(\?|&)_aura_vite_astro=1(?=&|$)/g, '$1astro')
    .replace(/(\?|&)_aura_vite_vue(?=&|=|$)/g,   '$1vue')
    .replace(/(\?|&)_aura_vite_svelte(?=&|=|$)/g,'$1svelte');

  // For container-sandbox instances, the upstream lives on the shared docker
  // network with a hostname like `aura-com.aura.terminal-3`. For PRoot-
  // sandbox instances it's 127.0.0.1. getUpstreamUrl encapsulates the choice.
  const up = mgr.getUpstreamUrl?.(instance.instanceId);
  const upHost = up?.host ?? 'localhost';
  const upPort = up?.port ?? instance.port;
  // `preservePrefix` keeps the `/api/proxy/<id>` segment in the URL we send
  // upstream. Needed by Next.js apps whose `basePath` config expects to see
  // the proxy prefix on every request — without it we'd lose a round-trip
  // to a 308 redirect chain back to the prefixed URL.
  // Astro's `[...path]` param drops a trailing page-format extension: a request
  // for `.../blank.html` arrives with `params.path` === `.../blank`, so
  // forwarding the param would strip the `.html` and upstream 404s. (This broke
  // Guacamole's resize sensor — an `<object data=".../app/element/templates/blank.html">`
  // whose load failure meant window resizes never reached the remote session.)
  // `reqUrl.pathname` keeps the extension, so derive the forwarded path from it,
  // falling back to the param if the expected prefix isn't present.
  const upstreamPrefix = `/api/proxy/${id}/`;
  const forwardPath = reqUrl.pathname.startsWith(upstreamPrefix)
    ? reqUrl.pathname.slice(upstreamPrefix.length)
    : path;
  // With preservePrefix the upstream wants the URL exactly as the browser
  // asked for it — including whether it ended in a slash. Rebuilding it as
  // `api/proxy/<id>/<forwardPath>` always reintroduces the slash, so an app
  // that redirects `/api/proxy/<id>/` → `/api/proxy/<id>` (Astro's
  // trailing-slash normalisation) never gets to serve the target: the shell
  // re-adds the slash, the app redirects again, and the browser loops.
  const upstreamPath = cfg.preservePrefix
    ? reqUrl.pathname.replace(/^\//, '')
    : forwardPath;
  const targetUrl = `http://${upHost}:${upPort}/${upstreamPath}${search}`;

  try {
    const headers = stripShellCredentials(new Headers(request.headers), 'proxy-http');
    headers.delete(APP_HOST_ROUTE_HEADER);
    headers.set('X-Aura-App-Id', instance.appId);
    headers.set('X-Aura-Instance-Id', instance.instanceId);
    if (activityId) headers.set('X-Aura-Activity-Id', activityId);

    // Tell the app which origin the BROWSER actually used, before we drop the
    // Host header. Without this an app sees only `aura-<instance>:<port>` and
    // any absolute URL it builds points at a name that exists solely on
    // aura-net — it leaks into `?next=`/`redirect_uri` style parameters and
    // into anything the app emails, logs or hands to a client. Superset did
    // exactly that: `?next=http://aura-at.oebb.opsconsole:4002/…`, which the
    // browser then cannot follow.
    //
    // Standard names, so a framework behind a reverse proxy (Flask's ProxyFix,
    // Django's USE_X_FORWARDED_HOST, …) picks them up with its normal config.
    // X-Forwarded-Prefix is deliberately NOT set: apps already receive the
    // prefix-stripped path, and a subpath-aware runtime told about the prefix
    // a second time re-applies it and double-prefixes every URL.
    const fwdHost  = request.headers.get('host') ?? reqUrl.host;
    const fwdProto = reqUrl.protocol.replace(':', '');
    if (fwdHost) headers.set('X-Forwarded-Host', fwdHost);
    headers.set('X-Forwarded-Proto', fwdProto);
    // Set the port explicitly too. ProxyFix-style middleware prefers
    // X-Forwarded-Port over the port inside X-Forwarded-Host, and anything
    // between us and the app that adds its own would otherwise contribute the
    // APP's port — which is how `?next=http://127.0.0.1:4002/…` happens even
    // once the host is right.
    const fwdPort = fwdHost?.includes(':') ? fwdHost.split(':').pop() : (fwdProto === 'https' ? '443' : '80');
    if (fwdPort) headers.set('X-Forwarded-Port', fwdPort);
    headers.delete('host');

    // Forward the browser's abort signal so streams (SSE, long-poll) live as
    // long as the iframe keeps the connection open and die cleanly when it
    // doesn't. No hard timeout: localhost-to-localhost won't hang, and a
    // timeout would kill `text/event-stream` after N seconds.
    // Hand every 3xx back to the BROWSER instead of chasing it here. Following
    // redirects inside the proxy breaks two things:
    //
    //   - POST + redirect dies outright. The body is a STREAM and undici
    //     cannot replay a stream onto the redirect target, so the whole fetch
    //     rejects with a bare `fetch failed` and the iframe gets a 502 — i.e.
    //     every server-rendered form login was broken.
    //   - The browser's URL stops matching the content. The proxy quietly
    //     serves the redirect TARGET's html at the ORIGINAL url, so a
    //     client-side router boots on a path that was never the one it was
    //     given and renders the wrong view (or none). Superset lands on its
    //     login page at the app root and the form posts without its CSRF
    //     token, which surfaces as "the password doesn't work".
    //
    // The browser replays or downgrades the request per spec, exactly as it
    // would on any other site, and its URL follows along.
    const hasBody = !['GET', 'HEAD'].includes(request.method);
    // Rewritten-module cache (see jsModuleCache below): ask the app whether
    // our rewritten copy is still current; a 304 is answered from memory.
    // The browser's validator carries our rewrite version (tagEtag). Strip it
    // before the app sees it. One WITHOUT the tag names a body produced by an
    // older rewrite (or by the app directly): do not let the app answer 304
    // for it — fetch in full, and decide below (passthrough compares the
    // app's tag itself; rewritten JS is re-sent).
    const clientEtag = request.headers.get('if-none-match');
    let staleClientEtag: string | undefined;
    if (clientEtag) {
      if (clientEtag.includes(REWRITE_TAG_SUFFIX)) headers.set('if-none-match', clientEtag.split(REWRITE_TAG_SUFFIX).join('"'));
      else { headers.delete('if-none-match'); staleClientEtag = clientEtag; }
    }
    const jsKey = `/api/proxy/${id}|${targetUrl}`;  // scoped per build by jsModuleCache()
    const jsCached = request.method === 'GET' && !headers.get('if-none-match')
      ? jsModuleCache().get(jsKey) : undefined;
    if (jsCached) headers.set('if-none-match', jsCached.etag);
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
    // another process is squatting our port — refuse to forward, otherwise the
    // iframe would render the wrong app's content. The auraIdentityIntegration
    // in @aura/app-sdk adds these headers to every response.
    const declaredApp  = upstream.headers.get('x-aura-app-id');
    const declaredInst = upstream.headers.get('x-aura-instance-id');
    if (declaredApp && declaredApp !== instance.appId) {
      console.error(`[proxy] identity mismatch routing ${id}: expected appId=${instance.appId} but upstream on port ${instance.port} declared ${declaredApp}. Refusing to forward.`);
      try { upstream.body?.cancel(); } catch { /* ignore */ }
      return notReadyResponse(id, path, 502);
    }
    if (declaredInst && declaredInst !== instance.instanceId) {
      console.error(`[proxy] instance-id mismatch routing ${id}: expected ${instance.instanceId} but upstream declared ${declaredInst}.`);
      try { upstream.body?.cancel(); } catch { /* ignore */ }
      return notReadyResponse(id, path, 502);
    }

    const contentType = upstream.headers.get('content-type') ?? '';
    const proxyPrefix = `/api/proxy/${id}`;

    // The 3xx goes to the browser, so its Location has to be a URL the BROWSER
    // can use. Upstream
    // answers with its own origin (`http://aura-<instance>:4002/…`), which
    // resolves to nothing out there, and with root-absolute paths that would
    // escape this app's prefix. Rewrite both back into `/api/proxy/<id>/…`.
    // An off-site absolute URL (an OAuth provider, say) is left exactly as is.
    if (upstream.status >= 300 && upstream.status < 400) {
      const loc = upstream.headers.get('location');
      if (loc) {
        let next: string | null = null;
        if (loc.startsWith('/')) {
          next = loc.startsWith('//') ? null : loc;
        } else if (/^https?:\/\//i.test(loc)) {
          try {
            const u = new URL(loc);
            // Only ours — anything else is a genuine off-site redirect.
            if (u.host === `${upHost}:${upPort}`) next = `${u.pathname}${u.search}${u.hash}`;
          } catch { /* malformed Location: leave it alone */ }
        }
        if (next !== null && !next.startsWith(`${proxyPrefix}/`) && next !== proxyPrefix) {
          next = `${proxyPrefix}${next}`;
        }
        if (next !== null && next !== loc) {
          const outHeaders = new Headers(upstream.headers);
          outHeaders.set('location', next);
          outHeaders.delete('content-encoding');
          outHeaders.delete('content-length');
          scopeCookies(upstream, outHeaders, proxyPrefix);
          try { await upstream.body?.cancel(); } catch { /* ignore */ }
          return new Response(null, { status: upstream.status, headers: outHeaders });
        }
      }
    }

    // Vite virtual-module query markers (e.g. `?astro&type=style`) would be
    // matched by the SHELL's own Vite middleware before the proxy route runs.
    // Rename them so the shell's Vite ignores them; the request handler above
    // restores the original names before forwarding upstream.
    const escapeViteQuery = (val: string) => val
      .replace(/(\?|&)astro(?=&|$)/g,    '$1_aura_vite_astro=1')
      .replace(/(\?|&)vue(?=&|=|$)/g,    '$1_aura_vite_vue')
      .replace(/(\?|&)svelte(?=&|=|$)/g, '$1_aura_vite_svelte');

    // Prefix an absolute URL path with the proxy. Leaves relative, protocol-
    // relative, shell-bound (`/api/*`), and already-prefixed URLs alone.
    const prefixUrl = (val: string): string => {
      if (!val.startsWith('/'))        return val;
      if (val.startsWith('//'))        return val;
      if (val.startsWith('/api/'))     return val;
      if (val.startsWith(proxyPrefix)) return val;
      return `${proxyPrefix}${escapeViteQuery(val)}`;
    };

    // HTML: rewrite src/href/action attributes + inject <base href>.
    // Without this, Astro/Vite-emitted URLs like `/src/pages/foo.astro?astro...`
    // hit the shell and 404.
    if (contentType.includes('text/html')) {
      const baseHref = `${proxyPrefix}/`;
      const html = await upstream.text();

      // Strip Vite's HMR client script tag. Vite always injects it in dev,
      // even with `server.hmr: false`. The client then tries to open a
      // WebSocket to the upstream port from the browser — which can't reach
      // it through the proxy — and floods the console with retry errors
      // (`ws-connection-refused`, `can't access property "send"`, etc.).
      // Apps work fine without the client; only HMR is lost (already gone).
      // Always-on (cheap regex, no false positives for non-Vite apps).
      let rewritten = html.replace(
        /<script\b[^>]*\bsrc=["'][^"']*\/@vite\/client[^"']*["'][^>]*>\s*<\/script>/gi,
        '',
      );

      // Attribute rewriting + <base href> injection are gated by manifest
      // proxy.rewriteHtml. 'astro' = full pipeline (today's default). 'absolute'
      // = rewrite attributes but skip <base href> (basePath-aware SPAs).
      // 'none' = pass-through, no rewriting (raw apps that own their HTML).
      if (cfg.rewriteHtml !== 'none') {
        rewritten = rewritten.replace(
          /\b(src|href|action|component-url|renderer-url|before-hydration-url)\s*=\s*(["'])([^"']*)\2/gi,
          (full, attr, q, val) => {
            const next = prefixUrl(val);
            return next === val ? full : `${attr}=${q}${next}${q}`;
          },
        );
      }
      if (cfg.rewriteHtml === 'astro' && !/<base\s/i.test(rewritten)) {
        rewritten = rewritten.replace(
          /<head(\s[^>]*)?>/i,
          (m) => `${m}<base href="${baseHref}">`,
        );
      }

      // Inject identity + theme metadata so apps + shell can self-describe.
      // The aura-app-id / aura-instance-id pair is ALWAYS emitted — the
      // OSLayout identity guard reads them to verify the iframe loaded our
      // app, not someone else's. The rest sits behind `cfg.injectMeta` so
      // raw apps that own their HTML can opt out of the extra weight.
      const themeStrategy = (manifest?.themeStrategy ?? 'inherit') as 'inherit' | 'themed' | 'override';
      const escAttr = (s: string) => s.replace(/"/g, '&quot;');
      // The proxy URL prefix every iframe is loaded at. SPA frameworks
      // (Next.js, SvelteKit, Nuxt, Angular) need this as their `basePath`
      // so client-side router URLs match the SSR'd href values — without
      // it, hydration mismatches blank the page. Static SSR apps don't
      // need to read this; the existing href rewriter still works for
      // them. Either pattern is supported.
      //
      // Exposed in two redundant places so apps can pick whichever fits
      // their framework's config style:
      //   - `<meta name="aura-app-base-path">`  for build-time / static reads
      //   - `window.AURA_APP_BASE_PATH` global  for runtime reads
      // Plus an SDK helper at `getAppBasePath()` for type-safe access.
      const appBasePath = `/api/proxy/${instance.instanceId}`;
      // Identity meta — always emitted regardless of cfg.injectMeta.
      const metaParts: string[] = [
        `<meta name="aura-app-id" content="${escAttr(instance.appId)}">`,
        `<meta name="aura-instance-id" content="${escAttr(instance.instanceId)}">`,
      ];

      if (cfg.injectMeta) {
        const themeSel      = await readShellThemeSelection().catch(() => null);
        const themeIdDark   = themeSel?.themeIdDark  ?? ThemeManager.DEFAULT_THEME_ID_DARK;
        const themeIdLight  = themeSel?.themeIdLight ?? ThemeManager.DEFAULT_THEME_ID_LIGHT;
        const colorMode     = themeSel?.colorMode    ?? ThemeManager.DEFAULT_COLOR_MODE;
        const { theme: activeTheme, resolvedMode } = ThemeManager.resolveActiveTheme(themeIdLight, themeIdDark, colorMode);
        const framework     = activeTheme.framework;

        metaParts.push(`<meta name="aura-app-base-path" content="${escAttr(appBasePath)}">`);
        metaParts.push(`<meta name="aura-design-framework" content="${escAttr(framework.id)}">`);
        metaParts.push(`<meta name="aura-design-framework-version" content="${escAttr(framework.version)}">`);
        metaParts.push(`<meta name="aura-theme-strategy" content="${escAttr(themeStrategy)}">`);
        metaParts.push(`<meta name="aura-color-mode" content="${escAttr(colorMode)}">`);
        metaParts.push(`<meta name="aura-resolved-mode" content="${escAttr(resolvedMode)}">`);

        // Activity id is the OS-level handle the SDK uses to call
        // /api/activities/<id>/navigate and /back. The proxy already sets
        // X-Aura-Activity-Id on the upstream request, but the browser SDK
        // needs a synchronous way to read it — meta tag is the established
        // pattern here (same as app-id / instance-id above).
        if (activityId) {
          metaParts.push(`<meta name="aura-activity-id" content="${escAttr(activityId)}">`);
          // History + breadcrumb snapshot — the SDK reads these synchronously
          // so apps that opted out of the OS chrome (`breadcrumb: 'off'`) can
          // render their own trail without a round-trip on mount.
          try {
            const activity = mgr.getActivity(activityId) as {
              history?: Array<{ path: string; title?: string }>;
              breadcrumb?: 'os' | 'off';
            } | undefined;
            const history = activity?.history ?? [];
            const breadcrumb = activity?.breadcrumb ?? 'os';
            metaParts.push(`<meta name="aura-activity-history" content="${escAttr(JSON.stringify(history))}">`);
            metaParts.push(`<meta name="aura-activity-breadcrumb" content="${escAttr(breadcrumb)}">`);
          } catch { /* AppManager may be mid-restart; iframe will refetch next load */ }
        }
        // themed + inherit both see the theme ids; override sees only mode.
        if (themeStrategy !== 'override') {
          metaParts.push(`<meta name="aura-theme-id" content="${escAttr(activeTheme.id)}">`);
          metaParts.push(`<meta name="aura-theme-id-dark" content="${escAttr(themeIdDark)}">`);
          metaParts.push(`<meta name="aura-theme-id-light" content="${escAttr(themeIdLight)}">`);
        }

        // Keymap snapshot for `osClient.keymap.getBinding()`. Two meta tags:
        //   • aura-keymap-actions  — JSON array of every action this app
        //     declared (manifest) plus OS-scope actions the app can reference
        //     (e.g. `aura.launcher.toggle` for menu hints).
        //   • aura-keymap-bindings — JSON map of actionId → currently-bound
        //     combo (defaults overridden by the user's KV overlay).
        // The SDK reads these synchronously on mount so menu shortcut labels
        // are correct from the first paint; live changes flow via
        // `aura.keymap.changed` postMessage from the shell.
        try {
          const keymapState = await readShellKeymapState();
          const appActions  = keymapRegistry.list().filter((a) =>
            a.id.startsWith(`app.${instance.appId}.`) || a.scope !== 'app',
          );
          const bindings    = resolveBindings(appActions, instance.appId, keymapState);
          metaParts.push(`<meta name="aura-keymap-actions" content="${escAttr(JSON.stringify(appActions))}">`);
          metaParts.push(`<meta name="aura-keymap-bindings" content="${escAttr(JSON.stringify(bindings))}">`);
        } catch (err) {
          console.warn('[proxy] could not inject keymap meta:', (err as Error).message);
        }
      }

      // Auto-inject /api/os/theme.css for inherit strategy. Skip if the app
      // already declared its own link (manual + auto both is harmless; only
      // skip if the manual one is present to keep the doc smaller).
      // The link sits behind cfg.injectMeta so a raw app that ships its own
      // stylesheet can opt out of the OS palette injection.
      const headFragments: string[] = [...metaParts];
      if (cfg.injectMeta && themeStrategy === 'inherit' &&
          !/<link\b[^>]*href=["']\/api\/os\/theme\.css/i.test(rewritten)) {
        headFragments.push('<link rel="stylesheet" href="/api/os/theme.css">');
      }
      // Globals exposed before any app script runs. SPA frameworks read
      // these synchronously during config evaluation — e.g. Next.js's
      // next.config.mjs can `const APP_BASE = globalThis.AURA_APP_BASE_PATH`
      // at runtime rather than hardcoding the proxy URL. Keeping it as a
      // separate <script> (not a JSON blob in a data-attribute) means it's
      // assigned synchronously at HTML-parse time, before any of the app's
      // own <script>s execute.
      if (cfg.injectIdentityScript) {
        headFragments.push(
          `<script>(function(){` +
            `window.AURA_APP_BASE_PATH=${JSON.stringify(appBasePath)};` +
            `window.AURA_APP_ID=${JSON.stringify(instance.appId)};` +
            `window.AURA_INSTANCE_ID=${JSON.stringify(instance.instanceId)};` +
          `})();</script>`,
        );
      }
      const idMeta = headFragments.join('');
      rewritten = rewritten.replace(/<head(\s[^>]*)?>/i, (m) => `${m}${idMeta}`);

      // Inject a console-relay script into every app iframe so its `console.*`
      // and uncaught errors flow up to the shell via postMessage. The shell's
      // console-bridge (OSLayout) consumes these and re-broadcasts to the
      // Console app (or anything else listening for `aura.console`).
      // Gated by cfg.injectConsoleRelay — raw apps can opt out, e.g. when
      // they ship their own observability and don't want a duplicate stream.
      const appIdJs = JSON.stringify(instance.appId);
      if (cfg.injectConsoleRelay) {
        const consoleRelay = `<script>${consoleRelayJs(appIdJs)}</script>`;
        // Place the relay right after <head ...> so it captures from frame 0.
        rewritten = rewritten.replace(/<head(\s[^>]*)?>/i, (m) => `${m}${consoleRelay}`);
      }

      // Passive keystroke forwarder. The shell broadcasts an `aura.key.claim`
      // postMessage listing the combos the OS wants to intercept (Phase 2 —
      // OS-modifier + Home/Back; Phase 4 — plus any combos the app's SDK
      // subscribed to). Everything outside the claim list flows to the app's
      // own listeners and to the browser's native handling untouched — this
      // is the "browser-default guarantee": an app that integrates nothing
      // keeps every browser keyboard behaviour (text inputs, IME, native
      // shortcuts like Ctrl+A/C/Z, Tab focus).
      //
      // Modifier order in the combo string matches the dispatcher's canonical
      // form (Ctrl→Alt→Shift→Super), and the non-modifier key uses
      // `KeyboardEvent.code` so bindings are layout-independent.
      // Tracks side-specific modifier state (LShift/RShift/etc.) so the
      // forwarded combo can disambiguate `RShift+Enter` from `Shift+Enter`.
      // Same shape as the shell-side dispatcher's logic.
      // Gated by cfg.injectKeyForwarder — raw apps that don't participate in
      // the OS keymap can skip this script (saves ~3 KB per iframe load).
      if (cfg.injectKeyForwarder) {
        const keyForwarder = `<script>${keyForwarderJs(appIdJs)}</script>`;
        rewritten = rewritten.replace(/<head(\s[^>]*)?>/i, (m) => `${m}${keyForwarder}`);
        // Virtual-keyboard receiver (`aura.key.synthetic`, see
        // components/shell/keyboard/PROTOCOL.md). Same gate as the forwarder:
        // apps that opt out of OS key handling handle synthetic keys themselves.
        rewritten = rewritten.replace(/<head(\s[^>]*)?>/i, (m) => `${m}<script>${SYNTHETIC_RECEIVER_JS}</script>`);
        // Device-keyboard policy (`aura.keyboard.policy`, same doc): keeps the
        // device's on-screen keyboard away from text fields when the shell says so.
        rewritten = rewritten.replace(/<head(\s[^>]*)?>/i, (m) => `${m}<script>${NATIVE_KEYBOARD_JS}</script>`);
        // PHASE2-CUTOVER: remove with proxy injection; App Host frames report to the Shell directly.
        // Relay for apps that frame other apps (TerminalX embedding a Terminal):
        // passes keys + policy one frame down and hello/field/open/close up, so
        // a nested document gets the same keyboard as a window. Inserted last ⇒
        // runs first, before the receiver, which it must precede to stop a key
        // it passed down. No-op in documents without a focused child iframe.
        rewritten = rewritten.replace(/<head(\s[^>]*)?>/i, (m) => `${m}<script>${FRAME_RELAY_JS}</script>`);
      }

      // Focus-on-click. Clicking anywhere in an app window must move keyboard
      // focus to it. The browser normally focuses an iframe when you click into
      // it, but an app that calls preventDefault() on mousedown — Guacamole's
      // canvas does — suppresses that, so keyboard focus stays on whichever
      // window held it before (e.g. a terminal) and typing goes to the wrong
      // app. On pointerdown we focus our own window when it isn't already
      // focused; capture phase so it runs even if the app stops propagation,
      // and the document.hasFocus() guard makes it a no-op once we hold focus
      // (so it never fights an app's own inner focus handling). Injected
      // unconditionally: every windowed app needs this, including ones that opt
      // out of the other injections, and it costs one guarded listener.
      // Not behind injectInputCompat — the preventDefault focus trap is not
      // specific to touch/DeX.
      // The same listener tells the shell the window was clicked
      // (`aura.pointerdown`): a click inside an iframe never reaches the
      // shell's DOM, so without it overlapping free windows only rose on a
      // title-bar click.
      const focusOnClick = `<script>${focusOnClickJs()}</script>`;
      rewritten = rewritten.replace(/<head(\s[^>]*)?>/i, (m) => `${m}${focusOnClick}`);

      // Mouse → touch replay for touch-only widgets. Libraries such as
      // Unidragger (Trilium's tab row) bind *either* touch or mouse events,
      // choosing touch whenever `ontouchstart` exists. On a touch-capable
      // browser driven by a mouse — a phone in Samsung DeX, a touchscreen
      // laptop — those widgets then ignore every click. The script records
      // which elements get touchstart/mousedown/pointerdown listeners and,
      // for a mouse gesture whose nearest touch listener has no mouse or
      // pointer listener between it and the target, dispatches the matching
      // touch events. Real touch input, browsers without touch support and
      // widgets that already handle the mouse are left untouched. `click`
      // listeners don't count as mouse handling: Unidragger binds touchstart
      // and click on the same handle. Listeners dropped via `once`/`signal`
      // aren't untracked; that errs towards skipping the replay.
      //
      // NOTE: keep this logic in sync with INPUT_COMPAT_JS in the
      // aura-native-wrapper (LocalProxyServer.java). Both inject it, guarded by
      // one `__auraInputCompat` flag so whichever runs first wins and the other
      // no-ops: the wrapper covers the top-level shell document and every page
      // the WebView loads; this proxy covers app HTML when the shell runs
      // outside the wrapper (a desktop browser tab, Electron). Two parts:
      //
      // 1. Hover / pointer-position catch-up. The Android WebView (a phone in
      //    Samsung DeX, a touchscreen laptop) does not emit `mousemove` while
      //    the mouse hovers with no button down, and delivers a button press
      //    with no move in front of it. Libraries that read the cursor
      //    position from the last move then act at a stale point — Guacamole's
      //    Mouse sends every click to wherever the previous drag ended; drag
      //    handles, tooltips and :hover UI misfire the same way. We mirror
      //    trusted mouse pointer events to synthetic `mousemove` at the real
      //    coordinates: before each press/release (so the click lands right)
      //    and on hover moves/boundary crossings that carry no button (so
      //    position-tracking keeps up as far as the platform reports it).
      //    Drags already emit real `mousemove`, so those are left alone, and a
      //    position guard drops any synthetic move the platform already sent —
      //    on a real hover-capable browser the whole block gates off on the
      //    `ontouchstart` check.
      // 2. Mouse -> touch replay for touch-only widgets (below), unchanged.
      //
      // Inserted last so it lands first in <head> and wraps addEventListener
      // before any app script runs.
      if (cfg.injectInputCompat) {
        const inputCompat = `<script>${INPUT_COMPAT_JS}</script>`;
        rewritten = rewritten.replace(/<head(\s[^>]*)?>/i, (m) => `${m}${inputCompat}`);
      }

      // EventSource multiplexer (client half; server half in
      // packages/shell/server/sse-mux.mjs). Every window shares the shell's
      // host, and browsers cap HTTP/1.1 at 6 connections per host. Each
      // EventSource pins one for the window's lifetime, so a few streaming
      // windows exhaust the pool and every later request — a reloaded app's
      // own scripts included — queues forever: the window never fires `load`
      // and stays on its skeleton. This replaces `EventSource` for same-origin
      // URLs with one that rides a WebSocket (not counted against the pool).
      // It reproduces readyState, on* handlers, named events and reconnects
      // with Last-Event-ID / `retry:`. If the socket never opens (endpoint
      // missing), every stream falls back to the native EventSource.
      // Inserted last so it lands first in <head>: the console relay wraps
      // whatever `EventSource` it finds, and app scripts must see this one.
      if (cfg.injectEventSourceMux) {
        const sseMux = `<script>${sseMuxJs()}</script>`;
        rewritten = rewritten.replace(/<head(\s[^>]*)?>/i, (m) => `${m}${sseMux}`);
      }

      const outHeaders = new Headers(upstream.headers);
      outHeaders.delete('content-encoding');
      outHeaders.delete('content-length');
      // App HTML must never be cached: WebView hosts cache heuristically when
      // no Cache-Control is present, leaving devices on stale app pages even
      // after a reload (scripts keep loading fine, so it looks half-updated).
      outHeaders.set('cache-control', 'no-store');
      scopeCookies(upstream, outHeaders, proxyPrefix);
      tagEtag(outHeaders);
      return new Response(rewritten, { status: upstream.status, headers: outHeaders });
    }

    // JS: rewrite absolute import URLs that Vite emits inside served modules.
    // Catches patterns like `import "/@fs/..."`, `import("/node_modules/.vite/...")`,
    // and bare quoted strings referencing /@vite/, /@id/, /@fs/, /node_modules/.
    // Without this, the Vite HMR client's internal imports escape to the shell origin.
    // Only fires when the manifest opts in to URL rewriting (cfg.rewriteHtml !== 'none')
    // — raw apps that don't run Vite don't emit these patterns and don't need the
    // body buffered/rewritten on every JS module fetch.
    // Our copy of this module is still current (we asked with its ETag above).
    if (jsCached && upstream.status === 304) {
      try { upstream.body?.cancel(); } catch { /* ignore */ }
      return new Response(jsCached.body, { status: 200, headers: new Headers(jsCached.headers) });
    }
    const isJs = /\b(javascript|typescript|ecmascript)\b/.test(contentType);
    if (isJs && cfg.rewriteHtml !== 'none') {
      const js = await upstream.text();
      const rewritten = js.replace(JS_IMPORT_RE, (_full, q, url) => `${q}${prefixUrl(url)}${q}`);
      const outHeaders = new Headers(upstream.headers);
      outHeaders.delete('content-encoding');
      outHeaders.delete('content-length');
      hardenDevCache(outHeaders, request);
      scopeCookies(upstream, outHeaders, proxyPrefix);
      tagEtag(outHeaders);
      const etag = upstream.headers.get('etag');
      if (request.method === 'GET' && upstream.status === 200 && etag && !outHeaders.has('set-cookie')) {
        jsModuleCache().set(jsKey, { etag, body: rewritten, headers: [...outHeaders] });
      }
      return new Response(rewritten, { status: upstream.status, headers: outHeaders });
    }

    // Node's fetch() transparently decompresses the body but leaves the
    // Content-Encoding header on the response. Forwarding it would tell the
    // browser to decode an already-decoded stream → NS_ERROR_CORRUPTED_CONTENT
    // / empty MIME for assets like CSS, fonts, images. Strip both encoding
    // and content-length (length no longer matches the decoded body).
    const outHeaders = new Headers(upstream.headers);
    outHeaders.delete('content-encoding');
    outHeaders.delete('content-length');
    hardenDevCache(outHeaders, request);
    scopeCookies(upstream, outHeaders, proxyPrefix);
    tagEtag(outHeaders);
    // Untouched bodies: the app's validator is ours too, so a browser holding
    // an untagged copy of an unchanged asset still gets its 304 (we asked the
    // app in full to keep it from answering for rewritten bodies, see above).
    if (staleClientEtag && upstream.status === 200 && request.method === 'GET') {
      const appEtag = upstream.headers.get('etag');
      if (appEtag && staleClientEtag.split(',').map((t) => t.trim()).includes(appEtag)) {
        try { upstream.body?.cancel(); } catch { /* ignore */ }
        return new Response(null, { status: 304, headers: outHeaders });
      }
    }
    return new Response(upstream.body ? wrapSafeStream(upstream.body) : null, {
      status:  upstream.status,
      headers: outHeaders,
    });
  } catch (err) {
    if (isExpectedAbort(err)) return new Response(null, { status: 499 });
    console.error(`[proxy] fetch failed routing ${id} → ${targetUrl}: ${(err as Error).message}`);
    return notReadyResponse(id, path, 502);
  }
};

/**
 * Turn a dev server's "revalidate before reuse" into "don't keep this at all".
 *
 * App HTML is already forced to `no-store` below, for a reason spelled out
 * there: WebView hosts cache heuristically and strand a device on a stale page.
 * Scripts have the same exposure and are worse when it happens — the HTML
 * updates, the module doesn't, and the app runs new markup against old code,
 * which looks like a dead control rather than a stale page. Observed with the
 * Capacitor host, which serves the OS through its own local server at
 * 127.0.0.1 and sits between the browser cache and this proxy.
 *
 * Deliberately narrow: only responses the upstream ALREADY said must be
 * revalidated (`no-cache`) are downgraded. Vite marks its pre-bundled deps
 * `max-age=31536000, immutable` — those are content-addressed and large
 * (xterm and friends), and re-fetching them on every load would be a real cost
 * for no benefit, so `immutable` is left alone.
 */
/**
 * Confine an app's cookies to that app's proxy path.
 *
 * Every AuraOS app is served from the SHELL's single origin, so cookies are a
 * shared namespace: an app that sets `session` at `Path=/` has that cookie
 * sent to every OTHER app too. The receiving app reads a cookie it never set
 * — for a Flask app, its own session cookie arrives alongside a stranger's of
 * the same name and the wrong one wins, which surfaces as a login that
 * "silently fails" with the right password.
 *
 * Rewriting `Path` so it lands inside `/api/proxy/<id>` makes the browser send
 * each cookie back only to the app that set it. A `Path` the app chose is kept
 * and mapped into the prefix (the app means a path in ITS OWN url-space), and
 * one already inside the prefix is left alone — `preservePrefix` apps, and
 * anything behind a subpath-aware runtime, already emit those.
 *
 * Not touched: name, value, Domain, Secure, HttpOnly, SameSite, Expires.
 */
function scopeCookiePath(cookie: string, proxyPrefix: string): string {
  const parts = cookie.split(';');
  let hadPath = false;
  const rewritten = parts.map((part) => {
    const m = /^(\s*)path\s*=\s*(.*)$/i.exec(part);
    if (!m) return part;
    hadPath = true;
    const lead = m[1] ?? '';
    const val  = (m[2] ?? '').trim() || '/';
    if (val === proxyPrefix || val.startsWith(`${proxyPrefix}/`)) return part;
    const abs = val.startsWith('/') ? val : `/${val}`;
    return `${lead}Path=${abs === '/' ? proxyPrefix : `${proxyPrefix}${abs}`}`;
  });
  // No Path at all defaults to the request's directory, which for an app page
  // is already under the prefix — but say it explicitly so the scope does not
  // depend on which URL happened to set the cookie.
  if (!hadPath) rewritten.push(` Path=${proxyPrefix}`);
  return rewritten.join(';');
}

/** Apply scopeCookiePath to every Set-Cookie carried on `upstream`. */
function scopeCookies(upstream: Response, outHeaders: Headers, proxyPrefix: string): void {
  const cookies = upstream.headers.getSetCookie?.() ?? [];
  if (cookies.length === 0) return;
  outHeaders.delete('set-cookie');
  for (const c of cookies) outHeaders.append('set-cookie', scopeCookiePath(c, proxyPrefix));
}

/**
 * App JS modules after the URL rewrite, keyed by proxy prefix + upstream URL
 * and validated by the app's ETag. Every Terminal window of an instance loads
 * the same ~700 KB of modules, and the browser may not cache them
 * (hardenDevCache: no-store, for WebView hosts) — without this each copy was
 * downloaded from the app and regex-rewritten again on the shell's event
 * loop, which also slowed every WebSocket handshake behind it. Bounded LRU
 * (by bytes), pinned on globalThis.
 */
interface CachedModule { etag: string; body: string; headers: Array<[string, string]> }
const JS_CACHE_MAX_BYTES = 64 * 1024 * 1024;
/**
 * Identity of THIS build of the rewriter. The cache is pinned on globalThis,
 * which the shell's live-rebuild generations (server/watchRebuild.mjs) share
 * in one process: without this tag a new generation with a changed rewrite
 * keeps serving bodies the old generation rewrote (the app says 304, so the
 * stale copy wins). Each generation re-executes this module and gets a fresh
 * tag, which drops the previous generation's entries.
 */
const JS_CACHE_BUILD = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
function jsModuleCache() {
  const g = globalThis as unknown as { __auraProxyJsCache?: { build: string; map: Map<string, CachedModule>; bytes: number } };
  if (g.__auraProxyJsCache?.build !== JS_CACHE_BUILD) g.__auraProxyJsCache = { build: JS_CACHE_BUILD, map: new Map(), bytes: 0 };
  const c = g.__auraProxyJsCache;
  return {
    get(key: string): CachedModule | undefined {
      const hit = c.map.get(key);
      if (hit) { c.map.delete(key); c.map.set(key, hit); }   // most recently used last
      return hit;
    },
    set(key: string, entry: CachedModule): void {
      const old = c.map.get(key);
      if (old) { c.bytes -= old.body.length; c.map.delete(key); }
      if (entry.body.length > JS_CACHE_MAX_BYTES / 4) return;
      c.map.set(key, entry);
      c.bytes += entry.body.length;
      for (const [k, v] of c.map) {
        if (c.bytes <= JS_CACHE_MAX_BYTES) break;
        c.map.delete(k); c.bytes -= v.body.length;
      }
    },
  };
}

function hardenDevCache(headers: Headers, request: Request): void {
  const cc = headers.get('cache-control');
  if (!cc) return;
  if (/immutable/i.test(cc) || /max-age=(?!0\b)/i.test(cc)) return;
  if (/no-cache/i.test(cc) && cachesHeuristically(request)) headers.set('cache-control', 'no-store');
}

/**
 * Hosts that do not honour `no-cache` (see hardenDevCache): Android WebViews
 * (User-Agent `; wv)`) and requests that came through the Capacitor host's
 * local server, which rewrites Host to the shell's address
 * (AURA_NO_STORE_HOSTS, comma-separated; default 10.201.1.2:3000). Desktop
 * browsers revalidate a `no-cache` response properly (ETag → 304), so they
 * keep it: a repeat load of an app re-downloads nothing that did not change.
 */
const NO_STORE_HOSTS = new Set((process.env['AURA_NO_STORE_HOSTS'] ?? '10.201.1.2:3000').split(',').map((h) => h.trim()).filter(Boolean));
function cachesHeuristically(request: Request): boolean {
  if (/;\s*wv\)/.test(request.headers.get('user-agent') ?? '')) return true;
  const host = request.headers.get('host') ?? '';
  return NO_STORE_HOSTS.has(host);
}

/**
 * Wrap an upstream `ReadableStream` so that aborts / socket terminations
 * during forwarding don't bubble up as uncaught errors. These happen
 * constantly during normal operation — every time an iframe unloads while
 * piping an SSE stream, the proxy aborts the upstream fetch, undici tears
 * down the socket, and the read throws `TypeError: terminated` or a
 * `UND_ERR_SOCKET`. We close the stream cleanly instead so the response
 * pipeline doesn't log noise.
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

/**
 * Return an upstream-not-ready response whose Content-Type matches what the
 * browser was asking for. Without this, a JS/CSS module request that hits an
 * unavailable upstream gets `text/html` back, and the browser refuses to load
 * it with `disallowed MIME type ("text/html")` — breaking the iframe even
 * after the upstream recovers (until the user hard-reloads). We sniff the
 * URL path by extension and emit a same-type stub instead.
 */
function notReadyResponse(id: string, path: string, status: number): Response {
  const ext = path.toLowerCase().match(/\.([a-z0-9]+)(?:[?#].*)?$/)?.[1] ?? '';
  const jsLike  = ['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'mts', 'cts'].includes(ext) || path.startsWith('@fs/') || path.startsWith('@id/') || path.startsWith('node_modules/');
  const cssLike = ext === 'css';
  if (jsLike) {
    return new Response(`/* AuraOS proxy: ${id} not ready */\nthrow new Error("AuraOS proxy: upstream ${id} not ready");`, {
      status,
      headers: { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' },
    });
  }
  if (cssLike) {
    return new Response(`/* AuraOS proxy: ${id} not ready */`, {
      status,
      headers: { 'Content-Type': 'text/css', 'Cache-Control': 'no-store' },
    });
  }
  return new Response(notReadyHtml(id), {
    status,
    headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' },
  });
}

function notReadyHtml(id: string): string {
  return `<!DOCTYPE html><html><head><style>
    body{background:#0a0a0a;color:#557755;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}
    .msg{text-align:center;} .id{color:#00ff41;font-size:1.1em;}
    </style></head><body><div class="msg">
      <div class="id">${id}</div>
      <div>NOT READY — WAITING FOR PROCESS...</div>
    </div></body></html>`;
}

/**
 * Themed warning page for the service-has-no-ui guard. Pulls colours from the
 * live OS palette via /api/os/theme.css so the iframe inherits whatever theme
 * the user has active. Falls back to the warning-orange literal in case the
 * stylesheet hasn't loaded yet.
 */
function renderServiceBlockedHtml(p: {
  error: string;
  message: string;
  appId: string;
  instanceId: string;
  blockedPath: string;
}): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!
  ));
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>${esc(p.appId)} — service has no UI</title>
  <link rel="stylesheet" href="/api/os/theme.css" />
  <style>
    *  { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      height: 100%;
      background: var(--aura-color-bg, #0a0a0a);
      color: var(--aura-color-warning, #ff9900);
      font-family: var(--aura-font-mono, 'Courier New', monospace);
      font-size: 13px;
      line-height: 1.5;
    }
    body { display: flex; align-items: center; justify-content: center; padding: 24px; }
    .card {
      max-width: 560px;
      width: 100%;
      padding: 20px 22px;
      border: 1px solid var(--aura-color-warning, #ff9900);
      background: var(--aura-color-surface, rgba(255,153,0,0.05));
    }
    .tag {
      display: inline-block;
      padding: 2px 8px;
      margin-bottom: 14px;
      font-size: 11px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--aura-color-bg, #0a0a0a);
      background: var(--aura-color-warning, #ff9900);
    }
    h1 {
      font-size: 14px;
      font-weight: 600;
      letter-spacing: 0.04em;
      color: var(--aura-color-warning, #ff9900);
      margin-bottom: 12px;
    }
    p { color: var(--aura-color-text, #ccffcc); margin-bottom: 14px; }
    dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px; font-size: 12px; }
    dt { color: var(--aura-color-text-dim, #557755); text-transform: uppercase; letter-spacing: 0.08em; }
    dd { color: var(--aura-color-warning, #ff9900); word-break: break-all; }
    .hint {
      margin-top: 16px; padding-top: 14px;
      border-top: 1px dashed var(--aura-color-border, rgba(255,153,0,0.3));
      font-size: 12px;
      color: var(--aura-color-text-dim, #557755);
    }
    code {
      padding: 0 4px;
      color: var(--aura-color-warning, #ff9900);
      background: var(--aura-color-bg, #0a0a0a);
    }
  </style>
</head>
<body>
  <div class="card" role="alert">
    <span class="tag">${esc(p.error)}</span>
    <h1>Services have no UI</h1>
    <p>${esc(p.message)}</p>
    <dl>
      <dt>app</dt>          <dd>${esc(p.appId)}</dd>
      <dt>instance</dt>     <dd>${esc(p.instanceId)}</dd>
      <dt>blocked path</dt> <dd>${esc(p.blockedPath)}</dd>
    </dl>
    <p class="hint">
      Dispatch an intent via <code>AppManager.startIntent({ … })</code> so the OS
      resolves it to a separate <code>componentType: "activity"</code> app — that
      app's window will surface the UI. Services keep doing the headless work
      behind it.
    </p>
  </div>
</body>
</html>`;
}
