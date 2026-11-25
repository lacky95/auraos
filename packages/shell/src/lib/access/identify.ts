import type {
  AdminPrincipal, AppInstance, AppManager, InstancePrincipal, Principal, UserPrincipal,
} from '@aura/core';
import { loadAppHostServices, type AppHostServices } from '../../../server/app-host-auth.mjs';
import { gatewayClaimOf, ownerUiActs, ownerUiApp } from '../../../server/gateway-identity.mjs';
import { refererProxyId } from './legacyReferer.ts';
import type { AccessVia, VerifiedIdentity } from './types.ts';

/**
 * Resolve the calling INSTANCE for a write to the Interface Registry.
 *
 * The existing `identifySource` helpers (kv, data-provider routes) resolve a
 * caller to an *appId*, which is not enough here: a registration belongs to one
 * running instance and dies with it, so an app id that maps to three instances
 * would be ambiguous about which one just opened a port.
 *
 * Two sources, in order:
 *
 *   1. `Referer` — a browser-context caller inside an app iframe, whose URL is
 *      always `/api/proxy/<instanceId>/…`. Same mechanism the KV and
 *      data-provider routes already trust.
 *   2. `X-Aura-Instance-Id` — a server-context caller (the app's own Astro
 *      route or a lifecycle hook), which has no Referer at all. The app reads
 *      the value from the `APP_INSTANCE_ID` the OS injected at spawn. This is
 *      the case that matters most in practice, because an MCP or WS server
 *      lives in the app's server code, not its page.
 *
 * Deliberately **no `'system'` fallback**. The KV route treats a missing
 * Referer as privileged; for writes that would let any unattributed caller
 * register interfaces, so an unidentifiable caller is simply refused.
 *
 * On the trust model, stated plainly because it is easy to overclaim:
 * **both sources are self-asserted.** Anything that can reach the shell API
 * can set a Referer or an X-Aura-Instance-Id and register under another app's
 * identity. That is not a hole this route opens — it is the OS's existing
 * app-identity model (`/api/kv` and `/api/data` trust the same Referer, and
 * the KV route additionally treats a *missing* Referer as privileged
 * `'system'`). Apps here are assumed cooperating, not adversarial.
 *
 * What this route does add is containment: the claimed instance must exist in
 * the live table, writes are refused outright when no instance can be named,
 * and every entry dies with its instance — at the next stop, or at the next
 * reconcile tick. So the blast radius of a forged registration is one
 * advertised address until that app next stops, never a persistent lie.
 *
 * Real instance identity now exists: every instance gets a per-instance
 * token at spawn (`AURA_INSTANCE_TOKEN`, core's InstanceTokens), and the
 * OS-sidecar routes require it (lib/instanceAuth.ts `requireInstanceToken`).
 * A valid token, like a gateway claim, names the instance before either
 * hint is read; the SDK's server side sends it. Requiring it here, and moving
 * /api/kv and /api/data onto it, is the remaining step: every caller (apps
 * outside the SDK too) has to send it first.
 */
export function identifyInstance(request: Request, mgr: AppManager): AppInstance | null {
  const gateway = gatewayInstance(request, mgr);
  if (gateway !== null) return gateway === 'invalid' ? null : gateway;

  // An instance token proves the caller, so it wins over the hints below. The
  // SDK sends it from an app's server instead of a self-set id header.
  const token = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get('authorization') ?? '')?.[1];
  const verified = token ? mgr.tokens.verify(token) : null;
  if (verified) return mgr.getInstance(verified.instanceId) ?? null;

  const idOrAppId = refererProxyId(request.headers.get('referer'));
  if (idOrAppId) {
    const inst = mgr.getInstance(idOrAppId)
      // A bare appId in the proxy path: pick the app's one real instance.
      // Pool members are excluded — the proxy won't route to them either.
      ?? mgr.getInstancesByApp(idOrAppId).find((i) => !i.inPool && i.port !== null);
    if (inst) return inst;
  }

  const claimed = request.headers.get('x-aura-instance-id');
  if (claimed) return mgr.getInstance(claimed) ?? null;

  return null;
}

/**
 * The instance a signed App Host gateway claim names (server/app-gateway.mjs).
 * Null when the request has no claim, `invalid` when it has one that doesn't
 * verify or whose instance is no longer that app. The only caller identity
 * here that is proved rather than asserted, and it never falls back.
 */
export function gatewayInstance(
  request: Request,
  mgr: Pick<AppManager, 'getInstance'>,
): AppInstance | 'invalid' | null {
  const claim = gatewayClaimOf(request);
  if (claim === null) return null;
  if (!claim || !claim.instanceId) return 'invalid';
  const inst = mgr.getInstance(claim.instanceId);
  return inst && inst.appId === claim.appId ? inst : 'invalid';
}

/** What `gatewayOwner` reads. Structural, so tests can fake it. */
export interface GatewayOwnerDeps {
  mgr: Pick<AppManager, 'getInstance' | 'getManifest'>;
  services?: () => Promise<Pick<AppHostServices, 'registry' | 'sessionLive'> | null>;
}

const owners = new WeakMap<Request, Promise<UserPrincipal | null>>();

/**
 * D45: the owner acting through a trusted system UI, or null. The gateway
 * signs an `owner` claim only for such a UI; this checks it again against the
 * live state, so a claim minted a moment before any of it changed buys nothing:
 *
 *   - a verified claim for a live instance of that app (gatewayInstance)
 *   - its installed copy is the `system` one, and the one scope decision
 *     (gateway-identity.mjs `ownerUiActs`) holds for the path called: an
 *     OWNER_UI_APPS entry that covers it, the claim's installation is that
 *     active `system` installation, and the owner's session is live
 *
 * The route manifest check (gatewayCaller.ts) and `authenticate()` (auth.ts)
 * both ask this, so no caller can skip the path scope.
 * The principal is the user, carrying the app it acts through. Cached per request.
 */
export function gatewayOwner(request: Request, deps: GatewayOwnerDeps): Promise<UserPrincipal | null> {
  let found = owners.get(request);
  if (!found) {
    found = resolveGatewayOwner(request, deps).catch(() => null);
    owners.set(request, found);
  }
  return found;
}

async function resolveGatewayOwner(request: Request, deps: GatewayOwnerDeps): Promise<UserPrincipal | null> {
  const claim = gatewayClaimOf(request);
  if (!claim || !claim.owner || claim.owner.userId !== claim.userId) return null;
  const inst = gatewayInstance(request, deps.mgr);
  if (!inst || inst === 'invalid' || !ownerUiApp(inst.appId)) return null;
  const installed = deps.mgr.getManifest(inst.appId) as { scopeId?: string } | undefined;
  if (installed?.scopeId !== 'system') return null;
  const svc = await (deps.services ?? loadAppHostServices)();
  if (!svc) return null;
  const path = new URL(request.url).pathname;
  const ref = { appId: inst.appId, installationId: claim.installationId, sid: claim.owner.sid, userId: claim.owner.userId, path };
  if (!(await ownerUiActs(ref, svc))) return null;
  return {
    kind: 'user', userId: claim.owner.userId, role: 'owner', sessionId: claim.owner.sid,
    verification: 'verified', through: { appId: inst.appId, instanceId: inst.instanceId },
  };
}

// ── the one principal resolver ──────────────────────────────────────────────

/**
 * Why a presented credential did not verify. `authenticate()` answers each
 * with its own 401; the access report counts it as `foreign-or-invalid`.
 */
export type CredentialRejection =
  | 'gateway-identity-invalid'
  | 'gateway-admin-session-invalid'
  | 'api-key-invalid'
  | 'admin-session-invalid'
  | 'unsupported-scheme'
  | 'credential-invalid'
  | 'instance-not-running';

export interface ResolvedPrincipal extends VerifiedIdentity {
  principal: Principal;
  /** Set when a credential was presented and did not verify. The principal is then anonymous. */
  rejected?: { reason: CredentialRejection; instanceId?: string };
}

/** The live objects the resolver reads. A missing one makes what needs it `unverified`. */
export interface PrincipalDeps {
  mgr: (Pick<AppManager, 'getInstance' | 'getManifest'> & {
    tokens: Pick<AppManager['tokens'], 'verify'> & Partial<Pick<AppManager['tokens'], 'hasNonce'>>;
  }) | null;
  apiKeys: { verify(key: string): Promise<{ id: string; name: string; scopes: string[] } | null> } | null;
  admin: { verifySession(token: string): Promise<{ sessionId: string } | null> } | null;
  /**
   * The login token a request carries in its session cookie, and the live
   * password session of the enabled owner it names (authSurface
   * `sessionCookieToken` / `ownerSessionOf`, the checks the desktop's
   * sign-in uses). Null: login is unavailable here.
   */
  login: {
    cookieToken(request: Request): string | null;
    ownerSession(token: string): Promise<{ sessionId: string; userId: string } | null>;
  } | null;
  /** App Host services for the D45 owner check; loaded when absent. */
  ownerServices?: GatewayOwnerDeps['services'];
}

/**
 * An App Host cookie session, verified where the cookie is read
 * (server/app-hosts.mjs `appSession`: signature, audience, installation and
 * a live owner session). Never the cookie itself.
 */
export interface AppHostSession {
  appId: string;
  instanceId?: string;
  userId: string;
  sid: string;
}

const API_KEY_PREFIX = 'aura_k1_';
const ADMIN_SESSION_PREFIX = 'aura-admin1.';
const LOGIN_SESSION_PREFIX = 'aura-sess1.';
const INSTANCE_TOKEN_PREFIX = 'aura1.';

const ANONYMOUS = Object.freeze({ kind: 'anonymous', verification: 'unverified' }) as Principal;

const seen = (principal: Principal, via: AccessVia): ResolvedPrincipal => ({ principal, via });
const rejected = (reason: CredentialRejection, instanceId?: string): ResolvedPrincipal => ({
  principal: ANONYMOUS, via: 'foreign-or-invalid', rejected: { reason, ...(instanceId ? { instanceId } : {}) },
});
const unverified = (): ResolvedPrincipal => seen(ANONYMOUS, 'unverified');

/** The bearer token; '' for an Authorization header of another shape, null without one. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (header === null || header.trim() === '') return null;
  return /^Bearer\s+(\S+)\s*$/i.exec(header)?.[1] ?? '';
}

function userPrincipal(userId: string, sessionId: string, through?: UserPrincipal['through']): UserPrincipal {
  return { kind: 'user', userId, role: 'owner', sessionId, verification: 'verified', ...(through ? { through } : {}) };
}

/**
 * An instance token's claims. An unknown nonce is refused before the MAC, so
 * a stray token can't create the key file.
 */
function instanceTokenClaims(token: string, tokens: NonNullable<PrincipalDeps['mgr']>['tokens']) {
  if (tokens.hasNonce) {
    let p: { i?: unknown; s?: unknown };
    try { p = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf-8')) as typeof p; } catch { return null; }
    if (typeof p.i !== 'string' || (p.s !== undefined && typeof p.s !== 'string')) return null;
    if (!tokens.hasNonce(p.i, p.s as string | undefined)) return null;
  }
  return tokens.verify(token);
}

function instancePrincipal(
  inst: Pick<AppInstance, 'appId' | 'instanceId'> & { owner?: string },
  extra: { sidecar?: string; userId?: string },
): InstancePrincipal {
  return {
    kind: 'instance', appId: inst.appId, instanceId: inst.instanceId,
    ...(extra.sidecar ? { sidecar: extra.sidecar } : {}),
    ...(extra.userId ? { userId: extra.userId } : {}),
    verification: 'verified',
  };
}

async function resolveGateway(
  request: Request, token: string | null, deps: PrincipalDeps,
): Promise<ResolvedPrincipal> {
  const mgr = deps.mgr;
  if (!mgr) return unverified();
  const inst = gatewayInstance(request, mgr);
  if (!inst || inst === 'invalid') return rejected('gateway-identity-invalid');
  const owner = await gatewayOwner(request, { mgr, services: deps.ownerServices });
  // D45: Settings with an admin session from the shell's own unlock dialog.
  // The owner check runs first, so a bearer on any other gateway call is ignored.
  if (owner && token?.startsWith(ADMIN_SESSION_PREFIX)) {
    if (!deps.admin) return unverified();
    const s = await deps.admin.verifySession(token);
    if (!s) return rejected('gateway-admin-session-invalid');
    const admin: AdminPrincipal = { kind: 'admin', credential: 'shared', sessionId: s.sessionId, verification: 'verified' };
    return seen(admin, 'admin-session');
  }
  if (owner) return seen(owner, 'gateway');
  // The app acts for the user whose App Host session the gateway checked (a
  // claim with `sid`); a claim without one (the runtime script) names nobody.
  const claim = gatewayClaimOf(request);
  const userId = claim && claim.sid && typeof claim.userId === 'string' ? claim.userId : undefined;
  return seen(instancePrincipal(inst, userId ? { userId } : {}), 'gateway');
}

async function resolveBearer(token: string, deps: PrincipalDeps): Promise<ResolvedPrincipal> {
  if (token === '') return rejected('unsupported-scheme');
  if (token.startsWith(API_KEY_PREFIX)) {
    if (!deps.apiKeys) return unverified();
    const rec = await deps.apiKeys.verify(token);
    if (!rec) return rejected('api-key-invalid');
    return seen({ kind: 'apiKey', keyId: rec.id, name: rec.name, scopes: [...rec.scopes], verification: 'verified' }, 'api-key');
  }
  if (token.startsWith(ADMIN_SESSION_PREFIX)) {
    if (!deps.admin) return unverified();
    const s = await deps.admin.verifySession(token);
    if (!s) return rejected('admin-session-invalid');
    return seen({ kind: 'admin', credential: 'shared', sessionId: s.sessionId, verification: 'verified' }, 'admin-session');
  }
  if (token.startsWith(LOGIN_SESSION_PREFIX)) {
    if (!deps.login) return unverified();
    const s = await deps.login.ownerSession(token);
    return s ? seen(userPrincipal(s.userId, s.sessionId), 'login-session') : rejected('credential-invalid');
  }
  if (!token.startsWith(INSTANCE_TOKEN_PREFIX)) return rejected('credential-invalid');
  if (!deps.mgr) return unverified();
  const claims = instanceTokenClaims(token, deps.mgr.tokens);
  if (!claims) return rejected('credential-invalid');
  const inst = deps.mgr.getInstance(claims.instanceId) as (AppInstance & { owner?: string }) | undefined;
  if (!inst) return rejected('instance-not-running', claims.instanceId);
  // The `u` claim, else the instance's server-side owner (a token minted
  // before the claim, or when a pool member was claimed).
  return seen(instancePrincipal(inst, { sidecar: claims.sidecar, userId: claims.userId ?? inst.owner }), 'instance-token');
}

/**
 * THE principal resolver (D36): `authenticate()` and the access observer both
 * ask it, for Astro routes and for the plain servers' surfaces alike.
 *
 *   App Host cookie session (verified by app-hosts.mjs) → user, through that app
 *   signed gateway claim     → user through a trusted system UI (D45); admin with
 *                              that UI's admin session bearer; else the instance,
 *                              acting for the claim's session user
 *   Bearer aura1.…           → instance, acting for its `u` claim or owner
 *   Bearer aura_k1_…         → apiKey
 *   Bearer aura-admin1.…     → admin
 *   Bearer aura-sess1.…      → user (a live password session of the enabled owner)
 *   any other Authorization  → rejected
 *   login cookie             → user; expired, revoked or unreadable → anonymous
 *   nothing                  → anonymous
 *
 * A bearer always wins over the cookie. Hints are not identity and stay out.
 * The result is the verified principal only, never a credential.
 */
export async function resolvePrincipal(
  request: Request, deps: PrincipalDeps, opts: { appHost?: AppHostSession | null } = {},
): Promise<ResolvedPrincipal> {
  if (opts.appHost) {
    const { appId, instanceId, userId, sid } = opts.appHost;
    return seen(userPrincipal(userId, sid, { appId, ...(instanceId ? { instanceId } : {}) }), 'app-host');
  }
  const token = bearerToken(request);
  if (gatewayClaimOf(request) !== null) return resolveGateway(request, token, deps);
  if (token !== null) return resolveBearer(token, deps);

  const cookie = deps.login?.cookieToken(request) ?? null;
  if (cookie === null) return seen(ANONYMOUS, 'none');
  // A cookie is not a presented credential: an expired, revoked or
  // unreadable session is anonymous, never a 401 or an error.
  try {
    const s = await deps.login!.ownerSession(cookie);
    return s ? seen(userPrincipal(s.userId, s.sessionId), 'login-session') : seen(ANONYMOUS, 'foreign-or-invalid');
  } catch {
    return unverified();
  }
}
