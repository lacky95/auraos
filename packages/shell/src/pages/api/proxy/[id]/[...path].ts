import type { APIRoute } from 'astro';
import { getAppManager, ThemeManager, keymapRegistry, resolveProxyConfig } from '@aura/core';
import type { AppManifest, ColorMode, KeyAction, OsKeymapState, ProxyConfig } from '@aura/core';
import { defaultKv } from '@aura/kv-store';

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
  exposeAllPaths:       false,
};

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
  const instance = exact && isLive(exact.state)
    ? exact
    : mgr.getInstancesByApp(id).find((i) => !i.inPool && isLive(i.state) && i.port != null);

  if (!instance?.port) {
    return notReadyResponse(id, path, 503);
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
  const upstreamPath = cfg.preservePrefix ? `api/proxy/${id}/${path}` : path;
  const targetUrl = `http://${upHost}:${upPort}/${upstreamPath}${search}`;

  try {
    const headers = new Headers(request.headers);
    headers.set('X-Aura-App-Id', instance.appId);
    headers.set('X-Aura-Instance-Id', instance.instanceId);
    if (activityId) headers.set('X-Aura-Activity-Id', activityId);
    headers.delete('host');

    // Forward the browser's abort signal so streams (SSE, long-poll) live as
    // long as the iframe keeps the connection open and die cleanly when it
    // doesn't. No hard timeout: localhost-to-localhost won't hang, and a
    // timeout would kill `text/event-stream` after N seconds.
    const upstream = await fetch(targetUrl, {
      method:  request.method,
      headers,
      body:    ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      signal:  request.signal,
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
        const consoleRelay = `<script>(function(){try{
var P=window.parent;if(!P||P===window)return;
var SRC=${appIdJs};
var LVL=['log','info','warn','error','debug'];
var orig={};LVL.forEach(function(l){orig[l]=console[l].bind(console);});
function fmt(a){if(a===null)return'null';if(a===undefined)return'undefined';if(typeof a==='string')return a;if(typeof a==='number'||typeof a==='boolean')return String(a);if(a instanceof Error)return a.name+': '+a.message+(a.stack?'\\n'+a.stack:'');try{var s=new WeakSet();return JSON.stringify(a,function(_k,v){if(typeof v==='object'&&v!==null){if(s.has(v))return'[Circular]';s.add(v);}if(typeof v==='function')return'[Function]';return v;},2)||String(a);}catch(e){try{return String(a);}catch(_){return'[unserializable]';}}}
function relay(lvl,args){try{P.postMessage({type:'aura.console.relay',entry:{type:'aura.console',level:lvl,timestamp:Date.now(),source:SRC,args:Array.from(args).map(fmt)}},'*');}catch(_){}}
LVL.forEach(function(l){console[l]=function(){orig[l].apply(console,arguments);relay(l,arguments);};});
window.addEventListener('error',function(e){relay('error',['Uncaught '+e.message+' at '+(e.filename||'?')+':'+(e.lineno||0)+':'+(e.colno||0)]);});
window.addEventListener('unhandledrejection',function(e){var r=e.reason;var m=r instanceof Error?(r.name+': '+r.message+(r.stack?'\\n'+r.stack:'')):String(r);relay('error',['Unhandled rejection: '+m]);});
var shuttingDown=false;var openES=new Set();var openWS=new Set();
var NativeES=window.EventSource;if(NativeES){var W=function(u,i){var es=new NativeES(u,i);openES.add(es);var reported=false;es.addEventListener('error',function(){if(shuttingDown)return;if(reported)return;if(es.readyState!==2)return;reported=true;openES.delete(es);relay('debug',['EventSource closed: '+u]);});var origClose=es.close.bind(es);es.close=function(){openES.delete(es);return origClose();};return es;};W.prototype=NativeES.prototype;['CONNECTING','OPEN','CLOSED'].forEach(function(k,i){W[k]=i;});window.EventSource=W;}
var NativeWS=window.WebSocket;if(NativeWS){var WW=function(u,p){var ws=p?new NativeWS(u,p):new NativeWS(u);openWS.add(ws);ws.addEventListener('close',function(){openWS.delete(ws);});return ws;};WW.prototype=NativeWS.prototype;['CONNECTING','OPEN','CLOSING','CLOSED'].forEach(function(k,i){WW[k]=i;});window.WebSocket=WW;}
var nFetch=window.fetch.bind(window);window.fetch=async function(input,init){var u=typeof input==='string'?input:(input&&input.url)||String(input);try{var r=await nFetch(input,init);if(!r.ok&&!shuttingDown){relay(r.status>=500?'error':'warn',['fetch '+((init&&init.method)||'GET')+' '+u+' \\u2192 '+r.status+' '+r.statusText]);}return r;}catch(e){if(!shuttingDown)relay('error',['fetch '+((init&&init.method)||'GET')+' '+u+' failed: '+(e&&e.message||String(e))]);throw e;}};
var X=window.XMLHttpRequest;if(X){var oO=X.prototype.open,oS=X.prototype.send;X.prototype.open=function(m,u){this.__am=m;this.__au=u;return oO.apply(this,arguments);};X.prototype.send=function(){var self=this;this.addEventListener('error',function(){if(!shuttingDown)relay('error',['xhr '+self.__am+' '+self.__au+' network error']);});this.addEventListener('load',function(){if(self.status>=400&&!shuttingDown){relay(self.status>=500?'error':'warn',['xhr '+self.__am+' '+self.__au+' \\u2192 '+self.status]);}});return oS.apply(this,arguments);};}
// Lifecycle: the shell postMessages 'aura.shutdown' before removing the iframe.
// Closing tracked EventSource/WebSocket first means their teardown is a clean
// .close() call rather than a network-abort, so no spurious error events fire
// in the moments before the iframe is torn down. We ack so the shell knows it
// can proceed; the shell has a hard timeout regardless.
window.addEventListener('message',function(ev){if(!ev.data||ev.data.type!=='aura.shutdown')return;shuttingDown=true;try{openES.forEach(function(es){try{es.close();}catch(_){}});openWS.forEach(function(ws){try{ws.close(1000,'app-shutdown');}catch(_){}});openES.clear();openWS.clear();}catch(_){}try{P.postMessage({type:'aura.shutdown.done',source:SRC},'*');}catch(_){}});
}catch(_){}})();</script>`;
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
        const keyForwarder = `<script>(function(){try{
var P=window.parent;if(!P||P===window)return;
var SRC=${appIdJs};
var claims=new Set();
var mod={cl:0,cr:0,al:0,ar:0,sl:0,sr:0,ml:0,mr:0};
function isMod(c){return c==='ControlLeft'||c==='ControlRight'||c==='AltLeft'||c==='AltRight'||c==='ShiftLeft'||c==='ShiftRight'||c==='MetaLeft'||c==='MetaRight'||c==='OSLeft'||c==='OSRight';}
function setMod(c,v){if(c==='ControlLeft')mod.cl=v;else if(c==='ControlRight')mod.cr=v;else if(c==='AltLeft')mod.al=v;else if(c==='AltRight')mod.ar=v;else if(c==='ShiftLeft')mod.sl=v;else if(c==='ShiftRight')mod.sr=v;else if(c==='MetaLeft'||c==='OSLeft')mod.ml=v;else if(c==='MetaRight'||c==='OSRight')mod.mr=v;}
function pick(e,name,lf,rt){var n=e[name];if(!n)return null;if(rt&&!lf)return 'R'+'_';/*placeholder*/return lf&&!rt?'L_':null;}
function combo(e){
  var c=e.code;
  if(isMod(c))return c;
  var p=[];
  if(e.ctrlKey){p.push(mod.cr&&!mod.cl?'RCtrl':(mod.cl&&!mod.cr?'LCtrl':'Ctrl'));}
  if(e.altKey){p.push(mod.ar&&!mod.al?'RAlt':(mod.al&&!mod.ar?'LAlt':'Alt'));}
  if(e.shiftKey){p.push(mod.sr&&!mod.sl?'RShift':(mod.sl&&!mod.sr?'LShift':'Shift'));}
  if(e.metaKey){p.push(mod.mr&&!mod.ml?'RSuper':(mod.ml&&!mod.mr?'LSuper':'Super'));}
  p.push(c);
  return p.join('+');
}
function expand(combo){
  // Mirror @aura/core/keymap's expandCombo: enumerate generic siblings
  // so a binding of "Shift+Enter" matches "RShift+Enter" etc.
  var segs=combo.split('+');
  if(segs.length<=1)return [combo];
  var key=segs[segs.length-1];
  var mods=segs.slice(0,-1);
  var variants=[[]];
  for(var i=0;i<mods.length;i++){
    var m=mods[i];var base=m;var sided=false;
    if(m==='RShift'||m==='LShift'){base='Shift';sided=true;}
    else if(m==='RCtrl'||m==='LCtrl'){base='Ctrl';sided=true;}
    else if(m==='RAlt'||m==='LAlt'){base='Alt';sided=true;}
    else if(m==='RSuper'||m==='LSuper'){base='Super';sided=true;}
    var next=[];
    for(var v=0;v<variants.length;v++){
      next.push(variants[v].concat([m]));
      if(sided)next.push(variants[v].concat([base]));
    }
    variants=next;
  }
  var out=[];
  for(var v2=0;v2<variants.length;v2++){
    out.push(variants[v2].concat([key]).join('+'));
  }
  return out;
}
window.addEventListener('message',function(ev){var d=ev.data;if(!d||d.type!=='aura.key.claim')return;claims=new Set(Array.isArray(d.combos)?d.combos:[]);});
window.addEventListener('keydown',function(e){
  if(isMod(e.code))setMod(e.code,1);
  var c=combo(e);if(!c)return;
  // Iframe-side match must mirror dispatcher: expand the physical combo
  // and forward if ANY generic sibling is claimed.
  var cands=expand(c);var hit=false;for(var i=0;i<cands.length;i++){if(claims.has(cands[i])){hit=true;break;}}
  if(!hit)return;
  e.preventDefault();e.stopPropagation();
  try{P.postMessage({type:'aura.key',combo:c,appId:SRC},'*');}catch(_){}
},{capture:true});
window.addEventListener('keyup',function(e){
  if(isMod(e.code))setMod(e.code,0);
  // Firefox-on-Linux ergonomic fix: a lone Alt keyup opens Firefox's
  // window menu (File / Edit / View …), which steals focus from the
  // iframe. That fires on AltGr release too — so pressing AltGr+Q to
  // type @ (German layout) or AltGr+E for € pops the menu and kicks
  // the user out of the terminal. preventDefault on every Alt /
  // AltGraph keyup suppresses that activation without otherwise
  // changing keyboard behaviour. Chromium isn't affected; the call is
  // a no-op there.
  if(e.key==='Alt'||e.key==='AltGraph'){e.preventDefault();}
},{capture:true});
window.addEventListener('blur',function(){mod.cl=mod.cr=mod.al=mod.ar=mod.sl=mod.sr=mod.ml=mod.mr=0;});
}catch(_){}})();</script>`;
        rewritten = rewritten.replace(/<head(\s[^>]*)?>/i, (m) => `${m}${keyForwarder}`);
      }

      const outHeaders = new Headers(upstream.headers);
      outHeaders.delete('content-encoding');
      outHeaders.delete('content-length');
      return new Response(rewritten, { status: upstream.status, headers: outHeaders });
    }

    // JS: rewrite absolute import URLs that Vite emits inside served modules.
    // Catches patterns like `import "/@fs/..."`, `import("/node_modules/.vite/...")`,
    // and bare quoted strings referencing /@vite/, /@id/, /@fs/, /node_modules/.
    // Without this, the Vite HMR client's internal imports escape to the shell origin.
    // Only fires when the manifest opts in to URL rewriting (cfg.rewriteHtml !== 'none')
    // — raw apps that don't run Vite don't emit these patterns and don't need the
    // body buffered/rewritten on every JS module fetch.
    const isJs = /\b(javascript|typescript|ecmascript)\b/.test(contentType);
    if (isJs && cfg.rewriteHtml !== 'none') {
      const js = await upstream.text();
      const rewritten = js.replace(
        /(["'`])(\/(?:@fs|@vite|@id|node_modules)\/[^"'`\s]*)\1/g,
        (_full, q, url) => `${q}${prefixUrl(url)}${q}`,
      );
      const outHeaders = new Headers(upstream.headers);
      outHeaders.delete('content-encoding');
      outHeaders.delete('content-length');
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

/**
 * Read current `{ themeIdDark, themeIdLight, colorMode }` from the Settings
 * provider. Mirrors OSLayout's SSR lookup but lives here so the proxy doesn't
 * have to depend on any shell-side helper. Falls back to defaults silently if
 * Settings isn't running yet — every value has a sane default in ThemeManager.
 */
async function readShellThemeSelection(): Promise<{ themeIdDark: string; themeIdLight: string; colorMode: ColorMode } | null> {
  // Read directly from the OS KV — no app dependency. The bootstrap step
  // ensures `os/theme` is populated before any proxy request lands.
  const kv = defaultKv();
  try {
    const stored = await kv.getValue<{ themeIdDark?: string; themeIdLight?: string; colorMode?: ColorMode }>('os', 'theme');
    if (!stored) return null;
    return {
      themeIdDark:  stored.themeIdDark  ?? ThemeManager.DEFAULT_THEME_ID_DARK,
      themeIdLight: stored.themeIdLight ?? ThemeManager.DEFAULT_THEME_ID_LIGHT,
      colorMode:    stored.colorMode    ?? ThemeManager.DEFAULT_COLOR_MODE,
    };
  } catch { return null; }
  finally { await kv.close().catch(() => undefined); }
}

/**
 * Read the persisted user keymap overlay from the OS KV. Returns the empty
 * state on cold boot / missing key — that means "use registry defaults",
 * which is what `resolveBindings` does anyway.
 */
async function readShellKeymapState(): Promise<OsKeymapState> {
  const kv = defaultKv();
  try {
    const stored = await kv.getValue<OsKeymapState>('os', 'keymap');
    if (!stored) return { bindings: {}, appOverlays: {} };
    return {
      bindings:    stored.bindings    ?? {},
      appOverlays: stored.appOverlays ?? {},
    };
  } catch { return { bindings: {}, appOverlays: {} }; }
  finally { await kv.close().catch(() => undefined); }
}

/**
 * Resolve the currently-effective combo for each of the given actions,
 * applying the user's KV overlay on top of the registry defaults. The map
 * is { actionId → combo|null } — null means "explicitly unbound".
 *
 * Apps consume this via `<meta name="aura-keymap-bindings">` injected into
 * their HTML; the SDK's `getBinding()` reads it synchronously.
 */
function resolveBindings(actions: readonly KeyAction[], appId: string, state: OsKeymapState): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  const overlay = state.appOverlays[appId] ?? {};
  for (const a of actions) {
    if (a.id.startsWith(`app.${appId}.`)) {
      out[a.id] = a.id in overlay ? (overlay[a.id] ?? null) : a.defaultCombo;
    } else {
      out[a.id] = a.id in state.bindings ? (state.bindings[a.id] ?? null) : a.defaultCombo;
    }
  }
  return out;
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
