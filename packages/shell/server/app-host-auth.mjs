/**
 * App Host sign-in: the one-time handoff code and the host-only app cookie.
 *
 * The shell issues a code for one label, slot and session. `/_aura/handoff` on
 * that exact origin redeems it once and sets the cookie. Codes live in this
 * process, because a code outlives no restart that matters. The cookie is
 * signed with a key kept in the master container, so open windows survive a
 * shell restart, and every request rechecks the session it came from.
 *
 * The Astro route and the plain server load separate copies of this file, so
 * the state is pinned on globalThis.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appHostCookieName, isAuraReservedPath } from '@aura/core/host-rules';

export const HANDOFF_TTL_MS = 60_000;
export const APP_COOKIE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const MAX_PENDING_CODES = 10_000;
const MAX_RETURN_PATH = 2048;
const CODE_RE = /^[A-Za-z0-9_-]{43}$/;
const AUTH = Symbol.for('aura.appHosts.auth');
const SERVICES = Symbol.for('aura.appHosts.services');

/**
 * The restricted cookie of an embed handoff (D25, 5.16): one Terminal session
 * shown inside one app. Its own name, so it never replaces the full cookie a
 * desktop window of the same host holds, and a full read never accepts it.
 */
export const appHostEmbedCookieName = (secure) => `${appHostCookieName(secure)}_embed`;

const EMBED_SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}#[A-Za-z0-9._-]{1,64}$/;
const EMBED_LABEL_RE = /^[a-z0-9]{1,63}$/;

/** A well-formed embed claim, copied, or null. */
function embedClaim(value) {
  if (!value || typeof value !== 'object') return null;
  const { sessionId, embedder } = value;
  if (typeof sessionId !== 'string' || !EMBED_SESSION_RE.test(sessionId)) return null;
  if (typeof embedder !== 'string' || !EMBED_LABEL_RE.test(embedder)) return null;
  return { sessionId, embedder };
}

const sign = (secret, body) => createHmac('sha256', secret).update(`aura-app-cookie\0${body}`).digest();

/**
 * A same-origin path to continue to, normalized, or null. The check runs on
 * the parsed path: `/.//evil.example` parses to `//evil.example`.
 */
export function safeReturnPath(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_RETURN_PATH) return null;
  if (!value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(value)) return null;
  let url;
  try { url = new URL(value, 'http://return.invalid'); } catch { return null; }
  if (url.origin !== 'http://return.invalid' || url.pathname.startsWith('//')) return null;
  const path = `${url.pathname}${url.search}${url.hash}`;
  return isAuraReservedPath(path) ? null : path;
}

/** Every value of cookie `name` in a Cookie header. */
export function cookieValues(header, name) {
  const lines = Array.isArray(header) ? header : [header ?? ''];
  return lines.flatMap((line) => String(line).split(';').flatMap((part) => {
    const eq = part.indexOf('=');
    return eq > 0 && part.slice(0, eq).trim() === name ? [part.slice(eq + 1).trim()] : [];
  }));
}

export function createAppHostAuth({ secret, now = Date.now }) {
  /** code → { claim, sessionExpiresAt } */
  const pending = new Map();

  function sweep() {
    const t = now();
    for (const [code, entry] of pending) if (entry.claim.exp <= t) pending.delete(code);
    while (pending.size >= MAX_PENDING_CODES) pending.delete(pending.keys().next().value);
  }

  /** @returns {{ code: string, expiresAt: number }} */
  /** `embed` makes it a restricted embed code (see appHostEmbedCookieName). */
  function issueCode({ aud, label, installationId, appId, slot, userId, sid, returnPath, sessionExpiresAt = null, embed = null }) {
    const restricted = embed === null ? null : embedClaim(embed);
    if (embed !== null && !restricted) throw new TypeError('malformed embed claim');
    sweep();
    const code = randomBytes(32).toString('base64url');
    const iat = now();
    const exp = iat + HANDOFF_TTL_MS;
    const claim = {
      v: 1, jti: code, aud, label, installationId, appId, slot, userId, sid, returnPath,
      ...(restricted ? { embed: restricted } : {}), iat, exp,
    };
    pending.set(code, { claim, sessionExpiresAt });
    return { code, expiresAt: exp };
  }

  /**
   * Redeem a code on `aud`. The code is gone after this call whatever the
   * outcome, and the read and delete run with no await between them.
   */
  function consumeCode(code, { aud, label }) {
    if (typeof code !== 'string' || !CODE_RE.test(code)) return null;
    const entry = pending.get(code);
    if (!entry) return null;
    pending.delete(code);
    const { claim } = entry;
    if (claim.exp <= now() || claim.aud !== aud || claim.label !== label) return null;
    return entry;
  }

  /** The signed cookie value and its lifetime, capped by the session's. */
  function sealCookie({ claim, sessionExpiresAt }) {
    const iat = now();
    const exp = Math.min(iat + APP_COOKIE_TTL_MS, sessionExpiresAt ?? Infinity);
    const embed = claim.embed === undefined ? null : embedClaim(claim.embed);
    if (claim.embed !== undefined && !embed) throw new TypeError('malformed embed claim');
    const payload = {
      v: 1, aud: claim.aud, label: claim.label, installationId: claim.installationId,
      userId: claim.userId, sid: claim.sid, ...(embed ? { embed } : {}), iat, exp,
    };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return { value: `${body}.${sign(secret, body).toString('base64url')}`, maxAgeSeconds: Math.max(0, Math.floor((exp - iat) / 1000)), payload };
  }

  /** `embed`: read the restricted embed cookie, else only a full one passes. */
  function openCookie(value, { aud, label, installationId, embed = false }) {
    const dot = String(value).indexOf('.');
    if (dot <= 0) return null;
    const body = value.slice(0, dot);
    const mac = Buffer.from(value.slice(dot + 1), 'base64url');
    const expected = sign(secret, body);
    if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) return null;
    try {
      const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      if (p.v !== 1 || p.aud !== aud || p.label !== label || p.installationId !== installationId) return null;
      if (typeof p.sid !== 'string' || typeof p.userId !== 'string' || !(p.exp > now())) return null;
      // A restricted cookie never reads as a full one, under any name.
      if (embed ? !embedClaim(p.embed) : p.embed !== undefined) return null;
      return p;
    } catch {
      return null;
    }
  }

  /**
   * The payload of the one cookie that validates. A sibling on the same site
   * can plant another with this name, so a bad value never hides a good one.
   */
  function readCookie(header, name, expected) {
    for (const value of cookieValues(header, name)) {
      const payload = openCookie(value, expected);
      if (payload) return payload;
    }
    return null;
  }

  return { issueCode, consumeCode, sealCookie, readCookie };
}

/** The 0600 signing key, created once. Unusable storage means a per-boot key. */
function loadCookieKey(env = process.env) {
  const file = join(env.AURA_DATA_DIR ?? '/data', 'aura', 'secrets', 'app-host.key');
  const read = () => {
    const key = Buffer.from(readFileSync(file, 'utf8').trim(), 'hex');
    if (key.length !== 32) throw new Error('malformed');
    return key;
  };
  try {
    return read();
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      console.warn(`[app-hosts] the cookie key is unusable (${err?.code ?? err?.message}); using a per-boot key`);
      return randomBytes(32);
    }
  }
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const key = randomBytes(32);
    const fd = openSync(file, 'wx', 0o600);
    try { writeSync(fd, key.toString('hex')); } finally { closeSync(fd); }
    return key;
  } catch (err) {
    if (err?.code === 'EEXIST') {
      try { return read(); } catch { /* per-boot key below */ }
    }
    console.warn(`[app-hosts] the cookie key could not be stored (${err?.code ?? 'error'}); using a per-boot key`);
    return randomBytes(32);
  }
}

/** The process-wide instance, shared by the Astro route and the router. */
export function appHostAuth() {
  globalThis[AUTH] ??= createAppHostAuth({ secret: loadCookieKey() });
  return globalThis[AUTH];
}

/**
 * Whether the login session a cookie or claim names is live for that user:
 * not revoked, not expired, a password session of `userId`, who is still the
 * enabled owner. The same conditions as the desktop's sign-in check
 * (authSurface `ownerSessionOf`), for holders of a session id instead of the
 * token. Rejects when the store can't be read, so callers fail closed.
 */
export function createSessionLive({ sessions, users }) {
  return async (sid, userId) => {
    if (typeof sid !== 'string' || !sid || typeof userId !== 'string' || !userId) return false;
    if (!(await sessions.isLive(sid, userId))) return false;
    const owner = await users.getOwner();
    return !!owner && !owner.disabled && owner.id === userId;
  };
}

/**
 * The registry and session check, or null while this core has no registry.
 * Throws when it has one that can't be reached, so callers fail closed.
 */
export async function loadAppHostServices() {
  if (globalThis[SERVICES]) return globalThis[SERVICES];
  const core = await import('@aura/core');
  if (typeof core.getAppHostServices !== 'function') return null;
  // The shared singleton: it knows manifest host names, so generated names avoid them.
  const shared = core.getAppHostServices();
  const registry = shared.registry;
  const auth = core.getAuthServices();
  globalThis[SERVICES] = {
    registry,
    sessionLive: createSessionLive({ sessions: auth.loginSessions, users: auth.users }),
  };
  return globalThis[SERVICES];
}
