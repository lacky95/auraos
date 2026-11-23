/**
 * Which Host a request is for, and which forwarded headers count. The one
 * Host allowlist and the one trusted-proxy check of the shell's plain servers.
 *
 * `X-Forwarded-*` counts only from a peer listed in AURA_TRUSTED_PROXIES. An
 * empty list trusts nobody. A proxy appends its own value, so the last one is
 * the value it vouches for.
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

/**
 * `report` keeps every address that works today. `enforce` refuses unknown
 * Hosts.
 * PHASE2-CUTOVER: make `enforce` the only behavior and remove AURA_HOST_POLICY.
 */
export const hostPolicy = (env = process.env) => (env.AURA_HOST_POLICY === 'enforce' ? 'enforce' : 'report');
