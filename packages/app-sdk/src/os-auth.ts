/**
 * The SDK's one place for "where is the OS" and "which credential goes there".
 *
 * A browser never sends a token, and a proxied app URL never carries one.
 * Most SDK calls stay anonymous on purpose: only callers that already sent the
 * instance token (notifications, OS sidecars, aurashelld) use osAuthHeaders.
 */
import type { AuraRuntimeBootstrap } from '@aura/core';
import { AURA_CHANNEL_VERSION } from './auraChannel.js';
import { AURA_RESERVED_PATHS } from './hostRules.js';

const LOCAL_OS = 'http://localhost:3000';

export function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

/** process.env, or {} where there is no `process` (a bare reference would throw). */
export function osEnv(): Record<string, string | undefined> {
  return typeof process !== 'undefined' && process.env ? process.env : {};
}

/**
 * The bootstrap of `/_aura/runtime.js` when this page runs on an App Host, else
 * null (proxied, server, or outside AuraOS). It selects a transport and grants
 * nothing: the gateway and the Shell verify the caller themselves.
 */
export function appHostRuntime(): AuraRuntimeBootstrap | null {
  if (!isBrowser()) return null;
  const b = (window as unknown as { AuraRuntimeBootstrap?: AuraRuntimeBootstrap }).AuraRuntimeBootstrap;
  if (!b || b.channelVersion !== AURA_CHANNEL_VERSION || b.gatewayBase !== AURA_RESERVED_PATHS.os) return null;
  if (b.appOrigin !== window.location.origin || typeof b.shellOrigin !== 'string' || !b.shellOrigin) return null;
  return b;
}

/**
 * Headers for a mutation that sends no body. The gateway's CSRF rule needs a
 * JSON content type; a proxied call stays as it was.
 */
export function bodylessMutationHeaders(): Record<string, string> {
  return appHostRuntime() ? { 'Content-Type': 'application/json' } : {};
}

export interface OsBaseOptions {
  /**
   * On an App Host, `relative` and `origin` are the same-origin gateway.
   * `relative` (default): '' in a browser, else OS_API_BASE.
   * `origin`: OS_API_BASE, else the page's origin (OsClient).
   * `server`: OS_API_BASE, else AURA_OS_URL, else '' so the caller can refuse.
   */
  mode?: 'relative' | 'origin' | 'server';
  /** Used outside AuraOS, for `relative` and `origin`. */
  fallback?: string;
}

export function osBase(opts: OsBaseOptions = {}): string {
  const { mode = 'relative', fallback = LOCAL_OS } = opts;
  const host = mode === 'server' ? null : appHostRuntime();
  if (host) {
    const gateway = host.gatewayBase.replace(/\/$/, '');
    return mode === 'origin' ? `${window.location.origin}${gateway}` : gateway;
  }
  if (mode === 'server') return osEnv()['OS_API_BASE'] ?? osEnv()['AURA_OS_URL'] ?? '';
  if (mode === 'origin') return osEnv()['OS_API_BASE'] ?? (isBrowser() ? window.location.origin : fallback);
  if (isBrowser()) return '';
  return osEnv()['OS_API_BASE'] ?? fallback;
}

/**
 * The URL of a shell path (`/api/os/icons.svg`) for this page, on either route.
 * For anything an app can't reach through an SDK method: an icon sprite, an
 * `<img>`, a hand-written fetch.
 */
export function osUrl(path: `/${string}`): string {
  return `${osBase()}${path}`;
}

/** True for any spelling of /api/proxy. An unparsable URL counts as proxied. */
function isProxyUrl(url: string): boolean {
  try {
    let path = url.startsWith('/') ? url.split(/[?#]/, 1)[0]! : new URL(url).pathname;
    for (let i = 0; i < 3; i++) {
      const decoded = decodeURIComponent(path);
      if (decoded === path) break;
      path = decoded;
    }
    path = path.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
    path = new URL(`http://os${path.startsWith('/') ? '' : '/'}${path}`).pathname;
    return /^\/api\/proxy(\/|$)/i.test(path);
  } catch {
    return true;
  }
}

/** The instance bearer for this URL, or {} in a browser or on a proxied path. */
export function osAuthHeaders(url: string, opts: { token?: string } = {}): Record<string, string> {
  if (isBrowser() || isProxyUrl(url)) return {};
  const token = opts.token ?? osEnv()['AURA_INSTANCE_TOKEN'];
  return token ? { Authorization: `Bearer ${token}` } : {};
}
