/**
 * How the shell's plain `.mjs` servers reach the access observer, which lives
 * in the Astro build and can't be imported from here.
 *
 *   globalThis[Symbol.for('aura.access')]   registered by lib/access/observer.ts
 *
 * The report side never throws, returns a decision or is awaited by a caller.
 * Events sent before the observer registers (it loads on the first Astro
 * request) are only counted. `surfaceGate` is the one decision a surface
 * waits for: it refuses only in `enforce`, and fails closed there.
 * AURA_ACCESS_ENFORCE=off (access-mode.mjs) stops the report and the
 * internal service label.
 */
import { randomBytes } from 'node:crypto';
import { accessMode } from './access-mode.mjs';

const BRIDGE = Symbol.for('aura.access');
const EARLY = Symbol.for('aura.access.early');
const INTERNAL = Symbol.for('aura.access.internal');

/** Labels the shell's own loopback calls in the report. Grants nothing. */
export const INTERNAL_SERVICE_HEADER = 'x-aura-internal-service';
export const SESSION_COOKIES = new Set(['aura_session', '__Host-aura_session']);

const reporting = () => accessMode() !== 'off';

function withBridge(fn) {
  try {
    if (!reporting()) return;
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

/** The observer's verdict on these credentials, started now. Null before it is loaded. */
function verify(facts) {
  try {
    if (!reporting()) return null;
    const identify = globalThis[BRIDGE]?.identify;
    if (typeof identify !== 'function') return null;
    return Promise.resolve(identify(facts)).catch(() => null);
  } catch {
    return null;
  }
}

/**
 * The request's identity: the principal resolver's verdict (lib/access/
 * identify.ts, through the observer), started while the request is in hand,
 * plus the two report hints and the socket peer (a `networkCaller` rule, D28).
 * No credential is kept: not the bearer, not a cookie. `appHost`: an App
 * Host session app-hosts.mjs already verified.
 */
export function surfaceIdentity(headers, { method = 'GET', url = '/', appHost = null, peer = null } = {}) {
  try {
    return {
      verified: verify({ headers, method, url, appHost }),
      referer: first(headers?.referer),
      instanceId: first(headers?.['x-aura-instance-id']),
      peer: typeof peer === 'string' ? peer : null,
    };
  } catch {
    return null;
  }
}

/** One identity per request, so a surface that hands a request on reports and decides on the same verdict. */
const identities = new WeakMap();

/** The identity of a Node request, started once: `appHost` as surfaceIdentity. */
export function requestIdentity(req, { appHost = null } = {}) {
  let id = identities.get(req);
  if (id === undefined) {
    id = surfaceIdentity(req?.headers, { method: req?.method, url: req?.url, appHost, peer: req?.socket?.remoteAddress ?? null });
    if (req && typeof req === 'object') identities.set(req, id);
  }
  return id;
}

/**
 * End a long-lived socket with the sign-in it was let in on (M4): a session
 * revocation, logout or password change closes it, as it ends the event
 * streams (lib/streamSession.ts `followSession`, the one mechanism, through
 * the observer). `identity` is the one the surface decided on; a verdict that
 * rides on no session (an app token, the operator) is not followed. Returns
 * the function that stops following, for the socket's close. Never throws.
 */
export function followIdentity(identity, end) {
  let stopped = false;
  let handle = null;
  try {
    const follow = globalThis[BRIDGE]?.followSession;
    const verified = identity?.verified;
    if (typeof follow === 'function' && verified) {
      void verified.then((v) => {
        if (!stopped && v?.principal) handle = follow(v.principal, end);
      }).catch(() => {});
    }
  } catch { /* nothing to follow */ }
  return () => {
    stopped = true;
    try { handle?.stop(); } catch { /* already stopped */ }
  };
}

// ── the surface gate ────────────────────────────────────────────────────────

/**
 * Whether a surface may go on: `{ subject, method, appId?, identity }`, the
 * same observation `reportSurface` takes. Outside `enforce` always yes (the
 * report counts it as before). In `enforce` the observer decides on the
 * surface's manifest rule; a refusal, an observer that isn't loaded yet or
 * any failure is a no. Never throws.
 */
export async function surfaceGate(observation) {
  try {
    if (accessMode() !== 'enforce') return true;
    const decide = globalThis[BRIDGE]?.decideSurface;
    if (typeof decide !== 'function') return false;
    const decision = await decide(observation);
    return decision?.outcome === 'allow';
  } catch {
    return false;
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

/** Whether this request waits for `surfaceGate` before the dev server serves it (`enforce` only). */
export const gatedHttpSurface = (req) => accessMode() === 'enforce' && staticSurface(req?.url) === 'vite-dev-server';

export function observeHttpSurface(req, res) {
  try {
    if (!reporting()) return;
    const subject = staticSurface(req.url);
    if (!subject) return;
    const identity = requestIdentity(req);
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

/** The per-boot label for a call to `url`: empty unless it is literal loopback. */
export function internalServiceHeaders(url) {
  try {
    if (!reporting() || !isLiteralLoopback(url)) return {};
    globalThis[INTERNAL] ??= randomBytes(32).toString('hex');
    return { [INTERNAL_SERVICE_HEADER]: globalThis[INTERNAL] };
  } catch {
    return {};
  }
}
