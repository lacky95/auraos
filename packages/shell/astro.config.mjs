import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Plain-inline mirror of @aura/core/logger's filter spec. astro.config.mjs
// loads before the @aura/core build watcher emits dist/, so we can't import
// the real logger here without risking a startup crash on cold boot. The
// filter syntax stays the same (AURA_LOG=ws-proxy, AURA_LOG=*, AURA_LOG=-x).
const WS_NS = 'ws-proxy';
function nsEnabled(ns, filter) {
  if (!filter) return false;
  let positive = false;
  for (const raw of filter.split(/[\s,]+/)) {
    if (!raw) continue;
    const neg = raw.startsWith('-');
    const pat = (neg ? raw.slice(1) : raw)
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    if (new RegExp('^' + pat + '$').test(ns)) {
      if (neg) return false;
      positive = true;
    }
  }
  return positive;
}
function dbg(tag, ...args) {
  if (!nsEnabled(WS_NS, process.env.AURA_LOG ?? '')) return;
  console.log(`[${WS_NS}]`, tag, ...args);
}
const SIO_NS = 'sio';
function sioDbg(tag, ...args) {
  if (!nsEnabled(SIO_NS, process.env.AURA_LOG ?? '')) return;
  console.log(`[${SIO_NS}]`, tag, ...args);
}

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Localhost fetch of /api/apps — the WS proxy's source of truth for which
 * instances are running on which ports. We hit our own HTTP server instead
 * of poking at AppManager via `server.ssrLoadModule('@aura/core')` because
 * the SSR-loaded copy of @aura/core gets a DIFFERENT module instance than
 * the request-handling middleware, with an unpopulated globalThis-pinned
 * singleton, and the proxy would see no instances and destroy every WS
 * upgrade. The HTTP path always reaches the single source of truth.
 *
 * `SHELL_PORT` env var lets the container's outer wrappers point us at
 * the right HTTP port if the shell ever binds non-3000.
 */
async function fetchAppsList() {
  const shellPort = process.env.SHELL_PORT ?? process.env.AURA_SHELL_PORT ?? '3000';
  const res = await fetch(`http://127.0.0.1:${shellPort}/api/apps`, {
    signal: AbortSignal.timeout(2000),
  });
  if (!res.ok) throw new Error(`/api/apps → ${res.status}`);
  return res.json();
}

/**
 * Vite plugin: intercept `/api/proxy/<id>/<path>?astro|?vue|?svelte` requests
 * BEFORE vite-plugin-astro sees them. The shell's Vite middleware claims any
 * URL with an `?astro` query and tries to compile the file relative to
 * `packages/shell/`. For proxy paths the file lives in `apps/<id>/...`, not in
 * the shell — compilation fails with `No cached compile metadata`.
 *
 * The proxy route handler already escapes these queries on the *outbound* HTML
 * side (?astro → ?_aura_vite_astro=1). But if a request arrives with the
 * un-escaped query directly (DevTools sourcemap probe, an HMR ping, a hand-
 * issued curl, anything), it skips the proxy route. Rewriting the URL here
 * routes it back through the normal proxy handler, which then forwards the
 * unescaped query upstream to the app's own Vite.
 *
 * Registered WITHOUT returning a function from configureServer so it lands
 * BEFORE Vite's internal middlewares (and therefore before vite-plugin-astro).
 */
function proxyViteQueryEscape() {
  return {
    name: 'aura-proxy-vite-query-escape',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const url = req.url;
        if (!url || !url.startsWith('/api/proxy/')) return next();
        if (!/[?&](astro|vue|svelte)(=|&|$)/.test(url)) return next();
        req.url = url
          .replace(/(\?|&)astro(?=&|$)/g,    '$1_aura_vite_astro=1')
          .replace(/(\?|&)vue(?=&|=|$)/g,    '$1_aura_vite_vue')
          .replace(/(\?|&)svelte(?=&|=|$)/g, '$1_aura_vite_svelte');
        next();
      });
    },
  };
}

/** Vite plugin: proxy WebSocket upgrades for /api/proxy/[appId]/[path] */
function wsProxyPlugin() {
  return {
    name: 'aura-ws-proxy',
    configureServer(server) {
      if (!server.httpServer) return;
      server.httpServer.on('upgrade', async (req, socket, head) => {
        const url = req.url ?? '';
        const t0 = Date.now();
        dbg('WS-PROXY', 'upgrade', url);
        // Match path + (optional) query separately so we can strip _aura_sub
        const m = url.match(/^\/api\/proxy\/([^/]+)\/([^?]*)(\?.*)?$/);
        if (!m) { dbg('WS-PROXY', 'no-match', url); return; }
        const [, instanceId, proxyPath, rawQuery] = m;

        let activityId = null;
        let upstreamQuery = rawQuery ?? '';
        if (upstreamQuery) {
          const sp = new URLSearchParams(upstreamQuery.slice(1));
          if (sp.has('_aura_activity')) {
            activityId = sp.get('_aura_activity');
            sp.delete('_aura_activity');
            const s = sp.toString();
            upstreamQuery = s ? '?' + s : '';
          }
        }

        // Resolve the upstream port. The first segment can be either a real
        // instanceId (e.g. "com.aura.terminal-3") or an app id (the iframe
        // uses the app id for the bare /ws path). Prefer:
        //   1. exact instanceId match
        //   2. for an app id: a NON-pool, resumed instance — pool members
        //      are spawn-warmed but not user-attached; routing the WS at one
        //      can send bash output to a tab that doesn't own it, and after
        //      restarts a transient pool member is a common [0] match.
        //   3. fall back to any healthy instance of that app.
        // Resolve the upstream {host, port} via the AppManager. Container-
        // sandbox instances live on the shared docker network and have a
        // hostname like 'aura-com.aura.terminal-3'; PRoot instances are on
        // 127.0.0.1. getUpstreamUrl encapsulates this — proxy stays
        // agnostic about which runner backs the instance.
        // Resolve via a localhost HTTP call to OUR OWN /api/apps. The
        // previous approach was `server.ssrLoadModule('@aura/core')` to
        // grab the AppManager singleton — but Vite's SSR module graph and
        // Node's loader produce DIFFERENT @aura/core instances during dev,
        // and the SSR copy never gets `initAppManager()` called on it.
        // Its globalThis-pinned singleton is consequently empty, so every
        // WS proxy attempt sees `instances: []` and 503s with
        // "can't establish a connection" in the browser.
        //
        // Going through HTTP makes us reuse the SAME AppManager singleton
        // that the rest of the Astro server's API routes use (via the
        // middleware-init path), at the cost of ~1ms localhost round-trip.
        // That's well below the WS-handshake overhead so it's invisible.
        let host = null;
        let port = null;
        let chosenInstanceId = null;
        try {
          const tLoadStart = Date.now();
          const apps = await fetchAppsList();
          dbg('WS-PROXY', 'fetchAppsList', `${Date.now() - tLoadStart}ms apps=${apps.length}`);
          let chosen = null;
          // Pass 1: direct instanceId match.
          for (const a of apps) {
            chosen = a.instances.find((i) => i.instanceId === instanceId);
            if (chosen) break;
          }
          // Pass 2: appId match → prefer non-pool, resumed/started.
          if (!chosen) {
            const app = apps.find((a) => a.manifest.id === instanceId);
            const candidates = app?.instances ?? [];
            dbg('WS-PROXY', 'candidates', JSON.stringify(candidates.map((i) => ({ id: i.instanceId, port: i.port, state: i.state, inPool: i.inPool, sandbox: i.sandbox }))));
            chosen = candidates.find((i) => !i.inPool && (i.state === 'resumed' || i.state === 'started'))
                  ?? candidates.find((i) => i.state === 'resumed' || i.state === 'started')
                  ?? null;
          }
          if (chosen?.port != null) {
            // PRoot instances use 127.0.0.1; container-mode instances
            // expose a docker hostname like 'aura-com.aura.terminal-3'.
            // Mirror the AppManager.getUpstreamUrl rule inline here so the
            // proxy doesn't need the singleton at all.
            host = chosen.sandbox === 'container' ? `aura-${chosen.instanceId}` : '127.0.0.1';
            port = chosen.port;
            chosenInstanceId = chosen.instanceId;
          }
        } catch (err) { dbg('WS-PROXY', 'resolve-err', String(err)); }

        if (!port) { dbg('WS-PROXY', 'no-port → destroy', instanceId, `t=${Date.now() - t0}ms`); socket.destroy(); return; }
        dbg('WS-PROXY', 'chose', chosenInstanceId, `host=${host} port=${port}`, `t=${Date.now() - t0}ms`);

        // Inject activity header for the upstream upgrade request
        if (activityId) req.headers['x-aura-activity-id'] = activityId;

        const { WebSocket, WebSocketServer } = await import('ws');
        const upstreamUrl = `ws://${host ?? 'localhost'}:${port}/${proxyPath}${upstreamQuery}`;
        const tUpstreamStart = Date.now();
        dbg('WS-PROXY', 'upstream-dial', upstreamUrl);
        const upstream = new WebSocket(upstreamUrl, {
          headers: activityId ? { 'x-aura-activity-id': activityId } : undefined,
        });

        upstream.once('open', () => {
          dbg('WS-PROXY', 'upstream-open', `${Date.now() - tUpstreamStart}ms total=${Date.now() - t0}ms`);
          const wss = new WebSocketServer({ noServer: true });
          wss.handleUpgrade(req, socket, head, (client) => {
            dbg('WS-PROXY', 'client-handshake-done', `total=${Date.now() - t0}ms`);
            client.on('message', (data, isBinary) => {
              if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
            });
            upstream.on('message', (data, isBinary) => {
              if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
            });
            client.on('close', () => upstream.terminate());
            upstream.on('close', () => { try { client.terminate(); } catch {} });
          });
        });

        upstream.on('error', (e) => { dbg('WS-PROXY', 'upstream-error', String(e), `t=${Date.now() - tUpstreamStart}ms`); socket.destroy(); });
      });
    },
  };
}

/**
 * Vite plugin: attach a Socket.IO server to the Astro dev HTTP server.
 *
 * Replaces the previous fan-out of 5 parallel `/api/apps/events` SSE
 * streams (theme, kv, app/activity, workspaces, kvClient) with one
 * shared bidirectional channel. Firefox capped us at 6 HTTP/1.1
 * connections per origin and silently dropped the lowest-priority SSE,
 * spamming "interrupted while the page was loading" on every reload.
 *
 * Path is `/os-events`. Transport is WS-only (`transports: ['websocket']`
 * on both client and server) so we live on the upgrade pipe — same
 * coexistence pattern as `wsProxyPlugin` — and never go through Astro's
 * regular HTTP request routing (no risk of double-writing responses).
 *
 * OsEventBus is a globalThis-pinned singleton (see
 * `packages/core/src/ipc/OsEventBus.ts:106-109`), so the import here
 * resolves to the SAME emitter object the SSE endpoint subscribes to,
 * regardless of which module instance Vite hands us.
 */
function sioPlugin() {
  return {
    name: 'aura-sio',
    async configureServer(server) {
      if (!server.httpServer) return;
      const { Server } = await import('socket.io');
      const { OsEventBus, compileTopicMatcher, parseTopicsParam } = await import('@aura/core');

      const io = new Server(server.httpServer, {
        path: '/os-events',
        transports: ['websocket'],
        serveClient: false,
        // Dev-only: any origin is OK because the shell isn't internet-
        // reachable. Tighten when we ship a production build.
        cors: { origin: true, credentials: false },
      });

      // Mirror of events.ts's relayed types. Kept in sync manually — when
      // a new event lands in OsEventBus, add it here too.
      const EVENT_TYPES = [
        'app:stateChanged', 'app:crashed', 'app:installed', 'app:removed',
        'app:enabledChanged', 'app:mruChanged',
        'activity:opened', 'activity:closed', 'activity:focus',
        'activity:navigated', 'activity:breadcrumbChanged',
        'theme:changed', 'mode:changed', 'notification',
        'workspaces:changed', 'workspace:activated', 'kv:changed',
      ];

      io.on('connection', (socket) => {
        sioDbg('connect', socket.id);
        let accepts = null;  // null = firehose; otherwise topic matcher

        const handlers = EVENT_TYPES.map((type) => {
          const fn = (ev) => {
            if (accepts && !accepts(type)) return;
            socket.emit('event', { type, ...ev });
          };
          OsEventBus.on(type, fn);
          return [type, fn];
        });

        // Client tells us which topics it cares about. Either CSV string
        // ("theme:*,kv:*") or an array (["theme:*","kv:*"]). null/empty/'*'
        // becomes a firehose subscription.
        socket.on('sub', (topics) => {
          const raw = Array.isArray(topics) ? topics.join(',') : (topics ?? '');
          const list = parseTopicsParam(raw || null);
          accepts = list ? compileTopicMatcher(list) : null;
          sioDbg('sub', socket.id, list ?? '*');
        });

        socket.on('disconnect', (reason) => {
          sioDbg('disconnect', socket.id, reason);
          for (const [type, fn] of handlers) OsEventBus.off(type, fn);
        });
      });

      sioDbg('attached', '/os-events', 'transports=websocket');
    },
  };
}

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  integrations: [react()],
  // Astro's floating dev toolbar (audits / settings / x-ray) sits in the
  // bottom-right of every page in dev mode and gets in the way of OS
  // chrome — covers the launcher button, intercepts clicks on the dock
  // edge. Apps all opt out of it; the shell should too.
  devToolbar: { enabled: false },
  security: {
    checkOrigin: false,
  },
  server: {
    port: 3000,
    host: true,
  },
  vite: {
    // Point workspace packages to their TypeScript source for full hot
    // reload — bare imports only. Subpath imports (`@aura/ui/styles/...`,
    // `@aura/ui/lib/...`) flow through pnpm's `node_modules/@aura/ui`
    // symlink so the `exports` map in @aura/ui's package.json kicks in,
    // and `ssr.noExternal: ['@aura/ui']` below can match by package name
    // (it would not match a pre-resolved file path).
    resolve: {
      alias: [
        { find: /^@aura\/core$/, replacement: resolve(__dirname, '../core/src/index.ts') },
        { find: /^@aura\/ui$/,   replacement: resolve(__dirname, '../ui/src/index.ts') },
      ],
    },
    server: {
      watch: {
        ignored: ['**/node_modules/**', '**/.git/**'],
      },
      // Sibling-container apps call back into the shell at `http://aura-shell:3000`
      // (the aura-net hostname). Vite 5+ rejects Host headers it hasn't been
      // told about, so without this the CLI from inside any container app
      // gets a 403 "Blocked request" on every call. `true` allows any host —
      // safe in our dev container, the shell isn't reachable from the public
      // internet.
      allowedHosts: true,
    },
    optimizeDeps: {
      // Exclude workspace-source packages so Vite reads them fresh from
      // their .ts source on each change (full HMR). @aura/ui used to be
      // here too, but its Radix sub-deps need pre-bundling for proper CJS
      // named-export interop (Vite can't surface `createRoot` from
      // react-dom/client otherwise — hydration explodes).
      exclude: ['@aura/core'],
      include: ['react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
    },
    // SSR-process @aura/ui through Vite (it ships .css + .tsx). Vite would
    // otherwise treat workspace packages as external and Node's native
    // loader would choke on `.css` ("Unknown file extension").
    //
    // @aura/core is here too so subpath imports (`@aura/core/keymap`,
    // `@aura/core/theme`) flow through Vite's HMR-aware loader instead
    // of Node's process-lifetime module cache — otherwise a `tsc` build
    // of @aura/core's dist requires a full container restart before the
    // shell sees the new code. The bare `@aura/core` import is already
    // aliased to src/index.ts above, but subpath imports bypass that
    // alias and hit the package's `exports` map → dist files → Node
    // loader cache.
    ssr: {
      noExternal: ['@aura/ui', '@aura/core', '@aura/kv-store', '@aura/app-sdk'],
    },
    // tailwindcss() must come before wsProxyPlugin so its content-scanning
    // hooks run on every transformed module.
    plugins: [tailwindcss(), proxyViteQueryEscape(), wsProxyPlugin(), sioPlugin()],
  },
});
