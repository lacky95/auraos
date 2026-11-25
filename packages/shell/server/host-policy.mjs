/**
 * Which Host a request is for, and which forwarded headers count. The one
 * Host allowlist and the one trusted-proxy check of the shell's plain servers.
 *
 * `X-Forwarded-*` counts only from a peer listed in AURA_TRUSTED_PROXIES. An
 * empty list trusts nobody. A proxy appends its own value, so the last one is
 * the value it vouches for.
 *
 * Env:
 *   AURA_DESKTOP_HOSTS  comma-separated custom domains this AuraOS is opened
 *                       at, e.g. `box.aura.example.com` (its App Hosts
 *                       `*--box.aura.example.com` follow). Stops DNS
 *                       rebinding: a page on a name its owner points at this
 *                       machine is then not served. IP addresses, `localhost`,
 *                       `os.aura.localhost`, nip.io names and single-label
 *                       container names need no entry (see `hostListed`).
 *   AURA_HOST_POLICY    `enforce` (default) refuses a Host that is malformed
 *                       or not listed; `report` only logs it.
 */
import { classifyDesktopHost, parseAppHost, supportsAppHosts } from '@aura/core/host-rules';

const normalizeAddress = (addr) => String(addr ?? '').trim().toLowerCase().replace(/^::ffff:/, '');
const single = (v) => (Array.isArray(v) ? v[v.length - 1] : v) ?? '';
const lastValue = (v) => String(single(v)).split(',').at(-1).trim();

export function isTrustedProxy(peer, env = process.env) {
  const address = normalizeAddress(peer);
  if (!address) return false;
  return (env.AURA_TRUSTED_PROXIES ?? '').split(',').map(normalizeAddress).includes(address);
}

/** `scheme://host`, without the scheme's default port, as a browser writes Origin. */
export function originOf(scheme, host) {
  const h = String(host).toLowerCase();
  const bare = scheme === 'https' ? h.replace(/:443$/, '') : h.replace(/:80$/, '');
  return `${scheme}://${bare}`;
}

/**
 * The scheme, Host and origin the browser used.
 * @param {{ peer: unknown, encrypted?: boolean, header: (name: string) => unknown }} request
 */
export function edgeView({ peer, encrypted = false, header }, env = process.env) {
  const fromEdge = isTrustedProxy(peer, env);
  const proto = fromEdge ? lastValue(header('x-forwarded-proto')).toLowerCase() : '';
  const scheme = proto === 'https' || proto === 'http' ? proto : (encrypted ? 'https' : 'http');
  const host = ((fromEdge && lastValue(header('x-forwarded-host'))) || String(single(header('host')))).trim().toLowerCase();
  return { scheme, host, origin: originOf(scheme, host), fromEdge };
}

/** `edgeView` of a Node request. */
export function requestEdge(req, env = process.env) {
  return edgeView({
    peer: req.socket?.remoteAddress,
    encrypted: Boolean(req.socket?.encrypted),
    header: (name) => req.headers[name],
  }, env);
}

/**
 * Whether `new URL()` reads `host` as the authority it names. A Host it
 * rejects (`foo.123`, `1.2.3.999`, `x--1.2.3.4`) throws in code that builds a
 * URL from the request, such as the Vite dev server, which then never
 * answered. One that reads as another authority (`a@b`, `a/b`) is refused
 * too. No Host at all is left to the server, as before.
 */
export function hostParses(host) {
  const value = String(single(host)).trim();
  if (!value) return true;
  if (/[\s/\\?#@]/.test(value)) return false;
  return URL.canParse(`http://${value}/`);
}

const INTERNAL_NAME_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?::\d{1,5})?$/;

/**
 * The one Host allowlist:
 *   `app`      `{name}--{a desktop host that can carry App Hosts}`
 *   `shell`    a desktop address, or a single-label container name (`internal`)
 *   `unknown`  anything else
 * The syntax only: whether a label exists is the registry's answer.
 */
export function classifyHost(host) {
  const value = String(host ?? '').trim().toLowerCase();
  const app = parseAppHost(value);
  if (app) {
    const desktop = classifyDesktopHost(app.base);
    if (supportsAppHosts(desktop)) return { kind: 'app', label: app.name, base: app.base, desktop };
    return { kind: 'unknown', reason: 'app-host-base', label: app.name };
  }
  const desktop = classifyDesktopHost(value);
  if (desktop.kind !== 'invalid') return { kind: 'shell', internal: false, desktop };
  if (INTERNAL_NAME_RE.test(value) && !value.includes('--')) return { kind: 'shell', internal: true, desktop: null };
  return { kind: 'unknown', reason: value.includes('--') ? 'app-host-shape' : 'malformed' };
}

// ── the browser boundary (D40) ──────────────────────────────────────────────

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const GATEWAY_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
/**
 * Over plain HTTP browsers send no Sec-Fetch-*, and a no-cors GET no Origin,
 * so an `own-origin` app's API also needs this header from its own page: a
 * sibling can't add it without a CORS preflight, which the Origin check refuses.
 */
export const SAME_ORIGIN_HEADER = 'x-aura-same-origin';
/** An app's API. `/api/os/*` there is the SDK's redirect to shell assets (a `<link>` can't add a header). */
export const OWN_API_RE = /^\/(?:api(?:\/|$)(?!os\/)|mcp(?:\/|$))/;

const isJson = (value) => /^application\/json\s*(;|$)/i.test(String(value ?? '').trim());

/**
 * The one browser-boundary check: null when this request may proceed, else
 * why not. App Hosts are same-site with each other and with the shell, so
 * SameSite separates nothing and the exact Origin decides. `origin` is the
 * origin the request must come from, or a predicate. Policies:
 *
 *   shell       the shell's own listener: a write or WebSocket upgrade that
 *               names an Origin must name the shell. No Origin is a machine
 *               caller (CLI, an app's server, the Terminal backend) and passes;
 *               who that caller is stays the routes' question.
 *   app         an App Host page: reads pass (except streams), writes and
 *               streams need the exact Origin, or no Origin with a same-origin
 *               Sec-Fetch-Site.
 *   own-origin  an App Host that answers its own pages only (the Terminal,
 *               5.16): a navigation may arrive from elsewhere, nothing else
 *               may, and its API also needs SAME_ORIGIN_HEADER or the Origin.
 *   gateway     `/_aura/os/*`: no cross-site at all; writes need the exact
 *               Origin plus a JSON content type or the CSRF token (`csrf`).
 *
 * @param {{ method?: string, headers: Record<string, unknown> }} req
 * @param {{ policy: 'shell'|'app'|'own-origin'|'gateway', origin: string | ((o: string) => boolean),
 *           path?: string, upgrade?: boolean, csrf?: boolean }} opts
 */
export function browserBoundaryError(req, { policy, origin: expected, path = '', upgrade = false, csrf = false }) {
  const method = String(req.method ?? 'GET').toUpperCase();
  const origin = req.headers.origin;
  const site = req.headers['sec-fetch-site'];
  const sameOriginSite = site === undefined || site === 'same-origin' || site === 'none';
  const matches = (o) => (typeof expected === 'function' ? expected(String(o)) : o === expected);
  switch (policy) {
    case 'shell':
      if (!upgrade && READ_METHODS.has(method)) return null;
      if (origin === undefined) return null;
      return matches(origin) ? null : 'origin-mismatch';
    case 'app': {
      const stream = upgrade || String(req.headers.accept ?? '').includes('text/event-stream') || path.startsWith('/socket.io/');
      if (READ_METHODS.has(method) && !stream) return null;
      if (origin !== undefined) return matches(origin) ? null : 'origin-mismatch';
      return sameOriginSite ? null : 'cross-site';
    }
    case 'own-origin':
      if (origin !== undefined && !matches(origin)) return 'origin-mismatch';
      if (!sameOriginSite && !(req.headers['sec-fetch-mode'] === 'navigate' && READ_METHODS.has(method))) return 'cross-site';
      if (OWN_API_RE.test(path) && origin === undefined && req.headers[SAME_ORIGIN_HEADER] !== '1') return 'same-origin-required';
      return null;
    case 'gateway':
      if (!GATEWAY_METHODS.has(method)) return 'method-not-allowed';
      if (!sameOriginSite) return 'cross-site';
      if (origin !== undefined && !matches(origin)) return 'origin-mismatch';
      if (method === 'GET' || method === 'HEAD') return null;
      if (origin === undefined) return 'origin-required';
      return isJson(req.headers['content-type']) || csrf ? null : 'csrf-required';
    default:
      return 'unknown-policy';
  }
}

/** Destinations a browser renders or runs as a document or worker of the URL's own origin. */
const DOCUMENT_DESTS = new Set([
  'document', 'iframe', 'frame', 'embed', 'object', 'fencedframe', 'worker', 'sharedworker', 'serviceworker',
]);

/**
 * Whether a request is a browser loading a page, frame or worker, which the
 * machine proxy (`/api/proxy/*`) never serves. `Sec-Fetch-*` says so where
 * the browser sends it (HTTPS and localhost); over plain HTTP a navigation
 * still carries `Upgrade-Insecure-Requests: 1`, which fetch() can't set.
 * Machine callers (curl, MCP clients, an app's server) send none of these.
 * @param {string | undefined} method
 * @param {(name: string) => unknown} header
 */
export function browserDocumentRequest(method, header) {
  const dest = String(header('sec-fetch-dest') ?? '').toLowerCase();
  if (DOCUMENT_DESTS.has(dest)) return true;
  const mode = String(header('sec-fetch-mode') ?? '').toLowerCase();
  if (mode === 'navigate' || mode === 'nested-navigate') return true;
  return String(header('upgrade-insecure-requests') ?? '').trim() === '1'
    && READ_METHODS.has(String(method ?? 'GET').toUpperCase()) && !dest;
}

/**
 * Whether a path below `/api/proxy/` reaches the upstream as written (H1): no
 * `.` or `..` segment, and no encoded dot, slash or backslash, which the
 * upstream's URL parser (WHATWG in `ws` and undici) would turn into another
 * path than the one the access rules judged. Both proxies (the HTTP route and
 * the WebSocket upgrade in attach.mjs) answer 400 to anything else.
 * @param {string} path
 */
export function plainProxyPath(path) {
  if (/%(?:2e|2f|5c)|\\/i.test(path)) return false;
  return !path.split('/').some((s) => s === '.' || s === '..');
}

/** `host` without the scheme's default port, lowercase. */
function bareHost(scheme, host) {
  const h = String(host ?? '').trim().toLowerCase();
  return scheme === 'https' ? h.replace(/:443$/, '') : h.replace(/:80$/, '');
}

/**
 * Whether `origin` is the shell this request reached: its host is the Host
 * header, or the X-Forwarded-Host an edge in front of a custom domain set
 * (a cross-site page can't add that header without a CORS preflight, which
 * the shell never grants). The scheme is not compared: without a trusted
 * proxy the shell can't tell HTTPS at the edge from HTTP, and a page on the
 * same host is the shell either way. `null` and anything malformed never match.
 */
export function isShellOrigin(origin, req) {
  let u;
  try { u = new URL(String(origin)); } catch { return false; }
  if (u.origin !== String(origin) || (u.protocol !== 'http:' && u.protocol !== 'https:')) return false;
  const scheme = u.protocol.slice(0, -1);
  const host = bareHost(scheme, u.host);
  const named = [single(req.headers.host), lastValue(req.headers['x-forwarded-host'])].filter(Boolean);
  return named.some((h) => bareHost(scheme, h) === host);
}

/** The custom domains in AURA_DESKTOP_HOSTS, lowercase, without port or trailing dot. */
export function desktopHosts(env = process.env) {
  return new Set(String(env.AURA_DESKTOP_HOSTS ?? '').split(',')
    .map((h) => h.trim().toLowerCase().replace(/\.$/, '').replace(/:\d{1,5}$/, ''))
    .filter(Boolean));
}

/**
 * Whether a classified Host is one this AuraOS answers to: the DNS rebinding
 * check. Only a custom domain needs listing, because only there can another
 * party's DNS name reach this machine:
 *   ip           a page's Host is its own name, never this machine's address
 *   localhost    browsers resolve `localhost` and `*.localhost` to loopback
 *   nip          `a-b-c-d.nip.io` always resolves to a.b.c.d, so no one can
 *                point it elsewhere (true for the machine's own addresses
 *                and any other: it only ever reaches the address it names)
 *   internal     a single-label container name (`aura-shell`), not public DNS
 *   custom       only the names in AURA_DESKTOP_HOSTS, and their App Hosts
 */
export function hostListed(host, env = process.env) {
  if (!host || host.kind === 'unknown') return false;
  if (host.kind === 'shell' && host.internal) return true;
  const desktop = host.desktop;
  if (!desktop || desktop.kind === 'invalid') return false;
  if (desktop.kind !== 'custom') return true;
  return desktopHosts(env).has(desktop.hostname);
}

/**
 * `enforce` refuses a malformed or unlisted Host; `report` serves it and logs
 * it. AURA_HOST_POLICY overrides.
 */
const DEFAULT_HOST_POLICY = 'enforce';
export const hostPolicy = (env = process.env) => {
  const set = env.AURA_HOST_POLICY;
  return set === 'enforce' || set === 'report' ? set : DEFAULT_HOST_POLICY;
};
