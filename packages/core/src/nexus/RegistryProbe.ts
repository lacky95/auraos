/**
 * Talk to an OCI registry's auth directly (Distribution spec, no `oras`):
 *
 *   • `checkRegistryLogin` — does this registry accept this username + password?
 *     `oras repo ls` can't answer that on registries that refuse
 *     `/v2/_catalog` to everyone (GitLab answers 401 even for a good login),
 *     so the login is checked where every registry must honour it: `/v2/`
 *     (Basic) or the token endpoint the `/v2/` challenge names (Bearer),
 *     asking for pull on one repo. A token server issues a token for a good
 *     login even when the repo grants nothing, and refuses a bad one.
 *   • `probeRegistryAddress` — is `https://host/<path>` an OCI registry? Used
 *     by store discovery when an address has no `/.well-known/aura-store.json`:
 *     the address itself then is the source (host = registry, path = prefix).
 */
import { orasHostFromUrl } from './RegistryConfig.js';
import type { RegistryLogin } from './RegistryAuth.js';

const TIMEOUT_MS = 10_000;

export type LoginCheck =
  | 'ok'          // the login works (or the registry is open)
  | 'rejected'    // the registry refused this username + password
  | 'required'    // the registry wants a login and none was given
  | 'unreachable';

interface Challenge { scheme: 'basic' | 'bearer'; realm?: string; service?: string }

/** Parse a `WWW-Authenticate` header. */
export function parseChallenge(header: string | null): Challenge | null {
  if (!header) return null;
  const m = /^\s*(Basic|Bearer)\b(.*)$/i.exec(header);
  if (!m) return null;
  const params: Record<string, string> = {};
  for (const p of m[2]!.matchAll(/([a-z_]+)="([^"]*)"/gi)) params[p[1]!.toLowerCase()] = p[2]!;
  return { scheme: m[1]!.toLowerCase() as 'basic' | 'bearer', realm: params['realm'], service: params['service'] };
}

function basic(login: RegistryLogin): string {
  return `Basic ${Buffer.from(`${login.username}:${login.password}`, 'utf-8').toString('base64')}`;
}

function v2Url(url: string): string {
  const scheme = url.startsWith('http://') ? 'http' : 'https';
  return `${scheme}://${orasHostFromUrl(url)}/v2/`;
}

/**
 * Check a login against the registry at `url` (host URL), asking for pull on
 * `repo` where the registry uses tokens. Never throws.
 */
export async function checkRegistryLogin(
  url: string, login: RegistryLogin | null, repo: string, fetchImpl: typeof fetch = fetch,
): Promise<LoginCheck> {
  let res: Response;
  try { res = await fetchImpl(v2Url(url), { signal: AbortSignal.timeout(TIMEOUT_MS) }); }
  catch { return 'unreachable'; }
  if (res.ok) return 'ok';
  if (res.status !== 401) return 'unreachable';
  const ch = parseChallenge(res.headers.get('www-authenticate'));
  if (!ch) return 'unreachable';
  if (!login) return 'required';
  try {
    if (ch.scheme === 'basic') {
      const r = await fetchImpl(v2Url(url), { headers: { authorization: basic(login) }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      return r.ok ? 'ok' : r.status === 401 || r.status === 403 ? 'rejected' : 'unreachable';
    }
    if (!ch.realm || !/^https?:\/\//.test(ch.realm)) return 'unreachable';
    const t = new URL(ch.realm);
    if (ch.service) t.searchParams.set('service', ch.service);
    t.searchParams.set('scope', `repository:${repo}:pull`);
    const r = await fetchImpl(t, { headers: { authorization: basic(login) }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    return r.ok ? 'ok' : r.status === 401 || r.status === 403 ? 'rejected' : 'unreachable';
  } catch { return 'unreachable'; }
}

export interface RegistryAddress {
  /** `https://host` — the source URL. */
  url:     string;
  /** The address's path, used as `appRepoPrefix` (undefined = default). */
  prefix?: string;
  /** The registry answered 401: it wants a login. */
  needsLogin: boolean;
}

const PREFIX = /^[a-z0-9][a-z0-9._/-]*$/;

/** `registry.example.com/team/apps` → is it an OCI registry? null when not. */
export async function probeRegistryAddress(address: string, fetchImpl: typeof fetch = fetch): Promise<RegistryAddress | null> {
  let u: URL;
  try { u = new URL(/^[a-z]+:\/\//i.test(address.trim()) ? address.trim() : `https://${address.trim()}`); }
  catch { return null; }
  if (u.protocol !== 'https:') return null;
  let res: Response;
  try { res = await fetchImpl(`https://${u.host}/v2/`, { signal: AbortSignal.timeout(TIMEOUT_MS) }); }
  catch { return null; }
  const isRegistry = !!res.headers.get('docker-distribution-api-version')
    || (res.status === 401 && !!parseChallenge(res.headers.get('www-authenticate')));
  if (!isRegistry || (!res.ok && res.status !== 401)) return null;
  const path = u.pathname.replace(/^\/+|\/+$/g, '').toLowerCase();
  return {
    url: `https://${u.host}`,
    ...(path && PREFIX.test(path) ? { prefix: path } : {}),
    needsLogin: res.status === 401,
  };
}
