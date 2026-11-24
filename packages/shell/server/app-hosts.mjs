/**
 * App hosts — the Host-header router in front of everything else.
 *
 * A request for `{name}--{desktop host}` (e.g. `marklayer--10-201-1-2.nip.io:3000`)
 * whose `name` an installed manifest declares in `hosts[]` is streamed to that
 * app's server or sidecar, minus the shell's own credentials: no prefix, no HTML/JS rewriting, no
 * injected scripts, no cookie scoping. The app owns the origin root. Every
 * other request goes on to the shell exactly as before. Docs: /docs/app-hosts;
 * the rules live in @aura/core/host-rules, which has no dependencies, so this
 * file can load before / beside the Astro build.
 *
 * Interception wraps the HTTP server's `emit` for `request` and `upgrade`, so
 * a claimed request never reaches Astro, Vite, socket.io (whose engine.io
 * would end an upgrade it doesn't own after 1 s) or the /api/proxy WS proxy.
 * The claim is synchronous: it reads a host index rebuilt from the shell's own
 * /api/apps (the same source the WS proxy uses, see attach.mjs).
 *
 * Two paths share this file while apps migrate:
 *   `frameRoute: proxy` (the default) keeps the manifest-host behavior above.
 *   `frameRoute: host` resolves the exact label through the App Host registry.
 *   Nothing reaches such an app without a valid app cookie from the one-time
 *   handoff, and `/_aura/*` is answered here, never by the app.
 *
 * Env:
 *   AURA_TRUSTED_PROXIES  comma-separated client addresses whose
 *                         X-Forwarded-Proto/-Host/-For are believed (the edge
 *                         in front of a custom domain). See host-policy.mjs.
 *                         On the `proxy` path, unset still believes any.
 *   AURA_HOST_POLICY      `report` (default) or `enforce`, see host-policy.mjs.
 */
import http from 'node:http';
import net from 'node:net';
import {
  APP_HOST_ROUTE_HEADER, AURA_RESERVED_PATHS, appHostCookieName, isAuraReservedPath, parseAppHost,
} from '@aura/core/host-rules';
import {
  SESSION_COOKIES, countSurfaceEvent, internalServiceHeaders, observeHttpSurface, reportSurface, surfaceIdentity,
} from './access-bridge.mjs';
import { appHostAuth, appHostEmbedCookieName, safeReturnPath } from './app-host-auth.mjs';
import { handleAppGateway, handleAppGatewayUpgrade, serveAppRuntime } from './app-gateway.mjs';
import { classifyHost, hostPolicy, isTrustedProxy, originOf, requestEdge } from './host-policy.mjs';
import { stripCookies, stripShellCredentials } from './shell-credentials.mjs';
import { EMBEDDER_PARAM } from './terminal-embed.mjs';

export { classifyHost } from './host-policy.mjs';

/** `name` of a `{name}--{base}` Host header, or null. */
export function appHostName(host) {
  if (!host) return null;
  return parseAppHost(String(host))?.name ?? null;
}

// ── helpers ─────────────────────────────────────────────────────────────────

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);
const INDEX_TTL_MS = 2000;
const START_RETRY_MS = 15_000;

// PHASE2-CUTOVER: the `proxy` path believes any peer when no proxy is configured.
const legacyTrusted = (addr) => !(process.env.AURA_TRUSTED_PROXIES ?? '').split(',').some((s) => s.trim())
  || isTrustedProxy(addr);

/** Never sent to an app, and an app may not set them. */
const AURA_COOKIES = new Set([
  appHostCookieName(true), appHostCookieName(false), appHostEmbedCookieName(true), appHostEmbedCookieName(false), ...SESSION_COOKIES,
]);
const AURA_BEARER = /(?:^|,)\s*Bearer\s+(?:aura-(?:sess1|admin1)\.|aura1\.|aura_k1_)/i;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const EXACT_ORIGIN_RE = /^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?$/;

/**
 * Apps whose App Host answers its own pages only (5.16 safeguard 3): the
 * Terminal's HTTP session control and PTY socket are the owner's shell, and a
 * same-site sibling page can send this host's cookie. A navigation may still
 * arrive from the Shell or an embedder; `frame-ancestors` decides where it shows.
 */
const OWN_ORIGIN_ONLY_APPS = new Set(['com.aura.terminal']);
/**
 * Over plain HTTP browsers send no Sec-Fetch-*, and a no-cors GET no Origin,
 * so such an app's API also needs this header from its own page: a sibling
 * can't add it without a CORS preflight, which the Origin check refuses.
 */
export const SAME_ORIGIN_HEADER = 'x-aura-same-origin';
/** The app's API. `/api/os/*` there is the SDK's redirect to shell assets (a `<link>` can't add a header). */
const OWN_API_RE = /^\/(?:api(?:\/|$)(?!os\/)|mcp(?:\/|$))/;

/**
 * What a restricted embed cookie may load besides its document (5.16): built
 * assets (`/_astro/`, Vite's `/@…` and `/node_modules/` in dev, any file with
 * an extension other than HTML), never the app's API, MCP or another page.
 */
const EMBED_ASSET_RE = /^\/(?:_astro\/|@|node_modules\/|(?:[^?#]*\/)?[^/?#]+\.(?!html?$)[A-Za-z0-9]{1,8}$)/i;
/** Shell assets an embedded page may fetch through its gateway: the theme and icons, nothing with an identity. */
const EMBED_GATEWAY_RE = /^\/_aura\/os\/api\/os\/(?:theme\.css|icons\.svg|icons\/[A-Za-z0-9._-]{1,64}\.svg)$/;

/** Whether `params` name exactly the session and embedder a restricted cookie was issued for. */
function namesEmbed(params, embed) {
  return params.get('embed') === '1' && params.get('session') === embed.sessionId
    && params.get(EMBEDDER_PARAM) === embed.embedder;
}

/**
 * A request on a restricted embed cookie: its `?embed=1&session=` document,
 * that page's assets, the runtime and the shell's theme and icons. Reads only.
 * The PTY socket is checked in `serveHostUpgrade`.
 */
function embedRequestAllowed(req, url, path, embed) {
  if (!SAFE_METHODS.has(req.method) || req.method === 'OPTIONS') return false;
  if (path === '/') {
    try { return namesEmbed(new URL(url, 'http://h').searchParams, embed); } catch { return false; }
  }
  if (path === AURA_RESERVED_PATHS.runtime) return true;
  if (isAuraReservedPath(url)) return EMBED_GATEWAY_RE.test(path);
  return !OWN_API_RE.test(path) && EMBED_ASSET_RE.test(path);
}

const isLive = (i) => i.port != null && (i.state === 'resumed' || i.state === 'started');

// PHASE2-CUTOVER: `frameRoute: host` routes by slot assignment and never to a pool member.
function liveInstance(app) {
  const live = (app.instances ?? []).filter(isLive);
  return live.find((i) => !i.inPool) ?? live[0] ?? null;
}

/** X-Forwarded-* for the upstream, from what the client (or a trusted edge) said. */
function forwardedHeaders(req, edge = null) {
  const fromEdge = edge ? edge.fromEdge : legacyTrusted(req.socket?.remoteAddress);
  const host = edge ? edge.host : ((fromEdge && req.headers['x-forwarded-host']) || req.headers.host || '');
  const protoIn = fromEdge && !edge ? String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() : '';
  const proto = edge ? edge.scheme : (protoIn === 'https' || protoIn === 'http' ? protoIn : (req.socket?.encrypted ? 'https' : 'http'));
  const port = String(host).match(/:(\d+)$/)?.[1] ?? (proto === 'https' ? '443' : '80');
  const priorFor = fromEdge ? req.headers['x-forwarded-for'] : undefined;
  const client = String(req.socket?.remoteAddress ?? '').replace(/^::ffff:/, '');
  return {
    'x-forwarded-host': String(host),
    'x-forwarded-proto': proto,
    'x-forwarded-port': port,
    'x-forwarded-for': priorFor ? `${priorFor}, ${client}` : client,
  };
}

function page(status, title, body, { refresh = 0 } = {}) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + (refresh ? `<meta http-equiv="refresh" content="${refresh}">` : '')
    + `<title>${esc(title)}</title><style>body{font:15px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;color:#333;background:#fafafa}`
    + `@media(prefers-color-scheme:dark){body{color:#ddd;background:#1b1b1b}}main{max-width:32rem;padding:24px;text-align:center}code{font-size:13px}</style></head>`
    + `<body><main><h1 style="font-size:18px">${esc(title)}</h1><p>${body}</p></main></body></html>`;
}

function reply(res, status, title, body, opts = {}) {
  const html = page(status, title, body, opts);
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    ...(opts.refresh ? { 'retry-after': String(opts.refresh) } : {}),
    ...opts.headers,
  });
  res.end(html);
}

// ── frameRoute: host ────────────────────────────────────────────────────────

/** Request headers for the app, as a flat list: no Aura credential or identity claim. */
function appRequestHeaders(req, surface, { keepUpgrade = false } = {}) {
  const raw = stripShellCredentials(req.rawHeaders, surface);
  const out = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = String(raw[i]).toLowerCase();
    let value = raw[i + 1];
    if (!keepUpgrade && HOP_BY_HOP.has(name)) continue;
    if (name.startsWith('x-aura-') || name.startsWith('x-forwarded-') || name === 'forwarded') continue;
    if (name === 'authorization' && AURA_BEARER.test(String(value))) continue;
    if (name === 'cookie') {
      value = stripCookies(value, AURA_COOKIES);
      if (value === null) continue;
    }
    out.push(raw[i], value);
  }
  return out;
}

const setCookieName = (value) => String(value).split('=', 1)[0].trim().toLowerCase();

/** Response headers for the browser: the shell decides who may frame this origin. */
function appResponseHeaders(rawHeaders, frameAncestors) {
  const out = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = rawHeaders[i].toLowerCase();
    if (HOP_BY_HOP.has(name) || name === 'x-frame-options' || name.startsWith('x-aura-')) continue;
    if (name === 'set-cookie' && AURA_COOKIES.has(setCookieName(rawHeaders[i + 1]))) continue;
    out.push(rawHeaders[i], rawHeaders[i + 1]);
  }
  // A second policy can only narrow the app's own.
  out.push('content-security-policy', `frame-ancestors ${frameAncestors.join(' ')}`);
  return out;
}

/**
 * Exact Origin for a request that a same-site sibling could otherwise send
 * with this app's cookie. A same-origin EventSource or GET sends no Origin, so
 * there Sec-Fetch-Site decides.
 */
function browserRequestAllowed(req, edge, path, ownOriginOnly = false) {
  const origin = req.headers.origin;
  if (ownOriginOnly) {
    if (origin !== undefined && origin !== edge.origin) return false;
    const site = req.headers['sec-fetch-site'];
    const sameOrigin = site === undefined || site === 'same-origin' || site === 'none';
    if (!sameOrigin && !(req.headers['sec-fetch-mode'] === 'navigate' && SAFE_METHODS.has(req.method))) return false;
    if (OWN_API_RE.test(path)) return origin === edge.origin || req.headers[SAME_ORIGIN_HEADER] === '1';
    return true;
  }
  const stream = String(req.headers.accept ?? '').includes('text/event-stream') || path.startsWith('/socket.io/');
  if (SAFE_METHODS.has(req.method) && !stream) return true;
  if (origin !== undefined) return origin === edge.origin;
  const site = req.headers['sec-fetch-site'];
  return site === undefined || site === 'same-origin' || site === 'none';
}

// ── the router ──────────────────────────────────────────────────────────────

/** The Activity a request names, kept only when it belongs to `instanceId`. */
export function activityHeaders(url, instanceId) {
  let id = null;
  try { id = new URL(url ?? '/', 'http://app.invalid').searchParams.get('_aura_activity'); } catch { /* no activity */ }
  return id?.startsWith(`${instanceId}#`) ? { 'x-aura-activity-id': id } : {};
}

/**
 * @param {{
 *   appsList: (opts?: { fresh?: boolean }) => Promise<any[]>,
 *   shellPort?: string,
 *   log?: (...a: any[]) => void,
 *   services?: () => Promise<any>,
 *   auth?: any,
 *   embedAncestors?: (ctx: { record: any, slot: any, session: any, url: string, edge: any, base: string, registry: any }) => string[] | Promise<string[]>,
 *   env?: Record<string, string | undefined>,
 * }} deps
 *   `appsList` = the shell's /api/apps (manifest + instances per app).
 *   `services` = the App Host registry and session check; null keeps every
 *   request on the `proxy` path.
 *   `embedAncestors` = extra exact origins allowed to frame an `embed=1`
 *   document (5.16): the Terminal's granted embedder (terminal-embed.mjs).
 */
export function createAppHostRouter({
  appsList, shellPort = process.env.SHELL_PORT ?? '3000', log = () => {},
  services = async () => null, auth = null, embedAncestors = () => [], env = process.env,
}) {
  /** name → appId; null until the first load. */
  let index = null;
  let indexAt = 0;
  let loading = null;
  const startAsked = new Map();   // appId → when we last asked the shell to start it
  const slotStarts = new Map();   // installation and scope → the slot-1 start in flight
  const hostAuth = () => (auth ??= appHostAuth());

  function load(fresh = false) {
    loading ??= appsList({ fresh }).then((apps) => {
      const next = new Map();
      for (const a of apps) {
        for (const h of a.manifest?.hosts ?? []) if (!next.has(h.name)) next.set(h.name, a.manifest.id);
      }
      index = next;
      indexAt = Date.now();
      return apps;
    }).finally(() => { loading = null; });
    return loading;
  }

  /** Synchronous: is this request for an app host? */
  function claims(req) {
    const name = appHostName(req.headers.host);
    if (!name) return null;
    if (Date.now() - indexAt > INDEX_TTL_MS) void load().catch(() => {});
    // Before the first load: claim anything that parses (a cold shell has no
    // desktop yet either). After it: only names an app declares.
    if (index && !index.has(name)) return null;
    return name;
  }

  /** The upstream {host, port, appId, service} for `name`, or {starting}/{missing}. */
  async function resolve(name) {
    let apps = await load();
    let app = apps.find((a) => (a.manifest?.hosts ?? []).some((h) => h.name === name));
    if (!app) { apps = await load(true); app = apps.find((a) => (a.manifest?.hosts ?? []).some((h) => h.name === name)); }
    if (!app) return { missing: true };
    const spec = app.manifest.hosts.find((h) => h.name === name);
    const appId = app.manifest.id;
    const inst = liveInstance(app);
    if (!inst) {
      const last = startAsked.get(appId) ?? 0;
      if (Date.now() - last > START_RETRY_MS) {
        startAsked.set(appId, Date.now());
        log('start', appId);
        const startUrl = `http://127.0.0.1:${shellPort}/api/apps/${encodeURIComponent(appId)}/start`;
        fetch(startUrl, { method: 'POST', headers: internalServiceHeaders(startUrl), signal: AbortSignal.timeout(10_000) })
          .catch((err) => log('start-failed', appId, String(err)));
      }
      return { starting: true, appId, appName: app.manifest.name ?? appId };
    }
    if (spec.service) {
      const tpl = (app.manifest.services ?? []).find((s) => s.name === spec.service);
      return { host: `aura-${inst.instanceId}--${spec.service}`, port: spec.port ?? tpl?.port, appId, instanceId: inst.instanceId, sidecar: true, appName: app.manifest.name ?? appId };
    }
    return {
      host: inst.sandbox === 'container' ? `aura-${inst.instanceId}` : '127.0.0.1',
      port: spec.port ?? inst.port, appId, instanceId: inst.instanceId, sidecar: false, appName: app.manifest.name ?? appId,
    };
  }

  function identityHeaders(t) {
    return { 'x-aura-app-id': t.appId, 'x-aura-instance-id': t.instanceId };
  }

  // PHASE2-CUTOVER: the open manifest-host path (this and handleUpgrade) ends with `frameRoute: proxy`.
  async function handleRequest(name, req, res) {
    const identity = surfaceIdentity(req.headers);
    const method = req.method;
    let reportedApp = null;
    res.once('close', () => reportSurface({
      subject: 'app-hosts', method, identity, appId: reportedApp, status: res.headersSent ? res.statusCode : 0,
    }));
    let t;
    try { t = await resolve(name); } catch (err) {
      return reply(res, 503, 'AuraOS is starting', 'The app list is not available yet. This page reloads by itself.', { refresh: 3 });
    }
    if (t.missing) return reply(res, 404, `No app host “${name}”`, `No installed app declares the host <code>${name}</code>.`);
    reportedApp = t.appId ?? null;
    if (t.starting) return reply(res, 503, `Starting ${t.appName}…`, 'This page reloads by itself when it is up.', { refresh: 2 });

    // PHASE2-CUTOVER: the SDK's loader asks every `--` host for the runtime; this path has none to give.
    if (String(req.url ?? '').split(/[?#]/, 1)[0] === AURA_RESERVED_PATHS.runtime) {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      return res.end();
    }

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(k)) headers[k] = v;
    delete headers[APP_HOST_ROUTE_HEADER];
    stripShellCredentials(headers, 'app-hosts-http');
    Object.assign(headers, forwardedHeaders(req), identityHeaders(t));
    pipeHttp(name, t, req, res, headers, (raw) => {
      const out = [];
      for (let i = 0; i < raw.length; i += 2) {
        if (!HOP_BY_HOP.has(raw[i].toLowerCase())) out.push(raw[i], raw[i + 1]);
      }
      return out;
    });
  }

  function pipeHttp(name, t, req, res, headers, responseHeaders) {
    const up = http.request({ host: t.host, port: t.port, method: req.method, path: req.url, headers }, (ures) => {
      // An app server that answers with another app's identity is a stale port.
      const declared = ures.headers['x-aura-app-id'];
      if (!t.sidecar && declared && declared !== t.appId) {
        ures.resume();
        log('identity-mismatch', name, declared);
        return reply(res, 502, `${t.appName} is restarting`, 'This page reloads by itself.', { refresh: 2 });
      }
      res.writeHead(ures.statusCode ?? 502, ures.statusMessage, responseHeaders(ures.rawHeaders));
      ures.pipe(res);
    });
    up.on('error', (err) => {
      log('upstream-error', name, `${t.host}:${t.port}`, String(err));
      if (res.headersSent) { res.destroy(); return; }
      reply(res, 503, `Starting ${t.appName}…`, 'This page reloads by itself when it is up.', { refresh: 2 });
    });
    req.on('aborted', () => up.destroy());
    res.on('close', () => { if (!res.writableFinished) up.destroy(); });
    req.pipe(up);
  }

  async function handleUpgrade(name, req, socket, head) {
    const identity = surfaceIdentity(req.headers);
    let reportedApp = null;
    let reported = false;
    const reportUpgrade = (status) => {
      if (reported) return;
      reported = true;
      reportSurface({ subject: 'app-hosts', method: 'UPGRADE', identity, appId: reportedApp, status });
    };
    const fail = (status, text) => {
      reportUpgrade(status);
      try { socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { /* gone */ }
    };
    socket.on('error', () => {});
    let t;
    try { t = await resolve(name); } catch { return fail(503, 'Service Unavailable'); }
    if (t.missing) return fail(404, 'Not Found');
    reportedApp = t.appId ?? null;
    if (t.starting) return fail(503, 'Service Unavailable');

    // Byte-for-byte: the original request line and headers (Host kept), plus
    // X-Forwarded-*; then a plain TCP pipe. Subprotocols, extensions and the
    // app's own pings pass through untouched.
    const extra = { ...forwardedHeaders(req), ...identityHeaders(t) };
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    const rawHeaders = stripShellCredentials(req.rawHeaders, 'app-hosts-upgrade');
    for (let i = 0; i < rawHeaders.length; i += 2) {
      const key = rawHeaders[i].toLowerCase();
      if (!(key in extra) && key !== APP_HOST_ROUTE_HEADER) lines.push(`${rawHeaders[i]}: ${rawHeaders[i + 1]}`);
    }
    for (const [k, v] of Object.entries(extra)) lines.push(`${k}: ${v}`);
    pipeUpgrade(name, t, socket, head, lines, reportUpgrade, fail);
  }

  function pipeUpgrade(name, t, socket, head, lines, reportUpgrade, fail) {
    const upstream = net.connect(t.port, t.host, () => {
      reportUpgrade(101);
      upstream.write(lines.join('\r\n') + '\r\n\r\n');
      if (head?.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    const drop = () => { socket.destroy(); upstream.destroy(); };
    upstream.on('error', (err) => {
      log('upgrade-error', name, `${t.host}:${t.port}`, String(err));
      if (socket.bytesWritten === 0) fail(503, 'Service Unavailable'); else drop();
    });
    socket.on('close', drop);
    upstream.on('close', drop);
  }

  // ── frameRoute: host ──────────────────────────────────────────────────────

  /**
   * Where a `{label}--…` request goes. Throws when the registry can't answer,
   * and the caller refuses the request: an unreachable registry must not put a
   * `host` app back on the open `proxy` path.
   */
  async function decide(host, name) {
    // The first load also boots the KV store the registry reads.
    if (!index) await load().catch(() => {});
    const svc = await services();
    if (!svc) return { to: 'proxy' };
    if (!index) throw new Error('app list unavailable');
    if (host.kind === 'app') {
      const found = await svc.registry.resolveLabel(host.label);
      if (found.status === 'retired') return { to: 'gone' };
      if (found.status === 'reserved') return { to: 'missing' };
      if (found.status === 'active' && await svc.frameRoute(found.record.appId) === 'host') {
        return { to: 'host', svc, record: found.record, slot: found.slot, label: host.label, base: host.base };
      }
    }
    // A `host` app's manifest names carry no handoff, so they can't stay open.
    const declaring = name ? index?.get(name) : null;
    if (declaring && await svc.frameRoute(declaring) === 'host') return { to: 'denied' };
    if (!declaring && hostPolicy(env) === 'enforce') return { to: 'missing' };
    return { to: 'proxy' };
  }

  /**
   * The verified app cookie's payload, or null. The full cookie wins; without
   * one, the restricted embed cookie's payload (it carries `embed`).
   */
  async function appSession(route, req, edge) {
    const secure = edge.scheme === 'https';
    const expected = { aud: edge.origin, label: route.label, installationId: route.record.installationId };
    const payload = hostAuth().readCookie(req.headers.cookie, appHostCookieName(secure), expected)
      ?? hostAuth().readCookie(req.headers.cookie, appHostEmbedCookieName(secure), { ...expected, embed: true });
    if (!payload) return null;
    return (await route.svc.sessionLive(payload.sid)) ? payload : null;
  }

  /** Asks for a start, once at a time. `start()` claims the slot in the lifecycle. */
  function startSlotOne({ record }) {
    const scope = record.instanceScope.kind === 'user' ? `user:${record.instanceScope.userId}` : 'shared';
    const key = `${record.installationId}\0${scope}`;
    if (slotStarts.has(key) || Date.now() - (startAsked.get(key) ?? 0) <= START_RETRY_MS) return;
    startAsked.set(key, Date.now());
    log('start', record.appId);
    const startUrl = `http://127.0.0.1:${shellPort}/api/apps/${encodeURIComponent(record.appId)}/start`;
    const flight = (async () => {
      const r = await fetch(startUrl, { method: 'POST', headers: internalServiceHeaders(startUrl), signal: AbortSignal.timeout(30_000) });
      if (!r.ok) throw new Error(`start ${r.status}`);
    })().catch((err) => log('start-failed', record.appId, String(err)))
      .finally(() => slotStarts.delete(key));
    slotStarts.set(key, flight);
  }

  /**
   * The assigned live instance, or {missing}/{starting}/{notReady}. A running
   * instance without this slot gets no traffic. Only slot 1 asks for a start.
   */
  async function slotTarget(route) {
    const { record, slot } = route;
    const find = (apps) => apps.find((a) => a.manifest?.id === record.appId);
    const assigned = (app) => (app?.instances ?? []).find((i) => i.instanceId === slot.instanceId && !i.inPool && isLive(i));
    let app = find(await load());
    if (!app || (slot.instanceId && !assigned(app))) app = find(await load(true));
    if (!app || app.manifest.componentType === 'service') return { missing: true };
    const appName = app.manifest.name ?? record.appId;
    const inst = slot.instanceId ? assigned(app) : null;
    if (inst) {
      return {
        host: inst.sandbox === 'container' ? `aura-${inst.instanceId}` : '127.0.0.1',
        port: inst.port, appId: record.appId, instanceId: inst.instanceId, sidecar: false, appName,
      };
    }
    if (slot.slot !== 1) return { notReady: true, appName };
    startSlotOne(route);
    return { starting: true, appName };
  }

  async function frameAncestors(route, edge, session, url) {
    // 'self': an app may frame its own pages (Steel's Live view embeds its ui/).
    // Every ancestor must match, so the chain still has to start at the shell.
    const ancestors = ["'self'", originOf(edge.scheme, route.base)];
    if (session && new URL(url, 'http://h').searchParams.get('embed') === '1') {
      let extra = [];
      try {
        extra = await embedAncestors({
          record: route.record, slot: route.slot, session, url, edge, base: route.base, registry: route.svc.registry,
        });
      } catch { extra = []; }
      for (const o of Array.isArray(extra) ? extra : []) {
        if (EXACT_ORIGIN_RE.test(o) && !ancestors.includes(o)) ancestors.push(o);
      }
    }
    return ancestors;
  }

  function redeemHandoff(route, req, res, edge, pageHeaders) {
    const refuse = () => reply(res, 403, 'This link has expired', 'Open the app from the AuraOS desktop.', { headers: pageHeaders });
    if (req.method !== 'GET') return refuse();
    let code, next;
    try {
      const params = new URL(req.url, 'http://h').searchParams;
      code = params.get('code');
      next = safeReturnPath(params.get('next'));
    } catch { return refuse(); }
    const entry = hostAuth().consumeCode(code, { aud: edge.origin, label: route.label });
    // Moving an iframe reloads its src, a code already spent. A browser that
    // still holds this host's cookie just continues to the page.
    if (!entry && next) {
      return appSession(route, req, edge).then((session) => {
        if (!session) return refuse();
        res.writeHead(303, { location: next, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
        res.end();
      });
    }
    if (!entry || entry.claim.installationId !== route.record.installationId || entry.claim.slot !== route.slot.slot) return refuse();
    const location = safeReturnPath(entry.claim.returnPath);
    if (!location) return refuse();
    return route.svc.sessionLive(entry.claim.sid).then((live) => {
      if (!live) return refuse();
      const secure = edge.scheme === 'https';
      const { value, maxAgeSeconds } = hostAuth().sealCookie(entry);
      // An embed code signs in for its one session only, under its own name.
      const name = entry.claim.embed ? appHostEmbedCookieName(secure) : appHostCookieName(secure);
      res.writeHead(303, {
        location,
        'set-cookie': `${name}=${value}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly${secure ? '; Secure' : ''}; SameSite=Lax`,
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      });
      res.end();
    });
  }

  async function serveHostRequest(route, req, res, edge) {
    const url = String(req.url ?? '');
    const pageHeaders = {
      'content-security-policy': `frame-ancestors ${originOf(edge.scheme, route.base)}`,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    };
    const page = (status, title, body, opts = {}) => reply(res, status, title, body, { ...opts, headers: pageHeaders });
    // Absolute-form targets would hide the path from the reserved check.
    if (!url.startsWith('/')) return page(400, 'Bad request', 'This request can\'t be served.');
    const path = url.split(/[?#]/, 1)[0];
    if (path === AURA_RESERVED_PATHS.handoff) return redeemHandoff(route, req, res, edge, pageHeaders);
    if (path === AURA_RESERVED_PATHS.hostProbe) {
      res.writeHead(204, { 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
      return res.end();
    }

    const session = await appSession(route, req, edge);
    if (!session) return page(401, 'Open this app from AuraOS', 'This address needs a sign-in from the AuraOS desktop.');
    if (!browserRequestAllowed(req, edge, path, OWN_ORIGIN_ONLY_APPS.has(route.record.appId))) {
      return page(403, 'Request refused', 'This request came from another origin.');
    }
    if (session.embed && !embedRequestAllowed(req, url, path, session.embed)) {
      return page(403, 'Request refused', 'This sign-in shows one embedded session only.');
    }

    if (isAuraReservedPath(url)) {
      if (path === AURA_RESERVED_PATHS.runtime) return serveAppRuntime(req, res, { record: route.record, slot: route.slot });
      if (path.startsWith(AURA_RESERVED_PATHS.os)) return handleAppGateway(req, res, { record: route.record, slot: route.slot, session, services: route.svc });
      return page(404, 'Not found', 'This path is reserved by AuraOS.');
    }

    const t = await slotTarget(route);
    if (t.missing) return page(404, 'No app here', 'This app has no page at this address.');
    if (t.notReady) return page(503, `${t.appName} is not ready`, 'No running instance holds this address. Open the app again from the AuraOS desktop.');
    if (t.starting) return page(503, `Starting ${t.appName}…`, 'This page reloads by itself when it is up.', { refresh: 2 });
    const headers = appRequestHeaders(req, 'app-hosts-http');
    for (const [k, v] of Object.entries({ ...forwardedHeaders(req, edge), ...identityHeaders(t), ...activityHeaders(req.url, t.instanceId), [APP_HOST_ROUTE_HEADER]: 'host' })) headers.push(k, v);
    const ancestors = await frameAncestors(route, edge, session, url);
    // The embed document still needs the grant its code was issued under.
    if (session.embed && path === '/' && ancestors.length <= 2) return page(403, 'Request refused', 'This embedded session is no longer granted.');
    pipeHttp(route.label, t, req, res, headers, (raw) => appResponseHeaders(raw, ancestors));
  }

  async function serveHostUpgrade(route, req, socket, head, edge) {
    const identity = surfaceIdentity(req.headers);
    let reported = false;
    const reportUpgrade = (status) => {
      if (reported) return;
      reported = true;
      reportSurface({ subject: 'app-hosts', method: 'UPGRADE', identity, appId: route.record.appId, status });
    };
    const fail = (status, text) => {
      reportUpgrade(status);
      try { socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { /* gone */ }
    };
    socket.on('error', () => {});
    const url = String(req.url ?? '');
    const mux = url.split(/[?#]/, 1)[0] === `${AURA_RESERVED_PATHS.os}sse-mux`;
    if (!url.startsWith('/') || (!mux && isAuraReservedPath(url))) return fail(404, 'Not Found');
    if (req.headers.origin !== edge.origin) return fail(403, 'Forbidden');
    let t;
    try {
      const session = await appSession(route, req, edge);
      if (!session) return fail(401, 'Unauthorized');
      if (mux && session.embed) return fail(403, 'Forbidden');
      if (mux) {
        reportUpgrade(0);   // the gateway answers the handshake
        return await handleAppGatewayUpgrade(req, socket, head, { record: route.record, slot: route.slot, session });
      }
      // An embedded page's socket (5.16) needs the embed grant its frame needed,
      // so revoking the grant also ends every reconnect. It attaches only to
      // the session the grant names, and a restricted cookie to nothing else.
      const params = new URL(url, 'http://h').searchParams;
      if (session.embed && (url.split(/[?#]/, 1)[0] !== '/ws' || !namesEmbed(params, session.embed))) {
        return fail(403, 'Forbidden');
      }
      if (params.get('embed') === '1') {
        if (params.get('_aura_session') !== params.get('session')) return fail(403, 'Forbidden');
        const ancestors = await frameAncestors(route, edge, session, url);
        if (ancestors.length <= 2) return fail(403, 'Forbidden');
      }
      t = await slotTarget(route);
    } catch { return fail(503, 'Service Unavailable'); }
    if (t.missing) return fail(404, 'Not Found');
    if (t.starting || t.notReady) return fail(503, 'Service Unavailable');
    const extra = { ...forwardedHeaders(req, edge), ...identityHeaders(t), ...activityHeaders(req.url, t.instanceId), [APP_HOST_ROUTE_HEADER]: 'host' };
    const raw = appRequestHeaders(req, 'app-hosts-upgrade', { keepUpgrade: true });
    const lines = [`${req.method} ${url} HTTP/${req.httpVersion}`];
    for (let i = 0; i + 1 < raw.length; i += 2) lines.push(`${raw[i]}: ${raw[i + 1]}`);
    for (const [k, v] of Object.entries(extra)) lines.push(`${k}: ${v}`);
    pipeUpgrade(route.label, t, socket, head, lines, reportUpgrade, fail);
  }

  function refuse(event, target, status, title, body, opts = {}) {
    if (event === 'request') return reply(target, status, title, body, opts);
    target.on('error', () => {});
    try { target.end(`HTTP/1.1 ${status} ${title}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { /* gone */ }
    return undefined;
  }

  async function routeLabeled(host, event, req, rest, passOn) {
    const target = rest[0];
    try {
      const route = await decide(host, appHostName(req.headers.host));
      if (route.to === 'host') {
        const edge = requestEdge(req, env);
        if (event === 'request') {
          const identity = surfaceIdentity(req.headers);
          const method = req.method;
          target.once('close', () => reportSurface({
            subject: 'app-hosts', method, identity, appId: route.record.appId, status: target.headersSent ? target.statusCode : 0,
          }));
          await serveHostRequest(route, req, target, edge);
        }
        else await serveHostUpgrade(route, req, target, rest[1], edge);
        return;
      }
      if (route.to === 'gone') return refuse(event, target, 410, 'Gone', 'This app was removed, and its address is not used again.');
      if (route.to === 'missing') return refuse(event, target, 404, 'Not Found', 'No app uses this address.');
      if (route.to === 'denied') return refuse(event, target, 403, 'Forbidden', 'Open this app from the AuraOS desktop.');
      const name = claims(req);
      if (!name) return passOn();
      if (event === 'request') await handleRequest(name, req, target);
      else await handleUpgrade(name, req, target, rest[1]);
    } catch (err) {
      log('route-failed', err?.name ?? 'error');
      if (event === 'request' && target.headersSent) { target.destroy(); return; }
      refuse(event, target, 503, 'Service Unavailable', 'AuraOS could not check this address. This page reloads by itself.', { refresh: 3 });
    }
  }

  /**
   * Put the router in front of `server`: claimed `request`/`upgrade` events
   * are handled here and never emitted to the server's other listeners.
   */
  function attach(server) {
    if (server.__auraAppHosts) return;
    server.__auraAppHosts = true;
    const emit = server.emit;
    server.emit = function (event, req, ...rest) {
      if (event === 'request' || event === 'upgrade') {
        const passOn = () => {
          if (event === 'request') observeHttpSurface(req, rest[0]);
          return emit.call(this, event, req, ...rest);
        };
        const host = classifyHost(requestEdge(req, env).host);
        if (host.kind === 'app' || appHostName(req.headers.host)) {
          void routeLabeled(host, event, req, rest, passOn);
          return true;
        }
        if (host.kind === 'unknown') {
          countSurfaceEvent('shell-listener');
          log('unknown-host', host.reason);
          if (hostPolicy(env) === 'enforce') {
            refuse(event, rest[0], 400, 'Bad Request', 'This address is not served here.');
            return true;
          }
        }
        return passOn();
      }
      return emit.call(this, event, req, ...rest);
    };
    void load().catch(() => {});   // warm the index; the shell may still be booting
  }

  return { attach, claims, resolve };
}
