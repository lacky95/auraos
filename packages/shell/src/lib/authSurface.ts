/**
 * The owner login surface (D5, D6, D8, D16, D37): the handlers behind
 * `/api/auth/*`, the headers of the `/setup` and `/login` pages, and the
 * desktop's sign-in gate. Login is always on (D6): until the owner exists the
 * desktop sends everyone to `/setup`, after that to `/login`.
 *
 * `whoami` reports the caller's principal (`authenticate()`, which reads the
 * login cookie through `sessionCookieToken` / `ownerSessionOf`) and labels
 * the login cookie. A login session opens the desktop and its App Hosts (the
 * handoff).
 *
 * Nothing here needs AppManager. `getAuthServices()` builds its stores lazily.
 */
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
// Namespace import: the running shell may cache a core build without these.
import * as core from '@aura/core';
import type {
  LoginSession, LoginSessions, PasswordRule, SetupTickets, UserAccount, UserPrincipal, UserStore, ValkeyUserStore,
} from '@aura/core';
import { GATEWAY_IDENTITY_HEADER } from '@aura/core/host-rules';
import { authenticate } from './auth.js';
import type { CallerPrincipal } from './access/identify.js';
import { isTrustedProxy } from '../../server/host-policy.mjs';

export const COOKIE_HTTPS = '__Host-aura_session';
export const COOKIE_HTTP = 'aura_session';
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const STAY_SIGNED_IN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_BODY_BYTES = 8 * 1024;

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const MAX_CODE_CHARS = 128;

type Env = Record<string, string | undefined>;
type Scheme = 'https' | 'http';
type Body = Record<string, unknown>;

type AuditActor =
  | { kind: 'anonymous' } | { kind: 'system' } | { kind: 'operator' }
  | { kind: 'user'; userId: string; session?: string };

/** D38: a desktop notice for each use of a host code. Carries no secret. */
export type AuthNotice = 'setup' | 'reset' | 'reset-sessions-kept';

const RESET_HINT = 'If this was not you, reset the password from the host: docker exec -it aura-shell aura user reset-password <username>';
const NOTICES: Record<AuthNotice, { title: string; text: string }> = {
  setup: { title: 'AuraOS owner account created', text: `A one-time host code was used to create the owner account. ${RESET_HINT}` },
  reset: { title: 'AuraOS owner password reset', text: `A one-time host code was used to reset the password, and all login sessions were signed out. ${RESET_HINT}` },
  'reset-sessions-kept': { title: 'AuraOS owner password reset, sessions not revoked', text: `The password was reset, but existing login sessions could not be revoked. Run the reset again. ${RESET_HINT}` },
};

export interface AuthAudit {
  record(entry: {
    by: AuditActor;
    action: string;
    target?: string;
    outcome?: 'ok' | 'denied' | 'failed';
  }): Promise<unknown>;
}

export interface AuthSurfaceServices {
  users: UserStore
    & Pick<ValkeyUserStore, 'recoverOwnerPassword' | 'credentialEpoch'
      | 'getPasswordPolicy' | 'checkNewPassword' | 'changeOwnerPassword' | 'setPasswordPolicy'>
    & Partial<Pick<ValkeyUserStore, 'identityKeyStatus'>>;
  loginSessions: LoginSessions;
  setupTickets: SetupTickets;
  audit?: AuthAudit;
  notify?: (notice: AuthNotice) => Promise<unknown>;
}

export interface AuthSurfaceDeps {
  env: Env;
  /** Null until stream A's accessors exist on `getAuthServices()`. */
  services: () => AuthSurfaceServices | null;
  /** The shell's bearer authentication. Replaced in tests. */
  authenticate?: (request: Request) => Promise<CallerPrincipal | Response>;
  /** D45: the owner acting through a trusted system UI (identify.ts). Replaced in tests. */
  gatewayOwner?: (request: Request) => Promise<UserPrincipal | null>;
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
  if (!svc?.users?.recoverOwnerPassword || !svc.users.credentialEpoch || !svc.loginSessions || !svc.setupTickets) return null;
  return {
    users: svc.users, loginSessions: svc.loginSessions, setupTickets: svc.setupTickets, audit: svc.audit,
    notify: (notice) => core.getNotificationService().create(
      { type: 'simple', ...NOTICES[notice] } as Parameters<ReturnType<typeof core.getNotificationService>['create']>[0],
      core.SYSTEM_CALLER,
    ),
  };
}

/** Loaded on first use, so the login pages never pull in AppManager. */
async function liveGatewayOwner(request: Request): Promise<UserPrincipal | null> {
  const { gatewayOwner } = await import('./access/identify.js');
  return gatewayOwner(request, { mgr: core.getAppManager() });
}

const defaultDeps = (): AuthSurfaceDeps => ({ env: process.env, services: coreAuthServices, gatewayOwner: liveGatewayOwner });

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

// Astro's `clientAddress` is the socket peer only while `security.allowedDomains`
// is unset: with it set, Astro takes `X-Forwarded-For`. A test pins the config.

/** HTTPS only on the word of a configured proxy. Its own value is the last one. */
export function requestScheme(ctx: AuthContext, env: Env): Scheme {
  const peer = peerAddress(ctx);
  if (!peer || !isTrustedProxy(peer, env)) return 'http';
  const proto = (ctx.request.headers.get('x-forwarded-proto') ?? '').split(',').at(-1)?.trim().toLowerCase();
  return proto === 'https' ? 'https' : 'http';
}

/**
 * The client for the login rate limit. Forwarded addresses count only from a
 * configured proxy: the nearest hop that is not itself one of those proxies.
 */
export function clientRateKey(ctx: AuthContext, env: Env): string | undefined {
  const peer = peerAddress(ctx);
  if (!peer) return undefined;
  if (!isTrustedProxy(peer, env)) return `ip:${peer}`;
  const hops = (ctx.request.headers.get('x-forwarded-for') ?? '').split(',').map(normalizeAddress);
  for (let i = hops.length - 1; i >= 0; i -= 1) {
    const hop = hops[i]!;
    if (!hop || isTrustedProxy(hop, env)) continue;
    return isIP(hop) ? `ip:${hop}` : `ip:${peer}`;
  }
  return `ip:${peer}`;
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

/** The login token in a request's session cookie, under either name, for the shell's principal resolver. */
export const sessionCookieToken = (request: Request): string | null =>
  readSessionCookie(request, 'https') ?? readSessionCookie(request, 'http');

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
  const scheme = requestScheme(ctx, deps.env);
  return guarded(deps, (svc) => run(svc, scheme));
}

async function mutate(
  ctx: AuthContext,
  deps: AuthSurfaceDeps,
  run: (svc: AuthSurfaceServices, body: Body, scheme: Scheme) => Promise<Response>,
): Promise<Response> {
  const scheme = requestScheme(ctx, deps.env);
  if (!sameOrigin(ctx.request, scheme)) return json({ error: 'forbidden-origin' }, 403);
  let body: Body | Response;
  try { body = await readBody(ctx.request); }
  catch { return json({ error: 'invalid-request' }, 400); }
  if (body instanceof Response) return body;
  const parsed = body;
  return guarded(deps, (svc) => run(svc, parsed, scheme));
}

/**
 * A password typed into the shell's own document only (Settings → Users &
 * Identities): a request through an App Host gateway never reaches it. The
 * route manifest refuses it there too (target `session`).
 */
function shellOnly(
  ctx: AuthContext,
  deps: AuthSurfaceDeps,
  run: (svc: AuthSurfaceServices, body: Body, scheme: Scheme) => Promise<Response>,
): Promise<Response> {
  if (ctx.request.headers.has(GATEWAY_IDENTITY_HEADER)) return Promise.resolve(json({ error: 'forbidden' }, 403));
  return mutate(ctx, deps, run);
}

/** Answers for a new password that breaks the policy. */
const passwordRefused = (rule: PasswordRule | undefined) => json({ error: 'invalid-password', ...(rule ? { rule } : {}) }, 400);

/** A policy failure from core as a 400; anything else rethrown. */
function policyError(err: unknown): Response {
  if (err instanceof core.UserStoreError) {
    if (err.code === 'invalid-password') return passwordRefused(err.rule);
    if (err.code === 'invalid-policy') return json({ error: 'invalid-policy' }, 400);
  }
  throw err;
}

async function audit(
  svc: AuthSurfaceServices,
  action: 'setup' | 'login' | 'logout' | 'sessionsRevoked',
  by: () => AuditActor,
  target?: string,
): Promise<void> {
  try { await svc.audit?.record({ by: by(), action: core.IDENTITY_AUDIT_ACTIONS[action], target, outcome: 'ok' }); }
  catch { /* the audit trail must not fail the request */ }
}

/** Never awaited: a stalled notification store must not hold a finished request. */
function raiseNotice(svc: AuthSurfaceServices, notice: AuthNotice): void {
  void Promise.resolve().then(() => svc.notify?.(notice)).catch(() => undefined);
}

/** Checked before a claim, so an unusable identity.key never burns a code. */
const identityKeyUsable = (svc: AuthSurfaceServices) => svc.users.identityKeyStatus?.() !== 'malformed';

/**
 * The live password session of the current, enabled owner that `token` names.
 * The one check behind the desktop's sign-in and the shell's principal
 * resolver (lib/access/identify.ts).
 */
export async function ownerSessionOf(
  token: string,
  svc: { loginSessions: Pick<LoginSessions, 'verify'>; users: Pick<UserStore, 'getOwner'> },
): Promise<{ session: LoginSession; user: UserAccount } | null> {
  const session = await svc.loginSessions.verify(token);
  if (!session || session.method !== 'password' || !session.userId) return null;
  const user = await svc.users.getOwner();
  if (!user || user.disabled || user.id !== session.userId) return null;
  return { session, user };
}

/** A live password session of the current, enabled owner. */
async function currentSession(
  ctx: AuthContext,
  svc: AuthSurfaceServices,
  scheme: Scheme,
): Promise<{ session: LoginSession; user: UserAccount } | null> {
  const token = readSessionCookie(ctx.request, scheme);
  return token ? ownerSessionOf(token, svc) : null;
}

/** The verified owner session of this request, for the App Host handoff. */
export async function currentOwnerSession(
  ctx: AuthContext,
  deps: AuthSurfaceDeps = defaultDeps(),
): Promise<{ sessionId: string; userId: string; expiresAt: number } | null> {
  const svc = deps.services();
  if (!svc) return null;
  const current = await currentSession(ctx, svc, requestScheme(ctx, deps.env));
  return current ? { sessionId: current.session.sessionId, userId: current.user.id, expiresAt: current.session.expiresAt } : null;
}

/**
 * The owner behind a Users & Identities read or session action: the shell's
 * login cookie, or the owner acting through Settings (D45), which the gateway
 * signs and `gatewayOwner` checks again. The session is the owner's login
 * session in either case.
 */
async function ownerCaller(
  ctx: AuthContext,
  deps: AuthSurfaceDeps,
  svc: AuthSurfaceServices,
  scheme: Scheme,
): Promise<{ userId: string; sessionId: string } | null> {
  if (ctx.request.headers.has(GATEWAY_IDENTITY_HEADER)) {
    const owner = await deps.gatewayOwner?.(ctx.request);
    if (!owner?.sessionId) return null;
    const user = await svc.users.getOwner();
    return user && !user.disabled && user.id === owner.userId ? { userId: user.id, sessionId: owner.sessionId } : null;
  }
  const current = await currentSession(ctx, svc, scheme);
  return current ? { userId: current.user.id, sessionId: current.session.sessionId } : null;
}

const loginRequired = () => json({ error: 'login-required' }, 401);

// ── routes ──────────────────────────────────────────────────────────────────

export async function authStatus(_ctx: AuthContext, deps: AuthSurfaceDeps = defaultDeps()): Promise<Response> {
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
  const rule = await svc.users.checkNewPassword(password, username);
  if (rule) return passwordRefused(rule);

  // Before the claim, so a finished setup never burns a code.
  if (await svc.users.hasOwner()) return setupRejected();
  if (!identityKeyUsable(svc)) return unavailable();
  if (!(await svc.setupTickets.claim(code, 'setup'))) return setupRejected();
  let owner: UserAccount | null;
  try { owner = await svc.users.createOwner({ username, password }); }
  catch (err) { return policyError(err); }
  if (!owner) return setupRejected();
  // The code came from the host, so the operator is the actor.
  await audit(svc, 'setup', () => core.operatorAttribution(), `user:${owner.id}`);
  raiseNotice(svc, 'setup');
  return json({ ok: true });
}

async function resetPassword(svc: AuthSurfaceServices, body: Body, scheme: Scheme): Promise<Response> {
  const { code, password } = body;
  if (!codeAcceptable(code) || typeof password !== 'string') return json({ error: 'invalid-request' }, 400);
  // The username rule waits for the ticket, which names the account.
  const rule = await svc.users.checkNewPassword(password);
  if (rule) return passwordRefused(rule);

  if (!identityKeyUsable(svc)) return unavailable();
  const ticket = await svc.setupTickets.claim(code, 'reset');
  if (!ticket) return setupRejected();
  // The store moves the credential epoch, revokes sessions and writes the one
  // audit event (`auth.owner-recovered`) with the final outcome.
  let result: Awaited<ReturnType<AuthSurfaceServices['users']['recoverOwnerPassword']>>;
  try { result = await svc.users.recoverOwnerPassword(ticket, password); }
  catch (err) { return policyError(err); }
  if (!result.ok) {
    return result.reason === 'identity-key-unavailable' || result.reason === 'conflict' ? unavailable() : setupRejected();
  }

  const revoked = result.sessionsRevoked !== null;
  raiseNotice(svc, revoked ? 'reset' : 'reset-sessions-kept');
  return json(revoked ? { ok: true } : { ok: true, sessionsRevoked: false }, 200, { 'Set-Cookie': clearCookie(scheme) });
}

export function authLogin(ctx: AuthContext, deps: AuthSurfaceDeps = defaultDeps()): Promise<Response> {
  return mutate(ctx, deps, async (svc, body, scheme) => {
    const { username: rawName, password, staySignedIn } = body;
    if (typeof rawName !== 'string' || typeof password !== 'string') return badCredentials();
    const username = normalizeUsername(rawName);
    if (!USERNAME_RE.test(username) || !password || !core.passwordWithinMax(password)) return badCredentials();

    const epoch = svc.users.credentialEpoch();
    const check = await svc.users.verifyPassword(username, password, { rateLimitKey: clientRateKey(ctx, deps.env) });
    if (!check.ok) return check.reason === 'rate-limited' ? json({ error: 'rate-limited' }, 429) : badCredentials();
    if (check.user.disabled || check.user.role !== 'owner') return badCredentials();

    const ttlMs = staySignedIn === true ? STAY_SIGNED_IN_TTL_MS : SESSION_TTL_MS;
    const { token, session } = await svc.loginSessions.issue({ method: 'password', userId: check.user.id, ttlMs });
    if (svc.users.credentialEpoch() !== epoch) {
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
    await audit(svc, 'login', () => core.userAttribution({ userId: check.user.id, sessionId: session.sessionId }), `user:${check.user.id}`);
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
      const { userId, sessionId } = session;
      await audit(svc, 'logout', () => (userId ? core.userAttribution({ userId, sessionId }) : { kind: 'anonymous' }), userId ? `user:${userId}` : undefined);
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

// ── Users & Identities (Settings) ───────────────────────────────────────────

/** The rules for new passwords. Public: the setup page shows them. */
export function authPasswordPolicy(ctx: AuthContext, deps: AuthSurfaceDeps = defaultDeps()): Promise<Response> {
  return read(ctx, deps, async (svc) => json({ policy: await svc.users.getPasswordPolicy() }));
}

/** A refused credential check, answered alike for both routes below. */
function credentialRefused(reason: 'invalid' | 'rate-limited' | 'conflict'): Response {
  if (reason === 'rate-limited') return json({ error: 'rate-limited' }, 429);
  if (reason === 'conflict') return json({ error: 'conflict' }, 409);
  return badCredentials();
}

/**
 * The signed-in owner changes their password from the shell's dialog. Keeps
 * this session and signs out the others; core audits it.
 */
export function authChangePassword(ctx: AuthContext, deps: AuthSurfaceDeps = defaultDeps()): Promise<Response> {
  return shellOnly(ctx, deps, async (svc, body, scheme) => {
    const current = await currentSession(ctx, svc, scheme);
    if (!current) return loginRequired();
    const { current: password, next } = body;
    if (typeof password !== 'string' || typeof next !== 'string') return json({ error: 'invalid-request' }, 400);
    let result: Awaited<ReturnType<AuthSurfaceServices['users']['changeOwnerPassword']>>;
    try {
      result = await svc.users.changeOwnerPassword(
        current.user.id, password, next, current.session.sessionId, { rateLimitKey: clientRateKey(ctx, deps.env) },
      );
    } catch (err) { return policyError(err); }
    return result.ok ? json({ ok: true }) : credentialRefused(result.reason);
  });
}

/** The owner sets the password policy, confirmed with the password in the shell's dialog. */
export function authSetPasswordPolicy(ctx: AuthContext, deps: AuthSurfaceDeps = defaultDeps()): Promise<Response> {
  return shellOnly(ctx, deps, async (svc, body, scheme) => {
    const current = await currentSession(ctx, svc, scheme);
    if (!current) return loginRequired();
    const { current: password, policy } = body;
    if (typeof password !== 'string') return json({ error: 'invalid-request' }, 400);
    let result: Awaited<ReturnType<AuthSurfaceServices['users']['setPasswordPolicy']>>;
    try {
      result = await svc.users.setPasswordPolicy(policy, {
        userId: current.user.id, current: password, sessionId: current.session.sessionId,
        rateLimitKey: clientRateKey(ctx, deps.env),
      });
    } catch (err) { return policyError(err); }
    return result.ok ? json({ ok: true, policy: result.policy }) : credentialRefused(result.reason);
  });
}

/** The owner's account and live sessions. Never a token or a full session id. */
export function authAccount(ctx: AuthContext, deps: AuthSurfaceDeps = defaultDeps()): Promise<Response> {
  return read(ctx, deps, async (svc, scheme) => {
    const caller = await ownerCaller(ctx, deps, svc, scheme);
    const user = caller && await svc.users.getOwner();
    if (!caller || !user) return loginRequired();
    const sessions = (await svc.loginSessions.listByUser(user.id))
      .map((s) => ({ id8: s.sessionId.slice(0, 8), method: s.method, createdAt: s.createdAt, current: s.sessionId === caller.sessionId }))
      .sort((a, b) => b.createdAt - a.createdAt);
    return json({ userId: user.id, username: user.username, role: user.role, createdAt: user.createdAt, sessions });
  });
}

/**
 * Signs out every other session of the owner. From the shell with the login
 * cookie (exact Origin), or from Settings through the gateway, which checked
 * Origin and the JSON type itself and forwards neither cookie nor Origin.
 */
export async function authRevokeOtherSessions(ctx: AuthContext, deps: AuthSurfaceDeps = defaultDeps()): Promise<Response> {
  const run = async (svc: AuthSurfaceServices, scheme: Scheme): Promise<Response> => {
    const caller = await ownerCaller(ctx, deps, svc, scheme);
    if (!caller) return loginRequired();
    const revoked = await svc.loginSessions.revokeByUser(caller.userId, { except: caller.sessionId });
    await audit(svc, 'sessionsRevoked', () => core.userAttribution(caller), `user:${caller.userId}`);
    return json({ ok: true, revoked });
  };
  if (ctx.request.headers.has(GATEWAY_IDENTITY_HEADER)) return read(ctx, deps, run);
  return mutate(ctx, deps, (svc, _body, scheme) => run(svc, scheme));
}

/** The verified class of the caller. Hints, session ids and scopes stay out. */
function publicPrincipal(p: CallerPrincipal): Record<string, string> {
  switch (p.kind) {
    case 'instance':
      return {
        kind: p.kind, verification: p.verification, appId: p.appId, instanceId: p.instanceId,
        ...(p.sidecar ? { sidecar: p.sidecar } : {}),
      };
    case 'apiKey':
      return { kind: p.kind, verification: p.verification, name: p.name };
    case 'admin':
    case 'operator':
      return { kind: p.kind, verification: p.verification };
    case 'user':
      return {
        kind: p.kind, verification: p.verification, role: p.role,
        ...(p.through ? { through: p.through.appId } : {}),
      };
    default:
      return { kind: 'anonymous', verification: 'unverified' };
  }
}

/** The login cookie as labelled information. */
async function observedLogin(ctx: AuthContext, deps: AuthSurfaceDeps): Promise<Record<string, unknown>> {
  const scheme = requestScheme(ctx, deps.env);
  try {
    const svc = deps.services();
    if (!svc) return { state: 'unavailable', authority: false };
    const current = await currentSession(ctx, svc, scheme);
    if (!current) return { state: 'signed-out', authority: false };
    const { id, username, role } = current.user;
    return { state: 'signed-in', authority: false, userId: id, username, role };
  } catch {
    return { state: 'unavailable', authority: false };
  }
}

/** The caller as routes see it; the login cookie, if any, is labelled under `login`. */
export async function authWhoami(ctx: AuthContext, deps: AuthSurfaceDeps = defaultDeps()): Promise<Response> {
  let principal: CallerPrincipal | Response;
  try { principal = await (deps.authenticate ?? authenticate)(ctx.request); }
  catch { return unavailable(); }
  if (principal instanceof Response) return json({ error: 'invalid-credential' }, 401);
  return json({ principal: publicPrincipal(principal), login: await observedLogin(ctx, deps) });
}

// ── pages ───────────────────────────────────────────────────────────────────

export interface AuthPageHeaders { nonce: string; headers: Record<string, string> }

/**
 * `form-action 'none'`: the forms submit through fetch, so a page whose script
 * failed can't post a password anywhere.
 */
export function authPageHeaders(): AuthPageHeaders {
  const nonce = randomBytes(16).toString('base64');
  return {
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

/**
 * D6: the desktop's own pages open only for the signed-in owner. Null lets the
 * page render; otherwise the redirect to `/setup` (no owner yet) or `/login`.
 * An unreadable store sends the browser to `/login`, which says so.
 */
export async function desktopSignIn(ctx: AuthContext, deps: AuthSurfaceDeps = defaultDeps()): Promise<Response | null> {
  const to = (path: string) => new Response(null, { status: 303, headers: { ...API_HEADERS, Location: path } });
  try {
    const svc = deps.services();
    if (!svc) return to('/login');
    if (!(await svc.users.hasOwner())) return to('/setup');
    return (await currentSession(ctx, svc, requestScheme(ctx, deps.env))) ? null : to('/login');
  } catch {
    return to('/login');
  }
}
