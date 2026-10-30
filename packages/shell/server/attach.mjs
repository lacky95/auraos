/**
 * The shell's own non-Astro servers, attached to whatever HTTP server serves
 * the Astro app:
 *   • dev  — astro.config.mjs Vite plugins call these from configureServer
 *            with Vite's `server.httpServer` (`astro dev`, HMR).
 *   • prod — server.mjs calls attachShellServers() on its own http.Server
 *            next to the built @astrojs/node handler (`astro build` + start).
 * One implementation for both, so dev and prod behave the same.
 *
 * Plain ESM (not TS): astro.config.mjs and server.mjs both load it with
 * Node's loader, before/without Vite.
 */
import { attachSseMux, MUX_PATH } from './sse-mux.mjs';

// Plain-inline mirror of @aura/core/logger's filter spec. These servers are
// attached before (dev: astro.config.mjs) or beside (prod: server.mjs) the
// Astro app and must not depend on @aura/core's build being present at load
// time. The filter syntax stays the same (AURA_LOG=ws-proxy, AURA_LOG=*, -x).
const WS_NS = 'ws-proxy';
export function nsEnabled(ns, filter) {
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
const MUX_NS = 'ssemux';
const SIO_NS = 'sio';
function sioDbg(tag, ...args) {
  if (!nsEnabled(SIO_NS, process.env.AURA_LOG ?? '')) return;
  console.log(`[${SIO_NS}]`, tag, ...args);
}

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
export async function fetchAppsList() {
  const shellPort = process.env.SHELL_PORT ?? process.env.AURA_SHELL_PORT ?? '3000';
  const res = await fetch(`http://127.0.0.1:${shellPort}/api/apps`, {
    signal: AbortSignal.timeout(2000),
  });
  if (!res.ok) throw new Error(`/api/apps → ${res.status}`);
  return res.json();
}

/**
 * Escape `?astro|?vue|?svelte` on /api/proxy/<id>/<path> so the shell's own
 * Vite (vite-plugin-astro) never claims an app's module URL; the proxy route
 * turns them back before forwarding upstream. Applied in prod too, so the
 * proxy route always sees the same request shape.
 */
export function escapeProxyViteQuery(url) {
  if (!url || !url.startsWith('/api/proxy/')) return url;
  if (!/[?&](astro|vue|svelte)(=|&|$)/.test(url)) return url;
  return url
    .replace(/(\?|&)astro(?=&|$)/g,    '$1_aura_vite_astro=1')
    .replace(/(\?|&)vue(?=&|=|$)/g,    '$1_aura_vite_vue')
    .replace(/(\?|&)svelte(?=&|=|$)/g, '$1_aura_vite_svelte');
}

/** Connect-style middleware form of escapeProxyViteQuery. */
export function proxyQueryEscapeMiddleware(req, _res, next) {
  if (req.url) req.url = escapeProxyViteQuery(req.url);
  next();
}

/**
 * Browser-leg keepalive interval for proxied WebSockets.
 *
 * The proxy relays MESSAGE frames only — a ping the upstream app sends stops
 * here (our `ws` client answers it itself) and never reaches the browser. So
 * an idle terminal leaves the browser↔shell leg completely silent, and silent
 * connections get reaped by whatever sits in between (reverse proxy, tunnel,
 * NAT conntrack, sleeping OS network stack). We therefore run an independent
 * heartbeat on the leg we own, and terminate a client that misses two pings so
 * the upstream learns about the drop immediately instead of leaking a relay.
 */
const WS_PING_MS = 25_000;

/** Proxy WebSocket upgrades for /api/proxy/[appId]/[path]. */
export function attachWsProxy(httpServer) {
  httpServer.on('upgrade', async (req, socket, head) => {
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
    // Forward auth-bearing request headers so cookie/token-authenticated
    // upstreams (e.g. Trilium's sync WS) accept the upgrade handshake.
    // The `ws` client owns the Host + Sec-WebSocket-* handshake headers,
    // so we pass only a safe allowlist and never hop-by-hop framing ones.
    const upstreamHeaders = {};
    for (const h of ['cookie', 'authorization']) {
      if (req.headers[h] != null) upstreamHeaders[h] = req.headers[h];
    }
    if (activityId) upstreamHeaders['x-aura-activity-id'] = activityId;
    const upstream = new WebSocket(upstreamUrl, {
      headers: Object.keys(upstreamHeaders).length ? upstreamHeaders : undefined,
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

        // Heartbeat the browser leg (see WS_PING_MS). `alive` flips true on
        // every pong; a sweep that finds it still false means the previous
        // ping went unanswered → the client is gone, terminate and let the
        // close handlers tear the pair down.
        let alive = true;
        client.on('pong', () => { alive = true; });
        const hb = setInterval(() => {
          if (!alive) {
            dbg('WS-PROXY', 'client-keepalive-timeout', instanceId);
            try { client.terminate(); } catch {}
            return;
          }
          alive = false;
          try { client.ping(); } catch {}
        }, WS_PING_MS);
        if (typeof hb.unref === 'function') hb.unref();

        client.on('close', () => { clearInterval(hb); upstream.terminate(); });
        upstream.on('close', () => { clearInterval(hb); try { client.terminate(); } catch {} });
      });
    });

    upstream.on('error', (e) => { dbg('WS-PROXY', 'upstream-error', String(e), `t=${Date.now() - tUpstreamStart}ms`); socket.destroy(); });
  });
}

/**
 * Attach the EventSource multiplexer to the shell's HTTP
 * server (see ./sse-mux.mjs for the why and the wire
 * protocol; the client half is injected by the proxy route).
 *
 * Path is `/_aura/sse-mux`, WS-only, so it lives on the upgrade pipe beside
 * `wsProxyPlugin` (which ignores non-/api/proxy URLs) and socket.io's
 * `/os-events`. Streams are re-fetched against our own HTTP origin, so they
 * keep going through `/api/proxy/...` with the page's cookies.
 */
export async function attachShellSseMux(httpServer) {
  const shellPort = process.env.SHELL_PORT ?? process.env.AURA_SHELL_PORT ?? '3000';
  await attachSseMux(httpServer, `http://127.0.0.1:${shellPort}`, (tag, ...args) => {
    if (!nsEnabled(MUX_NS, process.env.AURA_LOG ?? '')) return;
    console.log(`[${MUX_NS}]`, tag, ...args);
  });
  if (nsEnabled(MUX_NS, process.env.AURA_LOG ?? '')) console.log(`[${MUX_NS}]`, 'attached', MUX_PATH);
}

/**
 * Attach the Socket.IO server (`/os-events`) to the shell's HTTP server.
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
export async function attachSio(httpServer) {
  const { Server } = await import('socket.io');
  const core = await import('@aura/core');
  const { OsEventBus, compileTopicMatcher, parseTopicsParam } = core;

  // Phase 5: is a notification hidden on a LOCKED screen (secret by its
  // label or the user's override, or gone)? Memoised per event id, so N
  // sockets cost one lookup. Fails open to "hidden" (privacy first).
  const lockHidden = new Map();
  const hiddenWhenLocked = (ev) => {
    const key = ev && ev.eventId ? String(ev.eventId) : '';
    if (key && lockHidden.has(key)) return lockHidden.get(key);
    const p = (async () => {
      try {
        const svc = core.getNotificationService();
        if (typeof svc.viewById !== 'function' || typeof svc.accessFor !== 'function') return false;
        const access = await svc.accessFor({ principal: { kind: 'anonymous', verification: 'unverified' }, screen: { sid: '', lock: 'locked' } });
        return (await svc.viewById(String(ev.id ?? ''), access)) === null;
      } catch { return true; }
    })();
    if (key) {
      lockHidden.set(key, p);
      if (lockHidden.size > 500) lockHidden.delete(lockHidden.keys().next().value);
    }
    return p;
  };
  const socketLocked = async (sid) => {
    try {
      const cs = core.getAuthServices().clientSessions;
      return cs ? (await cs.effectiveLock(sid || null)) !== 'unlocked' : true;
    } catch { return true; }
  };

  const io = new Server(httpServer, {
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
    // (Phase 5: the legacy content-carrying 'notification' event is gone.)
    'theme:changed', 'mode:changed', 'ui:command',
    'workspaces:changed', 'workspace:activated', 'kv:changed',
    // OS restarts: a planned restart is starting (tabs flush + show it) /
    // the desktop session was restored after boot (lib/desktopSession.ts).
    'os:shuttingDown', 'session:restored',
    // Production shell: a watched rebuild was swapped in (server/watchRebuild.mjs).
    'shell:rebuilt',
    // Notification store lifecycle — content-free {eventId,id,state}.
    // Shell UI only: deliberately NOT relayed on api/apps/events.ts.
    // Phase 5: a socket whose client session is locked / unknown does
    // not get events of items hidden on the lock screen (secret).
    'notification:created', 'notification:updated', 'notification:displayed',
    'notification:seen', 'notification:resolved', 'notification:removed',
    // Phase 3: the user used a component (button without action, input,
    // options) — still content-free; the item keeps lastInteraction.
    'notification:interacted',
    // Admin grant / revoke of a privileged permission — {subjectKind,
    // subjectId, permission, change}, no secrets (core auth GrantStore).
    'permissions:changed',
  ];

  io.on('connection', (socket) => {
    sioDbg('connect', socket.id);
    let accepts = null;  // null = firehose; otherwise topic matcher
    // Phase 5: the tab's shell client session (handshake auth, then 'cs'
    // updates). Not a credential — it only selects the lock-screen filter.
    const hs = socket.handshake && socket.handshake.auth ? socket.handshake.auth.cs : '';
    let sid = typeof hs === 'string' ? hs.slice(0, 200) : '';
    socket.on('cs', (v) => { sid = typeof v === 'string' ? v.slice(0, 200) : ''; });
    // Notification events go through one chain per socket, so the async
    // filter never reorders them.
    let notifChain = Promise.resolve();

    const handlers = EVENT_TYPES.map((type) => {
      const fn = (ev) => {
        if (accepts && !accepts(type)) return;
        if (type.startsWith('notification:')) {
          notifChain = notifChain.then(async () => {
            if (await socketLocked(sid) && await hiddenWhenLocked(ev)) return;
            socket.emit('event', { type, ...ev });
          }).catch(() => {});
          return;
        }
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
}

/** Everything the shell needs on its HTTP server besides the Astro app. */
export async function attachShellServers(httpServer) {
  attachWsProxy(httpServer);
  await attachShellSseMux(httpServer);
  await attachSio(httpServer);
}
