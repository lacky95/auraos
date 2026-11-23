/**
 * The SDK's one place for "where is the OS" and "which credential goes there".
 *
 * A browser never sends a token, and a proxied app URL never carries one.
 * Most SDK calls stay anonymous on purpose: only callers that already sent the
 * instance token (notifications, OS sidecars, aurashelld) use osAuthHeaders.
 */
const LOCAL_OS = 'http://localhost:3000';

export function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

/** process.env, or {} where there is no `process` (a bare reference would throw). */
export function osEnv(): Record<string, string | undefined> {
  return typeof process !== 'undefined' && process.env ? process.env : {};
}

export interface OsBaseOptions {
  /**
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
  if (mode === 'server') return osEnv()['OS_API_BASE'] ?? osEnv()['AURA_OS_URL'] ?? '';
  if (mode === 'origin') return osEnv()['OS_API_BASE'] ?? (isBrowser() ? window.location.origin : fallback);
  if (isBrowser()) return '';
  return osEnv()['OS_API_BASE'] ?? fallback;
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
