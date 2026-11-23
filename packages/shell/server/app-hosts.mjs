/**
 * App hosts — the Host-header router in front of everything else.
 *
 * A request for `{name}--{desktop host}` (e.g. `marklayer--10-201-1-2.nip.io:3000`)
 * whose `name` an installed manifest declares in `hosts[]` is streamed to that
 * app's server or sidecar, minus the shell's own credentials: no prefix, no HTML/JS rewriting, no
 * injected scripts, no cookie scoping. The app owns the origin root. Every
 * other request goes on to the shell exactly as before. Docs: /docs/app-hosts;
 * the rules live in @aura/core app-hosts/appHosts.ts and are mirrored below in
 * plain JS (this file loads before / beside the Astro build).
 *
 * Interception wraps the HTTP server's `emit` for `request` and `upgrade`, so
 * a claimed request never reaches Astro, Vite, socket.io (whose engine.io
 * would end an upgrade it doesn't own after 1 s) or the /api/proxy WS proxy.
 * The claim is synchronous: it reads a host index rebuilt from the shell's own
 * /api/apps (the same source the WS proxy uses, see attach.mjs).
 *
 * Env:
 *   AURA_TRUSTED_PROXIES  comma-separated client addresses whose
 *                         X-Forwarded-Proto/-Host/-For are believed (the edge
 *                         in front of a custom domain). Unset = believe any:
 *                         a forged header only changes the forger's own reply.
 */
import http from 'node:http';
import net from 'node:net';
import {
  internalServiceHeaders, observeHttpSurface, reportSurface, surfaceIdentity,
} from './access-bridge.mjs';
import { stripShellCredentials } from './shell-credentials.mjs';

// ── the rule (mirror of @aura/core app-hosts/appHosts.ts) ───────────────────

const HOST_NAME_RE = /^[a-z][a-z0-9]{0,30}$/;
const RESERVED = new Set(['aura', 'shell', 'os', 'api', 'www', 'admin', 'app', 'apps', 'xn']);

/** `name` of a `{name}--{base}` Host header, or null. */
export function appHostName(host) {
  if (!host) return null;
  const h = String(host).trim().toLowerCase();
  const at = h.indexOf('--');
  if (at <= 0) return null;
  const name = h.slice(0, at);
  const base = h.slice(at + 2);
  if (!HOST_NAME_RE.test(name) || RESERVED.has(name) || !base || base.startsWith('.') || base.startsWith(':')) return null;
  return name;
}

// ── helpers ─────────────────────────────────────────────────────────────────

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);
const INDEX_TTL_MS = 2000;
const START_RETRY_MS = 15_000;

const trusted = (process.env.AURA_TRUSTED_PROXIES ?? '')
  .split(',').map((s) => s.trim().replace(/^::ffff:/, '')).filter(Boolean);
const isTrusted = (addr) => trusted.length === 0 || trusted.includes(String(addr ?? '').replace(/^::ffff:/, ''));

function liveInstance(app) {
  const live = (app.instances ?? []).filter((i) => i.port != null && (i.state === 'resumed' || i.state === 'started'));
  return live.find((i) => !i.inPool) ?? live[0] ?? null;
}

/** X-Forwarded-* for the upstream, from what the client (or a trusted edge) said. */
function forwardedHeaders(req) {
  const fromEdge = isTrusted(req.socket?.remoteAddress);
  const host = (fromEdge && req.headers['x-forwarded-host']) || req.headers.host || '';
  const protoIn = fromEdge ? String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() : '';
  const proto = protoIn === 'https' || protoIn === 'http' ? protoIn : (req.socket?.encrypted ? 'https' : 'http');
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
  });
  res.end(html);
}

// ── the router ──────────────────────────────────────────────────────────────

/**
 * @param {{ appsList: (opts?: { fresh?: boolean }) => Promise<any[]>, shellPort?: string, log?: (...a: any[]) => void }} deps
 *   `appsList` = the shell's /api/apps (manifest + instances per app).
 */
export function createAppHostRouter({ appsList, shellPort = process.env.SHELL_PORT ?? '3000', log = () => {} }) {
  /** name → appId; null until the first load. */
  let index = null;
  let indexAt = 0;
  let loading = null;
  const startAsked = new Map();   // appId → when we last asked the shell to start it

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

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(k)) headers[k] = v;
    stripShellCredentials(headers, 'app-hosts-http');
    Object.assign(headers, forwardedHeaders(req), identityHeaders(t));

    const up = http.request({ host: t.host, port: t.port, method: req.method, path: req.url, headers }, (ures) => {
      // An app server that answers with another app's identity is a stale port.
      const declared = ures.headers['x-aura-app-id'];
      if (!t.sidecar && declared && declared !== t.appId) {
        ures.resume();
        log('identity-mismatch', name, declared);
        return reply(res, 502, `${t.appName} is restarting`, 'This page reloads by itself.', { refresh: 2 });
      }
      const out = [];
      for (let i = 0; i < ures.rawHeaders.length; i += 2) {
        const k = ures.rawHeaders[i];
        if (!HOP_BY_HOP.has(k.toLowerCase())) out.push(k, ures.rawHeaders[i + 1]);
      }
      res.writeHead(ures.statusCode ?? 502, ures.statusMessage, out);
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
      if (!(rawHeaders[i].toLowerCase() in extra)) lines.push(`${rawHeaders[i]}: ${rawHeaders[i + 1]}`);
    }
    for (const [k, v] of Object.entries(extra)) lines.push(`${k}: ${v}`);
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
   * Put the router in front of `server`: claimed `request`/`upgrade` events
   * are handled here and never emitted to the server's other listeners.
   */
  function attach(server) {
    if (server.__auraAppHosts) return;
    server.__auraAppHosts = true;
    const emit = server.emit;
    server.emit = function (event, req, ...rest) {
      if (event === 'request' || event === 'upgrade') {
        const name = claims(req);
        if (name) {
          if (event === 'request') void handleRequest(name, req, rest[0]);
          else void handleUpgrade(name, req, rest[0], rest[1]);
          return true;
        }
      }
      if (event === 'request') observeHttpSurface(req, rest[0]);
      return emit.call(this, event, req, ...rest);
    };
    void load().catch(() => {});   // warm the index; the shell may still be booting
  }

  return { attach, claims, resolve };
}
