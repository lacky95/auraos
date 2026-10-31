/**
 * Logins for private OCI sources, shared by the /api/nexus/sources routes.
 *
 * The password arrives once in a request body, is checked against the
 * registry (`oras repo ls` with that login), then sealed by core
 * (`saveRegistryLogin` — OS-only Aura Context secret bound to the registry
 * host). It is never stored in the sources config and never sent back.
 */

// Namespace import: the running shell may cache a core build without newer exports.
import * as core from '@aura/core';
import { jsonResponse } from './appResponse.js';

export interface LoginInput { username: string; password: string }

/** `{username, password}` from a request body: both or neither. */
export function loginFromBody(body: Record<string, unknown>): LoginInput | null | Response {
  const u = body['username'];
  const p = body['password'];
  if (u === undefined && p === undefined) return null;
  if (typeof u !== 'string' || !u.trim() || typeof p !== 'string' || !p) {
    return jsonResponse({ error: 'invalid-login', detail: 'a login needs both a username and a password' }, 400);
  }
  return { username: u.trim(), password: p };
}

export type ProbeResult =
  | { ok: true; apps: number }
  | { ok: false; status: 422; error: 'login-failed' | 'login-required' | 'unreachable'; detail: string };

/**
 * Check the source (with `login` when given) and count its apps. Never throws.
 *
 *   1. `oras repo ls` — registries with a catalog API.
 *   2. The source's catalog artifact (OciCatalog) — registries without one
 *      (GitLab refuses /v2/_catalog even to a good login).
 *   3. Neither lists: the login itself is checked with the registry's auth
 *      handshake (RegistryProbe) — a good login to a store with no apps yet
 *      is fine, a bad one is refused.
 */
export async function probeOciSource(url: string, login: LoginInput | null, appRepoPrefix = 'aura-apps'): Promise<ProbeResult> {
  const host = core.orasHostFromUrl(url);
  const prefix = appRepoPrefix.replace(/\/+$/, '');
  const flags = core.orasFlagsForUrl(url);
  let listErr: unknown;
  try {
    const out = core.orasSync(['repo', 'ls', host, ...flags], { timeout: 20_000 }, login ?? undefined).toString();
    const apps = out.split('\n').map((s) => s.trim())
      .filter((r) => r.startsWith(`${prefix}/`) && r !== core.catalogRepo(prefix)).length;
    return { ok: true, apps };
  } catch (err) { listErr = err; }

  const catalog = core.readOciCatalog({ host, prefix, flags }, login ?? undefined);
  if (catalog) return { ok: true, apps: catalog.apps.length };

  if (listErr instanceof core.OrasAuthError) {
    const check = await core.checkRegistryLogin(url, login, core.catalogRepo(prefix));
    if (check === 'ok') return { ok: true, apps: 0 };
    if (check === 'required' || (check === 'rejected' && !login)) {
      return { ok: false, status: 422, error: 'login-required', detail: `${host} needs a login — add a username and password` };
    }
    if (check === 'rejected') {
      return { ok: false, status: 422, error: 'login-failed', detail: `${host} did not accept that username and password` };
    }
    return { ok: false, status: 422, error: 'unreachable', detail: `could not reach ${host} to check the login` };
  }
  const msg = (listErr as Error).message.split('\n').filter(Boolean).pop() ?? 'no answer';
  return { ok: false, status: 422, error: 'unreachable', detail: `could not reach ${host}: ${msg}` };
}

/** An oci URL with a path is host + app prefix: move the path into
 *  `appRepoPrefix` (an explicit prefix wins). */
export function normaliseOciEntry(entry: { url: string; appRepoPrefix?: string }): void {
  const { url, prefix } = core.splitOciUrl(entry.url);
  entry.url = url;
  if (prefix && !entry.appRepoPrefix) entry.appRepoPrefix = prefix;
}

export function probeError(p: Extract<ProbeResult, { ok: false }>): Response {
  return jsonResponse({ error: p.error, detail: p.detail }, p.status);
}

/** After a config change: wait until the new logins are loaded. */
export async function credentialsLoaded(): Promise<void> {
  try {
    const mgr = core.getNexusManager() as { whenCredentialsReady?: () => Promise<void> };
    await mgr.whenCredentialsReady?.();
  } catch { /* no manager yet — the next ensureSourcesLoaded loads them */ }
}

/** A source entry as it may leave the shell: never a password. */
export function publicEntry<T extends object>(entry: T): T {
  const e = { ...entry } as Record<string, unknown>;
  delete e['password'];
  return e as T;
}
