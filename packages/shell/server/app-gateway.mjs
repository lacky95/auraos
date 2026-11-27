/**
 * The App Host gateway: what an app's page reaches at `/_aura/os/*` and
 * `/_aura/runtime.js` on its own origin. The router (./app-hosts.mjs) calls it
 * only after resolving the exact label and checking the host cookie.
 *
 * Which API paths an app may reach is not decided here. Each call carries a
 * signed claim of the verified app and instance (./gateway-identity.mjs), and
 * the shell's middleware checks it against the route access manifest, where
 * Astro has already matched the route (lib/access/gatewayCaller.ts). This file
 * only guards the browser boundary:
 *
 *   - no instance or no valid host session: refused, never `system`
 *   - cross-origin or same-site callers: refused (App Hosts are same-site with
 *     each other, so SameSite does not separate them)
 *   - mutations: exact Origin, plus a JSON content type or the CSRF token
 *   - request headers: an allowlist, so cookies, Authorization, X-Forwarded-*
 *     and any inbound identity never reach the shell, with no exception
 *   - owner acting through a trusted system UI (D45): only the `system` copy of
 *     an app in OWNER_UI_APPS, on a host cookie bound to a live owner session,
 *     gets an `owner` field in its claim. Nothing in the request can set it
 *   - response headers: no Set-Cookie, CORS grant or redirect target
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { AURA_RESERVED_PATHS, GATEWAY_IDENTITY_HEADER } from '@aura/core/host-rules';
import { localSystemId } from '@aura/core/system-identity';
import { loadAppHostServices } from './app-host-auth.mjs';
import { GATEWAY_CLAIM_TTL_S, gatewayKey, ownerUiActs, ownerUiApp, signGatewayClaim } from './gateway-identity.mjs';
import { browserBoundaryError } from './host-policy.mjs';
import { createSseMux } from './sse-mux.mjs';

const OS_PREFIX = AURA_RESERVED_PATHS.os;
export const GATEWAY_MUX_PATH = `${OS_PREFIX}sse-mux`;
export const GATEWAY_CSRF_PATH = `${OS_PREFIX}_csrf`;
export const GATEWAY_CSRF_HEADER = 'x-aura-csrf';
const RUNTIME_ROUTE = '/api/os/app-runtime.js';


const FORWARDED_REQUEST_HEADERS = [
  'accept', 'accept-language', 'content-type', 'content-length', 'if-match', 'if-none-match',
  'if-modified-since', 'last-event-id', 'range', 'user-agent', 'x-aura-sender-token',
  // An approval id an app retries an action with (lib/approvals). Not a credential: it is consumed against the caller.
  'x-aura-approval',
];
const DROPPED_RESPONSE_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-connection', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'set-cookie', 'location', 'service-worker-allowed',
]);

const shellPort = () => process.env.SHELL_PORT ?? process.env.AURA_SHELL_PORT ?? '3000';

/**
 * What each boundary refusal says (the one error body, core `AuraErrorBody`:
 * `error` stays the code). Never the origin another app expects, never a
 * credential: only what the calling page did and how to call correctly.
 */
const BOUNDARY_TEXT = {
  'shell-unavailable': { message: 'AuraOS did not answer this call.', category: 'unavailable', hint: 'Retry in a moment.' },
  'no-instance': { message: 'This App Host page has no running app instance.', category: 'instance-not-found', hint: 'Open the app again from AuraOS.' },
  'no-session': { message: 'This App Host page has no session.', category: 'not-authenticated', hint: 'Open the app again from AuraOS.' },
  'method-not-allowed': { message: 'This method is not allowed on /_aura/os.', category: 'invalid-request' },
  'cross-site': { message: 'Calls to /_aura/os come only from this app\'s own pages.', category: 'not-grantable' },
  'origin-mismatch': { message: 'Calls to /_aura/os come only from this app\'s own origin.', category: 'not-grantable' },
  'origin-required': {
    message: 'A state-changing call to /_aura/os needs an Origin header.', category: 'invalid-request',
    hint: 'Call through osClient from the app page (a browser fetch sends it).',
  },
  'csrf-required': {
    message: 'A state-changing call to /_aura/os needs a JSON body or the CSRF token.', category: 'invalid-request',
    hint: 'Use osClient, or send Content-Type: application/json.',
  },
  'not-a-gateway-path': { message: 'This is not an OS API path: /_aura/os/api/… only.', category: 'invalid-request' },
};

function refuse(res, status, error) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(res.req?.method === 'HEAD' ? undefined : JSON.stringify({ error, ...(BOUNDARY_TEXT[error] ?? {}) }));
}

/**
 * The shell path of a `/_aura/os/api/…` URL, or null. Strict on purpose: the
 * browser normalizes dot segments before sending, so an encoded separator or
 * dot segment here is someone trying to reach a different route.
 */
export function gatewayShellPath(rawUrl) {
  const raw = String(rawUrl ?? '');
  if (raw.includes('#')) return null;
  const q = raw.indexOf('?');
  const path = q < 0 ? raw : raw.slice(0, q);
  const search = q < 0 ? '' : raw.slice(q);
  if (!path.startsWith(OS_PREFIX)) return null;
  const rest = `/${path.slice(OS_PREFIX.length)}`;
  if (!rest.startsWith('/api/')) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\\\x00-\x20\x7f]|\/\/|%(?:2f|5c|00)/i.test(rest)) return null;
  for (const segment of rest.split('/')) {
    let decoded;
    try { decoded = decodeURIComponent(segment); } catch { return null; }
    if (decoded === '.' || decoded === '..') return null;
  }
  return `${rest}${search}`;
}

/** The host session, if it belongs to exactly this installation and label. */
function hostSession({ record, slot, session }) {
  if (!record || !slot || !session) return null;
  if (session.label !== slot.label || session.installationId !== record.installationId) return null;
  if (typeof session.aud !== 'string' || !session.aud || !session.userId) return null;
  return session;
}

/** This Aura (D47), signed into every claim as `sys`; left out if the identity is unreadable. */
function systemClaim() {
  try { return { sys: localSystemId() }; } catch { return {}; }
}

function buildClaim({ record, slot }, { method, path, origin, userId, sid = null, owner = null }) {
  const iat = Math.floor(Date.now() / 1000);
  return {
    v: 1, ...systemClaim(), appId: record.appId, installationId: record.installationId, instanceId: slot.instanceId,
    label: slot.label, slot: slot.slot, origin, userId, ...(sid ? { sid } : {}), ...(owner ? { owner } : {}),
    method, path, iat, exp: iat + GATEWAY_CLAIM_TTL_S,
  };
}

/**
 * D45: the owner this request acts for, or null (gateway-identity.mjs
 * `ownerUiActs`): an allowlisted app's active `system` installation, on a
 * path its entry covers, while the session its host cookie came from is live.
 * Fails closed
 * when the registry can't be read.
 */
async function ownerActing(ctx, session, path) {
  // A restricted embed cookie (5.16) is never the owner, whatever the app.
  if (session.embed !== undefined || !ownerUiApp(ctx.record?.appId)) return null;
  try {
    const svc = ctx.services ?? await loadAppHostServices();
    if (!svc) return null;
    const acts = await ownerUiActs({
      appId: ctx.record.appId, installationId: ctx.record.installationId, sid: session.sid, userId: session.userId, path,
    }, svc);
    return acts ? { userId: session.userId, sid: session.sid } : null;
  } catch {
    return null;
  }
}

/** Everything the shell receives: allowlisted headers plus the verified identity. */
function shellHeaders(reqHeaders, claim) {
  const headers = {};
  for (const name of FORWARDED_REQUEST_HEADERS) {
    if (reqHeaders[name] !== undefined) headers[name] = reqHeaders[name];
  }
  headers[GATEWAY_IDENTITY_HEADER] = signGatewayClaim(claim);
  headers['x-aura-app-id'] = claim.appId;
  headers['x-aura-instance-id'] = claim.instanceId;
  // The KV and data routes still name their caller from the Referer, and read
  // a missing one as `system`. Set here from the claim, so that path can't apply.
  headers.referer = `http://127.0.0.1:${shellPort()}/api/proxy/${encodeURIComponent(claim.instanceId)}/`;
  return headers;
}

function csrfToken(session) {
  return createHmac('sha256', gatewayKey()).update(`csrf|${session.sid ?? ''}|${session.aud}`).digest('base64url');
}

function validCsrfToken(value, session) {
  if (typeof value !== 'string') return false;
  const given = Buffer.from(value);
  const want = Buffer.from(csrfToken(session));
  return given.length === want.length && timingSafeEqual(given, want);
}

/** Null when this browser request may reach the gateway, else the error code (host-policy.mjs). */
function gatewayBoundaryError(req, session) {
  return browserBoundaryError(req, {
    policy: 'gateway', origin: session.aud, csrf: validCsrfToken(req.headers[GATEWAY_CSRF_HEADER], session),
  });
}

function pipeToShell(req, res, path, headers) {
  const up = http.request({ host: '127.0.0.1', port: shellPort(), method: req.method, path, headers }, (ures) => {
    const out = {};
    for (const [k, v] of Object.entries(ures.headers)) {
      if (!DROPPED_RESPONSE_HEADERS.has(k) && !k.startsWith('access-control-')) out[k] = v;
    }
    out['x-content-type-options'] = 'nosniff';
    res.writeHead(ures.statusCode ?? 502, out);
    ures.pipe(res);
  });
  up.on('error', () => {
    if (res.headersSent) res.destroy();
    else refuse(res, 502, 'shell-unavailable');
  });
  res.on('close', () => { if (!res.writableFinished) up.destroy(); });
  req.pipe(up);
}

/** `/_aura/os/*`. See the file header for what is checked here and in the shell. */
export async function handleAppGateway(req, res, ctx) {
  if (!ctx?.slot?.instanceId) return refuse(res, 409, 'no-instance');
  const session = hostSession(ctx);
  if (!session) return refuse(res, 401, 'no-session');
  const boundary = gatewayBoundaryError(req, session);
  if (boundary) return refuse(res, boundary === 'method-not-allowed' ? 405 : 403, boundary);

  if ((req.url ?? '').split('?')[0] === GATEWAY_CSRF_PATH) {
    if (req.method !== 'GET') return refuse(res, 405, 'method-not-allowed');
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    return res.end(JSON.stringify({ token: csrfToken(session), header: GATEWAY_CSRF_HEADER }));
  }

  const path = gatewayShellPath(req.url);
  if (!path) return refuse(res, 404, 'not-a-gateway-path');
  const owner = await ownerActing(ctx, session, path);
  const claim = buildClaim(ctx, { method: req.method, path, origin: session.aud, userId: session.userId, sid: session.sid, owner });
  return pipeToShell(req, res, path, shellHeaders(req.headers, claim));
}

// ── scoped SSE mux ──────────────────────────────────────────────────────────

let scopedMux = null;

/** The gateway's one mux: only `serveScoped` reaches it. */
function gatewayMux() {
  scopedMux ??= createSseMux();
  return scopedMux;
}

/**
 * WebSocket upgrade for `/_aura/os/sse-mux`. Each stream goes through the same
 * path check and its own signed GET claim, and sends nothing from the upgrade
 * request. A stream the manifest refuses ends with the mux's `fail` frame.
 * Streams stay on instance rules even for a trusted system UI (D45): a stream
 * outlives the session check it started with.
 */
export async function handleAppGatewayUpgrade(req, socket, head, ctx) {
  const fail = (status, text) => {
    try { socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { /* gone */ }
  };
  socket.on('error', () => {});
  if ((req.url ?? '').split('?')[0] !== GATEWAY_MUX_PATH) return fail(404, 'Not Found');
  if (!ctx?.slot?.instanceId) return fail(409, 'Conflict');
  const session = hostSession(ctx);
  if (!session) return fail(401, 'Unauthorized');
  if (req.headers.origin !== session.aud) return fail(403, 'Forbidden');

  const baseHeaders = { accept: 'text/event-stream', 'cache-control': 'no-cache' };
  for (const name of ['user-agent', 'accept-language']) {
    if (req.headers[name] !== undefined) baseHeaders[name] = String(req.headers[name]);
  }
  const scope = {
    stream(rawUrl) {
      if (typeof rawUrl !== 'string') return null;
      const path = gatewayShellPath(rawUrl);
      if (!path) return null;
      // `sid`: the stream acts for this session's user (5.8). It never makes the owner (D45).
      const claim = buildClaim(ctx, { method: 'GET', path, origin: session.aud, userId: session.userId, sid: session.sid });
      return { url: `http://127.0.0.1:${shellPort()}${path}`, headers: shellHeaders(baseHeaders, claim) };
    },
  };
  try {
    (await gatewayMux()).serveScoped(req, socket, head, scope);
  } catch {
    fail(503, 'Service Unavailable');
  }
}

// ── runtime script ──────────────────────────────────────────────────────────

/**
 * `/_aura/runtime.js`: built by the shell for this instance (lib/appRuntime.ts).
 * It holds no credential and is revalidated by ETag. An app without a running
 * instance gets an empty script rather than a shared or `system` identity.
 */
export function serveAppRuntime(req, res, ctx) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return refuse(res, 405, 'method-not-allowed');
  if (!ctx?.record || !ctx.slot?.instanceId) {
    res.writeHead(503, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(req.method === 'HEAD' ? undefined : '/* AuraOS: this app has no running instance */\n');
  }
  const scope = ctx.record.instanceScope;
  const claim = buildClaim(ctx, {
    method: req.method,
    path: RUNTIME_ROUTE,
    origin: `app-host:${ctx.slot.label}`,
    userId: scope?.kind === 'user' ? scope.userId : 'shared',
  });
  const headers = shellHeaders({
    accept: 'text/javascript',
    ...(req.headers['if-none-match'] !== undefined ? { 'if-none-match': req.headers['if-none-match'] } : {}),
  }, claim);
  return pipeToShell(req, res, RUNTIME_ROUTE, headers);
}
