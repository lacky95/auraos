/**
 * The SDK's one place for "where is the OS" and "which credential goes there".
 *
 * Two paths, one each side:
 *   - a page on an App Host reaches the shell through its same-origin gateway
 *     (`/_aura/os/`), which signs the page's verified identity. A browser never
 *     sends a token.
 *   - an app's server reaches `OS_API_BASE` and proves itself with its instance
 *     token (`osAuthHeaders`). The machine path to another app,
 *     `/api/proxy/<id>/…`, never carries one: the shell forwards it upstream.
 */
import type { AuraRuntimeBootstrap } from '@aura/core';
import { AURA_CHANNEL_VERSION } from './auraChannel.js';
import { AURA_RESERVED_PATHS, OWNER_SSR_HEADER } from './hostRules.js';

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
 * null (server, or outside AuraOS). It is the SDK's one source of the page's
 * app, instance, activity, theme and keymap snapshot. It selects a transport
 * and grants nothing: the gateway and the Shell verify the caller themselves.
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
 * JSON content type; the server path doesn't.
 */
export function bodylessMutationHeaders(): Record<string, string> {
  return appHostRuntime() ? { 'Content-Type': 'application/json' } : {};
}

export interface OsBaseOptions {
  /**
   * On an App Host, `relative` and `origin` are the same-origin gateway.
   * Elsewhere (the server, or a page outside AuraOS):
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
 * The URL of a shell path (`/api/os/icons.svg`): the gateway in a page on an App
 * Host, OS_API_BASE on the server. For anything an app can't reach through an SDK method: an icon sprite, an
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

/** The origin of an absolute http(s) URL, else null. */
function httpOrigin(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch { return null; }
}

/**
 * Whether `url` goes to this app's shell (L2): a path, which the caller
 * resolves against the OS base, or an absolute URL on the origin of the OS
 * base (OS_API_BASE, or the sidecar's AURA_OS_URL), or of the base an SDK
 * client was configured with (`base`). As the CLI's `isRunnerShellUrl`:
 * credentials never go to a third party.
 */
function isShellUrl(url: string, base?: string): boolean {
  if (url.startsWith('/') && !url.startsWith('//')) return true;
  const origin = httpOrigin(url);
  if (origin === null) return false;
  return [osBase(), osBase({ mode: 'server' }), base ?? ''].some((b) => b !== '' && httpOrigin(b) === origin);
}

/**
 * The instance bearer for this URL, or {} in a browser, on a proxied path or
 * for a URL that is not the shell's (L2).
 * `request`: the page request being rendered. A trusted system UI (Settings,
 * Nexus) gets the owner's signed SSR claim on it from the router (D45), and it
 * goes back to the shell with the bearer, so the page's reads act for the
 * owner. Any other app never gets one, and the shell ignores it without the
 * bearer of the instance it names.
 */
export function osAuthHeaders(url: string, opts: { token?: string; request?: Request; base?: string } = {}): Record<string, string> {
  if (isBrowser() || isProxyUrl(url) || !isShellUrl(url, opts.base)) return {};
  const token = opts.token ?? osEnv()['AURA_INSTANCE_TOKEN'];
  if (!token) return {};
  const ownerSsr = opts.request?.headers.get(OWNER_SSR_HEADER);
  return { Authorization: `Bearer ${token}`, ...(ownerSsr ? { [OWNER_SSR_HEADER]: ownerSsr } : {}) };
}
