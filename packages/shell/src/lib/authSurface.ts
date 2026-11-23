/**
 * The owner login surface (D5, D6, D8, D16, D37): the handlers behind
 * `/api/auth/*` and the gate of the `/setup` and `/login` pages.
 *
 * DARK unless `AURA_OWNER_LOGIN=on`: every route but `status` answers 404
 * before it reads a body or touches a service. The session cookie grants no
 * authority in Phase 1, because `authenticate()` and `viewerFor` never read it.
 *
 * Nothing here needs AppManager. `getAuthServices()` builds its stores lazily.
 */
import { randomBytes } from 'node:crypto';
// Namespace import: the running shell may cache a core build without these.
import * as core from '@aura/core';
import type { LoginSession, LoginSessions, SetupTickets, UserAccount, UserStore } from '@aura/core';

export const LOGIN_FLAG = 'AURA_OWNER_LOGIN';
export const COOKIE_HTTPS = '__Host-aura_session';
export const COOKIE_HTTP = 'aura_session';
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const STAY_SIGNED_IN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_BODY_BYTES = 8 * 1024;
export const PASSWORD_MIN_CHARS = 12;
export const PASSWORD_MAX_BYTES = 512;

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const MAX_CODE_CHARS = 128;

type Env = Record<string, string | undefined>;
type Scheme = 'https' | 'http';
type Body = Record<string, unknown>;

export interface AuthAudit {
  record(entry: {
    by: { kind: 'anonymous' } | { kind: 'system' };
    action: string;
    target?: string;
    outcome?: 'ok' | 'denied' | 'failed';
  }): Promise<unknown>;
}

export interface AuthSurfaceServices {
  users: UserStore;
  loginSessions: LoginSessions;
  setupTickets: SetupTickets;
  audit?: AuthAudit;
}

export interface AuthSurfaceDeps {
  env: Env;
  /** Null until stream A's accessors exist on `getAuthServices()`. */
  services: () => AuthSurfaceServices | null;
}

/** The part of Astro's APIContext these handlers read. */
export interface AuthContext {
  request: Request;
  /** Astro's getter can throw, so it is only read through `peerAddress`. */
  readonly clientAddress?: string;
}

/** The one place that binds the surface to core. */
export function coreAuthServices(): AuthSurfaceServices | null {
  const svc = core.getAuthServices?.() as unknown as Partial<AuthSurfaceServices> | undefined;
  if (!svc?.users || !svc.loginSessions || !svc.setupTickets) return null;
  return { users: svc.users, loginSessions: svc.loginSessions, setupTickets: svc.setupTickets, audit: svc.audit };
}

const defaultDeps = (): AuthSurfaceDeps => ({ env: process.env, services: coreAuthServices });

export const loginEnabled = (env: Env = process.env): boolean => env[LOGIN_FLAG] === 'on';

// ── responses ───────────────────────────────────────────────────────────────

const API_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...API_HEADERS, 'Content-Type': 'application/json; charset=utf-8', ...extra },
  });
}

const notFound = () => new Response(null, { status: 404, headers: API_HEADERS });
const unavailable = () => json({ error: 'unavailable' }, 503);
/** One answer for an unknown user, a wrong password and a disabled account. */
const badCredentials = () => json({ error: 'invalid-credentials' }, 401);
/** One answer for a wrong, used or expired code and for a finished setup. */
const setupRejected = () => json({ error: 'setup-rejected' }, 403);

// ── transport ───────────────────────────────────────────────────────────────

const normalizeAddress = (addr: string): string => addr.trim().toLowerCase().replace(/^::ffff:/, '');

function peerAddress(ctx: AuthContext): string | null {
  try { return ctx.clientAddress ? normalizeAddress(ctx.clientAddress) : null; }
  catch { return null; }
}

/**
 * An empty list trusts nobody, unlike `isTrusted` in server/app-hosts.mjs.
 * Astro's `clientAddress` is the socket peer only while `security.allowedDomains`
 * is unset: with it set, Astro takes `X-Forwarded-For`. A test pins the config.
 */
function trustedProxies(env: Env): Set<string> {
  return new Set((env['AURA_TRUSTED_PROXIES'] ?? '').split(',').map(normalizeAddress).filter(Boolean));
}

/** HTTPS only on the word of a configured proxy. Its own value is the last one. */
export function requestScheme(ctx: AuthContext, env: Env): Scheme {
  const peer = peerAddress(ctx);
  if (!peer || !trustedProxies(env).has(peer)) return 'http';
  const proto = (ctx.request.headers.get('x-forwarded-proto') ?? '').split(',').at(-1)?.trim().toLowerCase();
  return proto === 'https' ? 'https' : 'http';
}

/** Built from Host: `request.url` is `localhost` without `allowedDomains`. */
function expectedOrigin(request: Request, scheme: Scheme): string | null {
  const host = request.headers.get('host');
  if (!host || !/^[a-z0-9.\-[\]:]+$/i.test(host)) return null;
  try { return new URL(`${scheme}://${host}`).origin; }
  catch { return null; }
}

function sameOrigin(request: Request, scheme: Scheme): boolean {
  const site = request.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin') return false;
  const origin = request.headers.get('origin');
  const expected = expectedOrigin(request, scheme);
  return origin !== null && expected !== null && origin === expected;
}

// ── cookie ──────────────────────────────────────────────────────────────────

const cookieName = (scheme: Scheme) => (scheme === 'https' ? COOKIE_HTTPS : COOKIE_HTTP);

function setCookie(scheme: Scheme, value: string, maxAgeSeconds: number): string {
  const secure = scheme === 'https' ? '; Secure' : '';
  return `${cookieName(scheme)}=${value}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly${secure}; SameSite=Lax`;
}

const clearCookie = (scheme: Scheme) => setCookie(scheme, '', 0);

/** Two cookies of one name mean one was planted, so neither is used. */
function readSessionCookie(request: Request, scheme: Scheme): string | null {
  const name = cookieName(scheme);
  const values = (request.headers.get('cookie') ?? '').split(';').flatMap((part) => {
    const eq = part.indexOf('=');
    return eq > 0 && part.slice(0, eq).trim() === name ? [part.slice(eq + 1).trim()] : [];
  });
  return values.length === 1 && values[0] ? values[0] : null;
}

// ── body ────────────────────────────────────────────────────────────────────

async function readBody(request: Request): Promise<Body | Response> {
  if (!/^application\/json\s*(;|$)/i.test(request.headers.get('content-type') ?? '')) {
    return json({ error: 'json-required' }, 415);
  }
  const tooLarge = () => json({ error: 'body-too-large' }, 413);
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return tooLarge();

  const chunks: Uint8Array[] = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return tooLarge();
      }
      chunks.push(value);
    }
  }
  if (size === 0) return {};
  try {
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Body;
  } catch { /* answered below */ }
  return json({ error: 'invalid-request' }, 400);
}

// ── input rules ─────────────────────────────────────────────────────────────

const normalizeUsername = (name: string) => name.trim().toLowerCase();

const passwordInBounds = (password: string) => Buffer.byteLength(password) <= PASSWORD_MAX_BYTES;
const passwordAcceptable = (password: string) =>
  [...password].length >= PASSWORD_MIN_CHARS && passwordInBounds(password);
const codeAcceptable = (code: unknown): code is string =>
  typeof code === 'string' && code.length > 0 && code.length <= MAX_CODE_CHARS;

// ── handler plumbing ────────────────────────────────────────────────────────

async function guarded(deps: AuthSurfaceDeps, run: (svc: AuthSurfaceServices) => Promise<Response>): Promise<Response> {
  try {
    const svc = deps.services();
    return svc ? await run(svc) : unavailable();
  } catch (err) {
    // The name only: a message could carry request data.
    console.warn(`[auth] route failed: ${(err as Error)?.name ?? 'error'}`);
    return unavailable();
  }
}

function read(
  ctx: AuthContext,
  deps: AuthSurfaceDeps,
  run: (svc: AuthSurfaceServices, scheme: Scheme) => Promise<Response>,
): Promise<Response> {
  if (!loginEnabled(deps.env)) return Promise.resolve(notFound());
  const scheme = requestScheme(ctx, deps.env);
  return guarded(deps, (svc) => run(svc, scheme));
}

async function mutate(
  ctx: AuthContext,
  deps: AuthSurfaceDeps,
  run: (svc: AuthSurfaceServices, body: Body, scheme: Scheme) => Promise<Response>,
): Promise<Response> {
  if (!loginEnabled(deps.env)) return notFound();
  const scheme = requestScheme(ctx, deps.env);
  if (!sameOrigin(ctx.request, scheme)) return json({ error: 'forbidden-origin' }, 403);
  let body: Body | Response;
  try { body = await readBody(ctx.request); }
  catch { return json({ error: 'invalid-request' }, 400); }
  if (body instanceof Response) return body;
  const parsed = body;
  return guarded(deps, (svc) => run(svc, parsed, scheme));
}

async function audit(svc: AuthSurfaceServices, action: string, target?: string): Promise<void> {
  try { await svc.audit?.record({ by: { kind: 'anonymous' }, action, target, outcome: 'ok' }); }
  catch { /* the audit trail must not fail the request */ }
}

/**
 * Closes the race of a login that checked the old password just before a
 * reset: it issues its session after `revokeByUser` ran, so it looks here
 * and revokes that session itself.
 */
const credentialEpochs = new WeakMap<UserStore, number>();
const credentialEpoch = (users: UserStore) => credentialEpochs.get(users) ?? 0;

/** A live password session of the current, enabled owner. */
async function currentSession(
  ctx: AuthContext,
  svc: AuthSurfaceServices,
  scheme: Scheme,
): Promise<{ session: LoginSession; user: UserAccount } | null> {
  const token = readSessionCookie(ctx.request, scheme);
  if (!token) return null;
  const session = await svc.loginSessions.verify(token);
  if (!session || session.method !== 'password' || !session.userId) return null;
  const user = await svc.users.getOwner();
  if (!user || user.disabled || user.id !== session.userId) return null;
  return { session, user };
}

// ── routes ──────────────────────────────────────────────────────────────────

export async function authStatus(_ctx: AuthContext, deps: AuthSurfaceDeps = defaultDeps()): Promise<Response> {
  if (!loginEnabled(deps.env)) return json({ login: 'disabled' });
  try {
    const svc = deps.services();
    if (!svc) return json({ login: 'unavailable' });
    return json({ login: 'enabled', setup: (await svc.users.hasOwner()) ? 'complete' : 'required' });
  } catch {
    return json({ login: 'unavailable' });
  }
}

export function authSetup(ctx: AuthContext, deps: AuthSurfaceDeps = defaultDeps()): Promise<Response> {
  return mutate(ctx, deps, (svc, body, scheme) => {
    if (body['purpose'] === 'reset') return resetPassword(svc, body, scheme);
    if (body['purpose'] !== undefined && body['purpose'] !== 'setup') return Promise.resolve(json({ error: 'invalid-request' }, 400));
    return createOwner(svc, body);
  });
}

async function createOwner(svc: AuthSurfaceServices, body: Body): Promise<Response> {
  const { code, username: rawName, password } = body;
  if (!codeAcceptable(code) || typeof rawName !== 'string' || typeof password !== 'string') {
    return json({ error: 'invalid-request' }, 400);
  }
  const username = normalizeUsername(rawName);
  if (!USERNAME_RE.test(username)) return json({ error: 'invalid-username' }, 400);
  if (!passwordAcceptable(password) || password.toLowerCase() === username) return json({ error: 'invalid-password' }, 400);

  // Before the claim, so a finished setup never burns a code.
  if (await svc.users.hasOwner()) return setupRejected();
  if (!(await svc.setupTickets.claim(code, 'setup'))) return setupRejected();
  const owner = await svc.users.createOwner({ username, password });
  if (!owner) return setupRejected();
  await audit(svc, 'owner.setup', owner.id);
  return json({ ok: true });
}

async function resetPassword(svc: AuthSurfaceServices, body: Body, scheme: Scheme): Promise<Response> {
  const { code, password } = body;
  if (!codeAcceptable(code) || typeof password !== 'string') return json({ error: 'invalid-request' }, 400);
  if (!passwordAcceptable(password)) return json({ error: 'invalid-password' }, 400);

  const ticket = await svc.setupTickets.claim(code, 'reset');
  if (!ticket?.username) return setupRejected();
  const owner = await svc.users.getOwner();
  if (!owner || normalizeUsername(ticket.username) !== owner.username) return setupRejected();
  if (!(await svc.users.setPassword(owner.id, password))) return setupRejected();

  credentialEpochs.set(svc.users, credentialEpoch(svc.users) + 1);
  await svc.loginSessions.revokeByUser(owner.id);
  await audit(svc, 'owner.password-reset', owner.id);
  return json({ ok: true }, 200, { 'Set-Cookie': clearCookie(scheme) });
}

export function authLogin(ctx: AuthContext, deps: AuthSurfaceDeps = defaultDeps()): Promise<Response> {
  return mutate(ctx, deps, async (svc, body, scheme) => {
    const { username: rawName, password, staySignedIn } = body;
    if (typeof rawName !== 'string' || typeof password !== 'string') return badCredentials();
    const username = normalizeUsername(rawName);
    if (!USERNAME_RE.test(username) || !password || !passwordInBounds(password)) return badCredentials();

    const epoch = credentialEpoch(svc.users);
    const check = await svc.users.verifyPassword(username, password);
    if (!check.ok) return check.reason === 'rate-limited' ? json({ error: 'rate-limited' }, 429) : badCredentials();
    if (check.user.disabled || check.user.role !== 'owner') return badCredentials();

    const ttlMs = staySignedIn === true ? STAY_SIGNED_IN_TTL_MS : SESSION_TTL_MS;
    const { token, session } = await svc.loginSessions.issue({ method: 'password', userId: check.user.id, ttlMs });
    if (credentialEpoch(svc.users) !== epoch) {
      await svc.loginSessions.revoke(session.sessionId);
      return badCredentials();
    }

    // A new login replaces the browser's previous session.
    const prior = readSessionCookie(ctx.request, scheme);
    if (prior) {
      try {
        const old = await svc.loginSessions.verify(prior);
        if (old && old.sessionId !== session.sessionId) await svc.loginSessions.revoke(old.sessionId);
      } catch { /* the old session expires on its own */ }
    }
    await audit(svc, 'owner.login', check.user.id);
    return json({ ok: true, expiresAt: session.expiresAt }, 200, {
      'Set-Cookie': setCookie(scheme, token, Math.floor(ttlMs / 1000)),
    });
  });
}

export function authLogout(ctx: AuthContext, deps: AuthSurfaceDeps = defaultDeps()): Promise<Response> {
  return mutate(ctx, deps, async (svc, _body, scheme) => {
    const token = readSessionCookie(ctx.request, scheme);
    const session = token ? await svc.loginSessions.verify(token) : null;
    if (session) {
      await svc.loginSessions.revoke(session.sessionId);
      await audit(svc, 'owner.logout', session.userId);
    }
    return json({ ok: true }, 200, { 'Set-Cookie': clearCookie(scheme) });
  });
}

export function authSession(ctx: AuthContext, deps: AuthSurfaceDeps = defaultDeps()): Promise<Response> {
  return read(ctx, deps, async (svc, scheme) => {
    const current = await currentSession(ctx, svc, scheme);
    return json(current ? { authenticated: true, expiresAt: current.session.expiresAt } : { authenticated: false });
  });
}

export function authWhoami(ctx: AuthContext, deps: AuthSurfaceDeps = defaultDeps()): Promise<Response> {
  return read(ctx, deps, async (svc, scheme) => {
    const current = await currentSession(ctx, svc, scheme);
    if (!current) return json({ authenticated: false });
    const { id, username, role } = current.user;
    return json({ authenticated: true, principal: { kind: 'user', id, username, role } });
  });
}

// ── pages ───────────────────────────────────────────────────────────────────

export type AuthPageGate =
  | { enabled: false; response: Response }
  | { enabled: true; nonce: string; headers: Record<string, string> };

/**
 * `form-action 'none'`: the forms submit through fetch, so a page whose script
 * failed can't post a password anywhere.
 */
export function authPageGate(env: Env = process.env): AuthPageGate {
  if (!loginEnabled(env)) return { enabled: false, response: notFound() };
  const nonce = randomBytes(16).toString('base64');
  return {
    enabled: true,
    nonce,
    headers: {
      ...API_HEADERS,
      'Content-Security-Policy': [
        `default-src 'none'`,
        `script-src 'nonce-${nonce}'`,
        `style-src 'self' 'nonce-${nonce}'`,
        `connect-src 'self'`,
        `img-src 'self'`,
        `base-uri 'none'`,
        `form-action 'none'`,
        `frame-ancestors 'none'`,
      ].join('; '),
      'X-Frame-Options': 'DENY',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
    },
  };
}
