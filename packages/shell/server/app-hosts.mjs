/**
 * App Hosts — the Host-header router in front of everything else.
 *
 * Every app with a UI has its own origin, `{label}--{desktop host}` (e.g.
 * `notes--10-201-1-2.nip.io:3000`). The label is resolved exactly through the
 * App Host registry to one installation and slot, and the request is streamed
 * to the instance that holds the slot, minus the shell's own credentials: no
 * prefix, no rewriting, no injected scripts. Nothing reaches the app without
 * a valid app cookie from the one-time handoff, and `/_aura/*` is answered
 * here, never by the app. A trusted system UI's page request on a live owner
 * session also carries the signed owner SSR claim (D45, `ownerSsrHeader`).
 * Every other Host goes on to the shell.
 *
 * Interception wraps the HTTP server's `emit` for `request` and `upgrade`, so
 * a claimed request never reaches Astro, Vite, socket.io (whose engine.io
 * would end an upgrade it doesn't own after 1 s) or the /api/proxy WS proxy.
 *
 * Env:
 *   AURA_TRUSTED_PROXIES  comma-separated client addresses whose
 *                         X-Forwarded-Proto/-Host/-For are believed (the edge
 *                         in front of a custom domain). See host-policy.mjs.
 *   AURA_DESKTOP_HOSTS    custom domains this AuraOS answers to (DNS
 *                         rebinding), see host-policy.mjs.
 *   AURA_HOST_POLICY      `enforce` (default) or `report`.
 */
import http from 'node:http';
import net from 'node:net';
import {
  APP_HOST_ROUTE_HEADER, AURA_RESERVED_PATHS, OWNER_SSR_HEADER, appHostCookieName, isAuraReservedPath, lifecycleRequestPath,
  parseAppHost,
} from '@aura/core/host-rules';
import { RELAY_CLAIM_HEADER } from '@aura/core/relay-claim';
import {
  SESSION_COOKIES, countSurfaceEvent, followIdentity, gatedHttpSurface, internalServiceHeaders, observeHttpSurface,
  relayClaimOf, reportSurface, requestIdentity, surfaceGate,
} from './access-bridge.mjs';
import { appHostAuth, appHostEmbedCookieName, safeReturnPath } from './app-host-auth.mjs';
import { handleAppGateway, handleAppGatewayUpgrade, serveAppRuntime } from './app-gateway.mjs';
import { isOwnerUiInstallation, ownerUiApp, signOwnerSsrClaim } from './gateway-identity.mjs';
import {
  OWN_API_RE, browserBoundaryError, classifyHost, hostListed, hostParses, hostPolicy, isShellOrigin, originOf, requestEdge,
} from './host-policy.mjs';
import { stripCookies, stripShellCredentials } from './shell-credentials.mjs';
import { EMBEDDER_PARAM, SESSION_HOST_APPS } from './terminal-embed.mjs';

export { SAME_ORIGIN_HEADER, classifyHost } from './host-policy.mjs';

// ── helpers ─────────────────────────────────────────────────────────────────

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);
const START_RETRY_MS = 15_000;

/** The host probe's cookie (`answerHostProbe`), set exactly like the app cookie. */
const probeCookieName = (secure) => (secure ? '__Host-aura_host_probe' : 'aura_host_probe');

/** Never sent to an app, and an app may not set them. */
const AURA_COOKIES = new Set([
  appHostCookieName(true), appHostCookieName(false), appHostEmbedCookieName(true), appHostEmbedCookieName(false),
  probeCookieName(true), probeCookieName(false), ...SESSION_COOKIES,
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
 * Apps whose pages their own origin may not frame. Aura Browser frames any
 * website with `allow-same-origin` (sign-ins need it); a site that redirects
 * its frame to the Browser's own App Host would otherwise run as the
 * Browser's origin inside it and could lift that sandbox.
 */
const NO_SELF_FRAME_APPS = new Set(['com.aura.browser']);

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

/** X-Forwarded-* for the upstream, from the edge view (`requestEdge`). */
function forwardedHeaders(req, edge) {
  const { host, scheme: proto, fromEdge } = edge;
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

/**
 * `/_aura/host-probe` on any well-formed App Host. It answers the same for
 * every label, before any registry lookup, so no site can use it to list the
 * installed apps, and it never reaches an app:
 *
 *   (no query)      204: DNS for App Hosts reaches this shell (the IP setup bar).
 *   `?cookie=set`   sets a probe cookie the way the handoff sets the app
 *                   cookie, and redirects to `?cookie=check`.
 *   `?cookie=check` a page that tells the desktop framing it whether the
 *                   cookie came back. WebKit drops it on `*.localhost` (D44),
 *                   where every app frame would then end on the sign-in page,
 *                   so the desktop offers `127-0-0-1.nip.io` instead.
 */
function answerHostProbe(req, res, host, edge) {
  let step = null;
  try { step = new URL(String(req.url ?? ''), 'http://h').searchParams.get('cookie'); } catch { /* the plain probe */ }
  const secure = edge.scheme === 'https';
  const name = probeCookieName(secure);
  const cookie = (value, maxAge) => `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly${secure ? '; Secure' : ''}; SameSite=Lax`;
  if (step === 'set') {
    res.writeHead(303, {
      location: `${AURA_RESERVED_PATHS.hostProbe}?cookie=check`,
      'set-cookie': cookie('1', 60),
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    });
    return res.end();
  }
  if (step === 'check') {
    const desktop = originOf(edge.scheme, host.base);
    const kept = String(req.headers.cookie ?? '').split(';').some((c) => c.split('=', 1)[0].trim() === name);
    const json = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': `default-src 'none'; script-src 'unsafe-inline'; frame-ancestors ${desktop}`,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      ...(kept ? { 'set-cookie': cookie('', 0) } : {}),
    });
    return res.end('<!doctype html><meta charset="utf-8"><title>AuraOS</title>'
      + `<script>parent.postMessage(${json({ type: 'aura.hostprobe.cookie', cookie: kept })}, ${json(desktop)});</script>`);
  }
  res.writeHead(204, { 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
  return res.end();
}

// ── the app's side ──────────────────────────────────────────────────────────

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
 *   `services` = the App Host registry and session check. Without it, every
 *   App Host request is refused.
 *   `embedAncestors` = extra exact origins allowed to frame an `embed=1`
 *   document (5.16): the Terminal's granted embedder (terminal-embed.mjs).
 */
export function createAppHostRouter({
  appsList, shellPort = process.env.SHELL_PORT ?? '3000', log = () => {},
  services = async () => null, auth = null, embedAncestors = () => [], env = process.env,
}) {
  let apps = null;   // the last app list; null until the first load
  let loading = null;
  const startAsked = new Map();   // appId → when we last asked the shell to start it
  const slotStarts = new Map();   // installation and scope → the slot-1 start in flight
  const verifiedSessions = new WeakMap();   // req → the App Host session appSession() verified, for the report
  const hostAuth = () => (auth ??= appHostAuth());

  /** The shell's app list (`appsList` caches it); `fresh` reloads it. */
  function load(fresh = false) {
    loading ??= appsList({ fresh }).then((list) => {
      apps = list;
      return list;
    }).finally(() => { loading = null; });
    return loading;
  }

  function identityHeaders(t) {
    return { 'x-aura-app-id': t.appId, 'x-aura-instance-id': t.instanceId };
  }

  function pipeHttp(name, t, req, res, headers, responseHeaders) {
    const up = http.request({ host: t.host, port: t.port, method: req.method, path: req.url, headers }, (ures) => {
      // An app server that answers with another app's identity is a stale port.
      const declared = ures.headers['x-aura-app-id'];
      if (declared && declared !== t.appId) {
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

  /**
   * Where a `{label}--…` request goes. Throws when the registry can't answer,
   * and the caller refuses the request.
   */
  async function decide(host) {
    // The first load also boots the KV store the registry reads.
    if (!apps) await load().catch(() => {});
    const svc = await services();
    if (!svc) throw new Error('app host registry unavailable');
    const found = await svc.registry.resolveLabel(host.label);
    if (found.status === 'retired') return { to: 'gone' };
    if (found.status !== 'active') return { to: 'missing' };
    return { to: 'host', svc, record: found.record, slot: found.slot, label: host.label, base: host.base };
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
    const live = await route.svc.sessionLive(payload.sid, payload.userId);
    if (!live) return null;
    // The role the record has now (C2), for the principal; never a cookie field.
    verifiedSessions.set(req, { ...payload, role: live.role });
    return payload;
  }

  /**
   * The surface gate of an App Host request or upgrade, decided on the
   * instance the slot holds (`t`, the live target once known; else the slot's
   * record). I.2 (D82): a member's session reaches only its own instance (a
   * slot reassigned to another user's instance refuses it); a member's slot
   * without an instance is refused (the member starts its own from the
   * desktop, `/api/apps/<id>/start`). D69 (stream T): a System Terminal
   * instance is one user's session host, so the owner's session is decided on
   * it too (decide.ts `sessionHostReachable`).
   */
  async function hostGate(route, req, subject, method, t = null) {
    const role = verifiedSessions.get(req)?.role;
    const instanceId = t?.instanceId ?? route.slot?.instanceId;
    if (role !== 'owner' && !instanceId) return false;
    const named = instanceId && (role !== 'owner' || SESSION_HOST_APPS.has(route.record.appId));
    return surfaceGate({
      subject, method, appId: route.record.appId, ...(named ? { instanceId } : {}), identity: hostIdentity(route, req),
    });
  }

  /**
   * The report's identity for a request on an App Host: the session
   * appSession() verified, as the owner acting through this app. Never the cookie.
   */
  function hostIdentity(route, req) {
    const session = verifiedSessions.get(req);
    const appHost = session ? {
      appId: route.record.appId, userId: session.userId, sid: session.sid, role: session.role,
      ...(route.slot?.instanceId ? { instanceId: route.slot.instanceId } : {}),
    } : null;
    // Once per request: the gate, the report and the SSE mux share it.
    return requestIdentity(req, { appHost });
  }

  /**
   * D45: the owner claim for a page request to a trusted system UI, which its
   * server sends back with its reads of the shell (gateway-identity.mjs
   * `signOwnerSsrClaim`). Only a GET or HEAD, to the active `system`
   * installation of an OWNER_UI_APPS app, on a full host cookie whose owner
   * session appSession() found live, and bound to the instance that serves it.
   * Never on an upgrade. Fails closed.
   */
  async function ownerSsrHeader(route, req, session, t) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return null;
    if (session.embed !== undefined || !ownerUiApp(route.record.appId) || t.appId !== route.record.appId) return null;
    if (typeof session.sid !== 'string' || !session.sid || typeof session.userId !== 'string' || !session.userId) return null;
    try {
      if (!(await isOwnerUiInstallation(route.svc.registry, route.record))) return null;
    } catch {
      return null;
    }
    return signOwnerSsrClaim({
      appId: route.record.appId, installationId: route.record.installationId, instanceId: t.instanceId,
      userId: session.userId, sid: session.sid,
    });
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
    // Running, but its runner has no address for it (yet): not routable.
    if (inst && !inst.upstreamHost) return { notReady: true, appName };
    if (inst) {
      return {
        // AppManager.getUpstreamUrl's host, carried in the list (D58: a System Terminal's private address).
        host: inst.upstreamHost,
        port: inst.port, appId: record.appId, instanceId: inst.instanceId, sidecar: false, appName,
      };
    }
    if (slot.slot !== 1) return { notReady: true, appName };
    startSlotOne(route);
    return { starting: true, appName };
  }

  /** `{ ancestors, embedders }`: the frame-ancestors list, and how many of them an embed grant added. */
  async function frameAncestors(route, edge, session, url) {
    // 'self': an app may frame its own pages (Steel's Live view embeds its ui/).
    // Every ancestor must match, so the chain still has to start at the shell.
    const shell = originOf(edge.scheme, route.base);
    const ancestors = NO_SELF_FRAME_APPS.has(route.record.appId) ? [shell] : ["'self'", shell];
    const own = ancestors.length;
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
    return { ancestors, embedders: ancestors.length - own };
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
    return route.svc.sessionLive(entry.claim.sid, entry.claim.userId).then((live) => {
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

    const session = await appSession(route, req, edge);
    if (!session) return page(401, 'Open this app from AuraOS', 'This address needs a sign-in from the AuraOS desktop.');
    if (!(await hostGate(route, req, 'app-hosts', req.method))) {
      return page(403, 'Request refused', 'This sign-in may not open this app.');
    }
    const policy = OWN_ORIGIN_ONLY_APPS.has(route.record.appId) ? 'own-origin' : 'app';
    if (browserBoundaryError(req, { policy, origin: edge.origin, path })) {
      return page(403, 'Request refused', 'This request came from another origin.');
    }
    if (session.embed && !embedRequestAllowed(req, url, path, session.embed)) {
      return page(403, 'Request refused', 'This sign-in shows one embedded session only.');
    }

    // An app's lifecycle routes are the kernel runner's alone.
    if (lifecycleRequestPath(url) !== null) return page(404, 'Not found', 'This path is reserved by AuraOS.');

    if (isAuraReservedPath(url)) {
      if (path === AURA_RESERVED_PATHS.runtime) return serveAppRuntime(req, res, { record: route.record, slot: route.slot });
      if (path.startsWith(AURA_RESERVED_PATHS.os)) return handleAppGateway(req, res, { record: route.record, slot: route.slot, session, services: route.svc });
      return page(404, 'Not found', 'This path is reserved by AuraOS.');
    }

    const t = await slotTarget(route);
    if (t.missing) return page(404, 'No app here', 'This app has no page at this address.');
    if (t.notReady) return page(503, `${t.appName} is not ready`, 'No running instance holds this address. Open the app again from the AuraOS desktop.');
    if (t.starting) return page(503, `Starting ${t.appName}…`, 'This page reloads by itself when it is up.', { refresh: 2 });
    // D69: a session host's live target may be newer than the slot the gate saw (a cold start): decide again on it.
    if (SESSION_HOST_APPS.has(t.appId) && !(await hostGate(route, req, 'app-hosts', req.method, t))) {
      return page(403, 'Request refused', 'This Terminal belongs to another user.');
    }
    const headers = appRequestHeaders(req, 'app-hosts-http');
    for (const [k, v] of Object.entries({ ...forwardedHeaders(req, edge), ...identityHeaders(t), ...activityHeaders(req.url, t.instanceId), [APP_HOST_ROUTE_HEADER]: 'host' })) headers.push(k, v);
    const ownerSsr = await ownerSsrHeader(route, req, session, t);
    if (ownerSsr) headers.push(OWNER_SSR_HEADER, ownerSsr);
    // D89 B4: to an owner-agent app, the shell's relay claim (the session's user), bound to this call.
    const relay = relayClaimOf({ appId: t.appId, instanceId: t.instanceId, method: req.method, path: url, session });
    if (relay) headers.push(RELAY_CLAIM_HEADER, relay);
    const { ancestors, embedders } = await frameAncestors(route, edge, session, url);
    // The embed document still needs the grant its code was issued under.
    if (session.embed && path === '/' && embedders === 0) return page(403, 'Request refused', 'This embedded session is no longer granted.');
    pipeHttp(route.label, t, req, res, headers, (raw) => appResponseHeaders(raw, ancestors));
  }

  async function serveHostUpgrade(route, req, socket, head, edge) {
    let reported = false;
    const reportUpgrade = (status) => {
      if (reported) return;
      reported = true;
      reportSurface({ subject: 'app-hosts', method: 'UPGRADE', identity: hostIdentity(route, req), appId: route.record.appId, status });
    };
    const fail = (status, text) => {
      reportUpgrade(status);
      try { socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { /* gone */ }
    };
    socket.on('error', () => {});
    const url = String(req.url ?? '');
    const mux = url.split(/[?#]/, 1)[0] === `${AURA_RESERVED_PATHS.os}sse-mux`;
    if (!url.startsWith('/') || (!mux && isAuraReservedPath(url)) || lifecycleRequestPath(url) !== null) return fail(404, 'Not Found');
    if (req.headers.origin !== edge.origin) return fail(403, 'Forbidden');
    let t;
    let session;
    try {
      session = await appSession(route, req, edge);
      if (!session) return fail(401, 'Unauthorized');
      if (mux && session.embed) return fail(403, 'Forbidden');
      if (!(await hostGate(route, req, mux ? 'sse-mux' : 'app-hosts', 'UPGRADE'))) {
        return fail(403, 'Forbidden');
      }
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
        const { embedders } = await frameAncestors(route, edge, session, url);
        if (embedders === 0) return fail(403, 'Forbidden');
      }
      t = await slotTarget(route);
    } catch { return fail(503, 'Service Unavailable'); }
    if (t.missing) return fail(404, 'Not Found');
    if (t.starting || t.notReady) return fail(503, 'Service Unavailable');
    if (SESSION_HOST_APPS.has(t.appId) && !(await hostGate(route, req, 'app-hosts', 'UPGRADE', t))) return fail(403, 'Forbidden');
    const extra = { ...forwardedHeaders(req, edge), ...identityHeaders(t), ...activityHeaders(req.url, t.instanceId), [APP_HOST_ROUTE_HEADER]: 'host' };
    // D89 B4: the Terminal's PTY on its App Host gets the shell's relay claim for this upgrade.
    const relay = relayClaimOf({ appId: t.appId, instanceId: t.instanceId, method: req.method, path: url, session });
    if (relay) extra[RELAY_CLAIM_HEADER] = relay;
    const raw = appRequestHeaders(req, 'app-hosts-upgrade', { keepUpgrade: true });
    const lines = [`${req.method} ${url} HTTP/${req.httpVersion}`];
    for (let i = 0; i + 1 < raw.length; i += 2) lines.push(`${raw[i]}: ${raw[i + 1]}`);
    for (const [k, v] of Object.entries(extra)) lines.push(`${k}: ${v}`);
    pipeUpgrade(route.label, t, socket, head, lines, reportUpgrade, fail);
    // M4: the socket (the Terminal PTY among them) ends with the session it opened on.
    const unfollow = followIdentity(hostIdentity(route, req), () => socket.destroy());
    socket.once('close', unfollow);
  }

  function refuse(event, target, status, title, body, opts = {}) {
    if (event === 'request') return reply(target, status, title, body, opts);
    target.on('error', () => {});
    try { target.end(`HTTP/1.1 ${status} ${title}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { /* gone */ }
    return undefined;
  }

  async function routeLabeled(host, event, req, rest) {
    const target = rest[0];
    try {
      const route = await decide(host);
      if (route.to === 'gone') return refuse(event, target, 410, 'Gone', 'This app was removed, and its address is not used again.');
      // An App Host name no app uses is never the desktop, nor its API.
      if (route.to === 'missing') return refuse(event, target, 404, 'Not Found', 'No app uses this address.');
      const edge = requestEdge(req, env);
      if (event === 'request') {
        const method = req.method;
        target.once('close', () => reportSurface({
          subject: 'app-hosts', method, identity: hostIdentity(route, req), appId: route.record.appId,
          status: target.headersSent ? target.statusCode : 0,
        }));
        await serveHostRequest(route, req, target, edge);
      }
      else await serveHostUpgrade(route, req, target, rest[1], edge);
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
          // D40: no other site may write to the shell or open its sockets.
          if (browserBoundaryError(req, { policy: 'shell', origin: (o) => isShellOrigin(o, req), upgrade: event === 'upgrade' })) {
            countSurfaceEvent('shell-origin');
            log('cross-origin', req.method, String(req.url ?? '').split('?', 1)[0]);
            refuse(event, rest[0], 403, 'Forbidden', 'This request came from another site.');
            return true;
          }
          if (event === 'request') observeHttpSurface(req, rest[0]);
          // Vite's dev server serves source outside Astro's middleware: it waits for the surface gate.
          if (event === 'request' && gatedHttpSurface(req)) {
            const target = rest[0];
            void surfaceGate({ subject: 'vite-dev-server', method: req.method, identity: requestIdentity(req) })
              .then((ok) => (ok ? emit.call(this, event, req, ...rest) : refuse(event, target, 403, 'Forbidden', 'Sign in on the desktop first.')))
              .catch(() => refuse(event, target, 503, 'Service Unavailable', 'AuraOS could not check this request.'));
            return true;
          }
          return emit.call(this, event, req, ...rest);
        };
        const edge = requestEdge(req, env);
        // A Host `new URL()` rejects throws further in (the Vite dev server
        // builds the request URL from it) and the request is never answered.
        if (!hostParses(req.headers.host) || !hostParses(edge.host)) {
          countSurfaceEvent('shell-listener');
          log('unparseable-host');
          refuse(event, rest[0], 400, 'Bad Request', 'This address can\'t be read.');
          return true;
        }
        const host = classifyHost(edge.host);
        // DNS rebinding: a custom domain this AuraOS was not told about.
        if (host.kind !== 'unknown' && !hostListed(host, env)) {
          countSurfaceEvent('shell-listener');
          log('unlisted-host', host.kind);
          if (hostPolicy(env) === 'enforce') {
            refuse(event, rest[0], 400, 'Bad Request', 'This address is not one of this AuraOS\'s addresses (AURA_DESKTOP_HOSTS).');
            return true;
          }
        }
        if (host.kind === 'app' && event === 'request' && String(req.url ?? '').split(/[?#]/, 1)[0] === AURA_RESERVED_PATHS.hostProbe) {
          answerHostProbe(req, rest[0], host, edge);
          return true;
        }
        if (host.kind === 'app') {
          void routeLabeled(host, event, req, rest);
          return true;
        }
        // App Host shaped on a base that carries none: never the desktop, nor its API.
        if (parseAppHost(String(req.headers.host ?? ''))) {
          refuse(event, rest[0], 404, 'Not Found', 'No app uses this address.');
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
    void load().catch(() => {});   // warm the app list; the shell may still be booting
  }

  return { attach };
}
