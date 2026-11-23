/**
 * How the shell's plain `.mjs` servers reach the access observer, which lives
 * in the Astro build and can't be imported from here.
 *
 *   globalThis[Symbol.for('aura.access')]   registered by lib/access/observer.ts
 *
 * Everything here is report-only: no function throws, returns a decision or is
 * awaited by a caller. Events sent before the observer registers (it loads on
 * the first Astro request) are only counted. AURA_ACCESS_REPORT=off stops all
 * of it, including the internal service label.
 */
import { randomBytes } from 'node:crypto';

const BRIDGE = Symbol.for('aura.access');
const EARLY = Symbol.for('aura.access.early');
const INTERNAL = Symbol.for('aura.access.internal');

/** Labels the shell's own loopback calls in the report. Grants nothing. */
export const INTERNAL_SERVICE_HEADER = 'x-aura-internal-service';
export const SESSION_COOKIES = new Set(['aura_session', '__Host-aura_session']);

export const accessReportEnabled = () =>
  (process.env.AURA_ACCESS_REPORT ?? '').trim().toLowerCase() !== 'off';

function withBridge(fn) {
  try {
    if (!accessReportEnabled()) return;
    const bridge = globalThis[BRIDGE];
    if (bridge) fn(bridge);
    else globalThis[EARLY] = (globalThis[EARLY] ?? 0) + 1;
  } catch { /* report-only */ }
}

/** `{ subject, method, status, appId?, via?, identity }`, checked by the bridge. */
export const reportSurface = (observation) => withBridge((b) => b.observeSurface?.(observation));
export const countSurfaceEvent = (subject) => withBridge((b) => b.countEvent?.(subject));
export const countCredential = (kind, surface) => withBridge((b) => b.countCredential?.(kind, surface));

const first = (v) => (Array.isArray(v) ? v[0] : v) ?? null;

/** The request facts identity observation needs. The cookie value is not kept. */
export function surfaceIdentity(headers) {
  try {
    const cookie = first(headers?.cookie);
    return {
      authorization: first(headers?.authorization),
      sessionCookie: typeof cookie === 'string'
        && cookie.split(';').some((c) => SESSION_COOKIES.has(c.split('=', 1)[0].trim())),
      referer: first(headers?.referer),
      instanceId: first(headers?.['x-aura-instance-id']),
    };
  } catch {
    return null;
  }
}

// ── static and dev-server requests (from the server.emit wrapper) ───────────

const VITE_PREFIXES = ['/@vite/', '/@fs/', '/@id/', '/src/', '/node_modules/'];

/** The surface id of a request Astro's middleware never sees, or null. */
export function staticSurface(url) {
  const path = String(url ?? '').split('?')[0];
  if (path.startsWith('/_astro/') || path === '/favicon.ico') return 'shell-static-assets';
  if (process.env.AURA_SHELL_RUNTIME !== 'prod' && VITE_PREFIXES.some((p) => path.startsWith(p))) return 'vite-dev-server';
  return null;
}

export function observeHttpSurface(req, res) {
  try {
    if (!accessReportEnabled()) return;
    const subject = staticSurface(req.url);
    if (!subject) return;
    const identity = surfaceIdentity(req.headers);
    const method = req.method;
    res.once('close', () => reportSurface({
      subject, method, identity, status: res.headersSent ? res.statusCode : 0,
    }));
  } catch { /* report-only */ }
}

// ── internal service label ──────────────────────────────────────────────────

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]']);

function isLiteralLoopback(url) {
  try { return LOOPBACK_HOSTS.has(new URL(url).hostname); } catch { return false; }
}

/** `url` with `localhost` spelled as 127.0.0.1, or null if it isn't loopback. */
export function loopbackUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'localhost') u.hostname = '127.0.0.1';
    return LOOPBACK_HOSTS.has(u.hostname) ? u.href : null;
  } catch {
    return null;
  }
}

/** The per-boot label for a call to `url`: empty unless it is literal loopback. */
export function internalServiceHeaders(url) {
  try {
    if (!accessReportEnabled() || !isLiteralLoopback(url)) return {};
    globalThis[INTERNAL] ??= randomBytes(32).toString('hex');
    return { [INTERNAL_SERVICE_HEADER]: globalThis[INTERNAL] };
  } catch {
    return {};
  }
}
