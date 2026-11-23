/**
 * The one place that removes the shell's own credentials from a request about
 * to leave for an app. Used by the HTTP proxy, the data route, the WS proxy,
 * the SSE mux and App Hosts (HTTP and raw upgrade).
 *
 * Removes only:
 *   - the session cookie (`aura_session`, `__Host-aura_session`)
 *   - bearers starting `aura-sess1.` or `aura-admin1.`
 *   - the internal service label
 *
 * App cookies and app-owned auth pass through byte for byte. Instance tokens
 * and API keys are still forwarded and only counted: Phase 3 decides them.
 */
import { INTERNAL_SERVICE_HEADER, SESSION_COOKIES, countCredential } from './access-bridge.mjs';

const SHELL_BEARER = /(?:^|,)\s*Bearer\s+aura-(sess1|admin1)\./i;
const INSTANCE_BEARER = /(?:^|,)\s*Bearer\s+aura1\./i;
const API_KEY_BEARER = /(?:^|,)\s*Bearer\s+aura_k1_/i;

/** The Cookie value without the cookies in `names`; null when nothing is left. */
export function stripCookies(value, names) {
  const parts = String(value).split(';');
  const kept = parts.filter((p) => !names.has(p.split('=', 1)[0].trim()));
  if (kept.length === parts.length) return value;
  return kept.map((p) => p.trim()).filter(Boolean).join('; ') || null;
}

/** The Cookie value without the session cookie; null when nothing is left. */
export const stripSessionCookie = (value) => stripCookies(value, SESSION_COOKIES);

function cleanCookie(value, surface) {
  const next = stripSessionCookie(value);
  if (next !== value) countCredential('stripped-session-cookie', surface);
  return next;
}

function cleanAuthorization(value, surface) {
  const text = String(value);
  const shell = SHELL_BEARER.exec(text);
  if (shell) {
    countCredential(shell[1].toLowerCase() === 'admin1' ? 'stripped-admin-bearer' : 'stripped-login-bearer', surface);
    return null;
  }
  if (INSTANCE_BEARER.test(text)) countCredential('forwarded-instance-token', surface);
  else if (API_KEY_BEARER.test(text)) countCredential('forwarded-api-key', surface);
  return value;
}

function cleanValue(name, value, surface) {
  if (name === INTERNAL_SERVICE_HEADER) return null;
  if (name === 'cookie') return cleanCookie(value, surface);
  if (name === 'authorization') return cleanAuthorization(value, surface);
  return value;
}

/**
 * Remove shell credentials from `headers`, in the form the caller holds them:
 * a web `Headers` or a Node headers object (changed in place), or a flat
 * `rawHeaders` array (a new array). Returns the cleaned headers.
 */
export function stripShellCredentials(headers, surface) {
  if (Array.isArray(headers)) {
    const out = [];
    for (let i = 0; i + 1 < headers.length; i += 2) {
      const value = cleanValue(String(headers[i]).toLowerCase(), headers[i + 1], surface);
      if (value !== null) out.push(headers[i], value);
    }
    return out;
  }
  if (typeof headers?.get === 'function') {
    for (const name of ['cookie', 'authorization', INTERNAL_SERVICE_HEADER]) {
      const current = headers.get(name);
      if (current === null) continue;
      const value = cleanValue(name, current, surface);
      if (value === null) headers.delete(name);
      else if (value !== current) headers.set(name, value);
    }
    return headers;
  }
  for (const key of Object.keys(headers ?? {})) {
    const name = key.toLowerCase();
    if (name !== 'cookie' && name !== 'authorization' && name !== INTERNAL_SERVICE_HEADER) continue;
    const current = headers[key];
    if (Array.isArray(current)) {
      const kept = current.map((v) => cleanValue(name, v, surface)).filter((v) => v !== null);
      if (kept.length) headers[key] = kept;
      else delete headers[key];
      continue;
    }
    const value = cleanValue(name, current, surface);
    if (value === null) delete headers[key];
    else headers[key] = value;
  }
  return headers;
}

/** A response an app sent, without its claim to widen a service worker's scope. */
export function dropServiceWorkerScope(response) {
  const name = 'service-worker-allowed';
  if (!response.headers.has(name)) return response;
  try {
    response.headers.delete(name);
    return response;
  } catch {
    const headers = new Headers(response.headers);
    headers.delete(name);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
}
