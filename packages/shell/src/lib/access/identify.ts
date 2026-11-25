import type {
  AccessPrincipal, AppInstance, AppManager, InstancePrincipal, OperatorPrincipal, Principal, UserPrincipal,
} from '@aura/core';
// The file-only entry, as the CLI uses it: one subject rule on both sides.
import { operatorRequestSubject } from '@aura/core/setup-tickets';
import { localSystemId } from '@aura/core/system-identity';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { loadAppHostServices, type AppHostServices } from '../../../server/app-host-auth.mjs';
import { gatewayClaimOf, ownerSsrClaimOf, ownerUiActs, ownerUiApp } from '../../../server/gateway-identity.mjs';
import type { AccessTarget, AccessVia, VerifiedIdentity } from './types.ts';

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

/** One owner check per request: the middleware and the route both ask. */
function cachedOwner(request: Request, resolve: () => Promise<UserPrincipal | null>): Promise<UserPrincipal | null> {
  let found = owners.get(request);
  if (!found) {
    found = resolve().catch(() => null);
    owners.set(request, found);
  }
  return found;
}

/**
 * Targets the owner never reaches through an app, whatever the rule says: its
 * login session and handoff, a shell screen's client session, and another
 * app's upstream (which includes the Terminal, D23, D29). The gateway
 * (gatewayCaller.ts) and the access gate (enforce.ts) both apply it.
 */
export const OWNER_UI_EXCLUDED_TARGETS: ReadonlySet<AccessTarget> = new Set(['session', 'client-session', 'proxy-upstream']);

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
  return cachedOwner(request, async () => {
    const claim = gatewayClaimOf(request);
    if (!claim || !claim.owner || claim.owner.userId !== claim.userId) return null;
    const inst = gatewayInstance(request, deps.mgr);
    if (!inst || inst === 'invalid') return null;
    return ownerThrough(request, inst, { installationId: claim.installationId, ...claim.owner }, deps);
  });
}

/**
 * D45 for a trusted system UI's own server: the owner SSR claim the router
 * handed its page request (app-hosts.mjs `ownerSsrHeader`), sent back on a
 * GET or HEAD next to the instance token of the very instance it names.
 * `inst` is the running instance that token verified as; then the same
 * checks as `gatewayOwner`.
 * Anything else ignores the claim. Cached per request.
 */
function ssrOwner(
  request: Request, inst: Pick<AppInstance, 'appId' | 'instanceId'>, deps: GatewayOwnerDeps,
): Promise<UserPrincipal | null> {
  return cachedOwner(request, async () => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return null;
    const claim = ownerSsrClaimOf(request);
    if (!claim || claim.instanceId !== inst.instanceId || claim.appId !== inst.appId) return null;
    return ownerThrough(request, inst, { installationId: claim.installationId, ...claim.owner }, deps);
  });
}

/** The owner through `inst`, if its `system` copy acts for that live owner session on this path (D45). */
async function ownerThrough(
  request: Request, inst: Pick<AppInstance, 'appId' | 'instanceId'>,
  ref: { installationId: string; userId: string; sid: string }, deps: GatewayOwnerDeps,
): Promise<UserPrincipal | null> {
  if (!ownerUiApp(inst.appId)) return null;
  const installed = deps.mgr.getManifest(inst.appId) as { scopeId?: string } | undefined;
  if (installed?.scopeId !== 'system') return null;
  const svc = await (deps.services ?? loadAppHostServices)();
  if (!svc) return null;
  const path = new URL(request.url).pathname;
  if (!(await ownerUiActs({ appId: inst.appId, path, ...ref }, svc))) return null;
  return {
    kind: 'user', userId: ref.userId, role: 'owner', sessionId: ref.sid,
    verification: 'verified', ...systemOf(), through: { appId: inst.appId, instanceId: inst.instanceId },
  };
}

// ── the one principal resolver ──────────────────────────────────────────────

/**
 * Why a presented credential did not verify. `authenticate()` answers each
 * with its own 401; the access report counts it as `foreign-or-invalid`.
 */
export type CredentialRejection =
  | 'gateway-identity-invalid'
  | 'api-key-invalid'
  | 'unsupported-scheme'
  | 'credential-invalid'
  | 'instance-not-running'
  | 'operator-ticket-invalid';

/** Who a request can authenticate as: a core principal, or the host operator (`X-Aura-Operator`). */
export type CallerPrincipal = Principal | OperatorPrincipal;

export interface ResolvedPrincipal extends VerifiedIdentity {
  principal: CallerPrincipal;
  /** Set when a credential was presented and did not verify. The principal is then anonymous. */
  rejected?: { reason: CredentialRejection; instanceId?: string };
}

/** The live objects the resolver reads. A missing one makes what needs it `unverified`. */
export interface PrincipalDeps {
  mgr: (Pick<AppManager, 'getInstance' | 'getManifest'> & {
    tokens: Pick<AppManager['tokens'], 'verify'> & Partial<Pick<AppManager['tokens'], 'hasNonce'>>;
  }) | null;
  apiKeys: { verify(key: string): Promise<{ id: string; name: string; scopes: string[] } | null> } | null;
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
  /**
   * The host operator's one-time tickets (core `FileSetupTickets`, purpose
   * `operator`): `claim` uses one up, `peek` (the report) only looks. Absent:
   * an operator header is `unverified`.
   */
  operatorTickets?: {
    claim?(code: string, purpose: 'operator'): Promise<{ subject?: string } | null>;
    peek?(code: string, purpose: 'operator'): Promise<{ subject?: string } | null>;
  } | null;
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
const LOGIN_SESSION_PREFIX = 'aura-sess1.';
const INSTANCE_TOKEN_PREFIX = 'aura1.';

const ANONYMOUS = Object.freeze({ kind: 'anonymous', verification: 'unverified' }) as Principal;

const seen = (principal: CallerPrincipal, via: AccessVia): ResolvedPrincipal => ({ principal, via });
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

/**
 * The Aura a verified principal belongs to (D47): always this one in the
 * alpha, read rather than assumed. Left out if the identity is unreadable.
 */
export function systemOf(): { systemId?: string } {
  try { return { systemId: localSystemId() }; } catch { return {}; }
}

function userPrincipal(userId: string, sessionId: string, through?: UserPrincipal['through']): UserPrincipal {
  return { kind: 'user', userId, role: 'owner', sessionId, verification: 'verified', ...systemOf(), ...(through ? { through } : {}) };
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
    ...systemOf(),
  };
}

async function resolveGateway(request: Request, deps: PrincipalDeps): Promise<ResolvedPrincipal> {
  const mgr = deps.mgr;
  if (!mgr) return unverified();
  const inst = gatewayInstance(request, mgr);
  if (!inst || inst === 'invalid') return rejected('gateway-identity-invalid');
  const owner = await gatewayOwner(request, { mgr, services: deps.ownerServices });
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

/** The header the host CLI sends its one-time operator code in (aura-cli `resolveIdentity`). */
export const OPERATOR_HEADER = 'x-aura-operator';
const OPERATOR: OperatorPrincipal = Object.freeze({ kind: 'operator', verification: 'verified' });
const operatorClaims = new WeakMap<Request, Promise<ResolvedPrincipal>>();

/**
 * The host operator (plan 5.8: `aura` through `docker exec` into the master):
 * a one-time ticket only a process that can write the master's secrets
 * directory can create, bound to this request's method and path. The claim
 * uses it up, so it is made once per request and shared by the gate, the
 * report and the route. The report only peeks, unless the claim was made.
 */
function resolveOperator(request: Request, code: string, deps: PrincipalDeps): Promise<ResolvedPrincipal> {
  const claimed = operatorClaims.get(request);
  if (claimed) return claimed;
  const tickets = deps.operatorTickets;
  const subject = operatorRequestSubject(request.method, new URL(request.url).pathname);
  const check = async (find: ((code: string, purpose: 'operator') => Promise<{ subject?: string } | null>) | undefined) => {
    if (!find) return unverified();
    const ticket = await find.call(tickets, code, 'operator');
    return ticket?.subject === subject ? seen(OPERATOR, 'operator-ticket') : rejected('operator-ticket-invalid');
  };
  if (!tickets?.claim) return check(tickets?.peek);
  const result = check(tickets.claim).catch(() => unverified());
  operatorClaims.set(request, result);
  return result;
}

/**
 * THE principal resolver (D36): `authenticate()` and the access observer both
 * ask it, for Astro routes and for the plain servers' surfaces alike.
 *
 *   App Host cookie session (verified by app-hosts.mjs) → user, through that app
 *   signed gateway claim     → user through a trusted system UI (D45); else the
 *                              instance, acting for the claim's session user
 *   Bearer aura1.…           → instance, acting for its `u` claim or owner;
 *     + owner SSR claim        user through that trusted system UI (D45, `ssrOwner`)
 *   Bearer aura_k1_…         → apiKey
 *   Bearer aura-sess1.…      → user (a live password session of the enabled owner)
 *   any other Authorization  → rejected
 *   X-Aura-Operator: <code>  → operator (the host CLI's one-time ticket for this request)
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
  if (gatewayClaimOf(request) !== null) return resolveGateway(request, deps);
  if (token !== null) {
    const r = await resolveBearer(token, deps);
    // A trusted system UI's server reading for the owner (D45, `ssrOwner`): never a sidecar's token.
    if (r.principal.kind !== 'instance' || r.principal.sidecar || !deps.mgr) return r;
    const owner = await ssrOwner(request, r.principal, { mgr: deps.mgr, services: deps.ownerServices });
    return owner ? seen(owner, r.via) : r;
  }
  const operatorCode = request.headers.get(OPERATOR_HEADER);
  if (operatorCode !== null) return resolveOperator(request, operatorCode, deps);

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

// ── what a verified principal speaks for ────────────────────────────────────

/**
 * The app instance a caller is, when it is one: an instance (by token or
 * gateway claim), or a user acting through an app instance (D45, App Hosts),
 * judged as that instance. Null for the owner's own login, the operator, API keys
 * and anonymous callers. The routes that name their caller app (KV, data,
 * interfaces) and the `app-callers` guard ask this; it never reads a hint.
 */
export function actingInstance(p: AccessPrincipal): InstancePrincipal | null {
  if (p.kind === 'instance') return p;
  if (p.kind === 'user' && p.through?.instanceId) {
    return { kind: 'instance', appId: p.through.appId, instanceId: p.through.instanceId, verification: 'verified' };
  }
  return null;
}

/**
 * The apps whose `system` copy acts for the owner (D29):
 *   com.aura.terminal    the System Terminal, a trusted terminal: the owner's
 *                        shell, `aura` CLI and coding agents
 *   com.aura.aurashelld  the owner's shell-control MCP, which those agents
 *                        drive (it reached the OS as `system` without a token
 *                        before Phase 3). Phase 5 scopes who may call it.
 */
export const OWNER_AGENT_APPS: ReadonlySet<string> = new Set(['com.aura.terminal', 'com.aura.aurashelld']);

/**
 * D29: the owner and trusted terminals have full control. A trusted owner
 * agent is an instance of the installed `system` copy of an OWNER_AGENT_APPS
 * app, calling with its own instance token (never one of its sidecars). A
 * gateway call is judged as the app's page, by its instance rules only
 * (gatewayCaller.ts never asks this).
 */
export function isTrustedOwnerAgent(
  p: InstancePrincipal, mgr: Pick<AppManager, 'getManifest'> | null,
): boolean {
  if (!OWNER_AGENT_APPS.has(p.appId) || p.sidecar) return false;
  const installed = mgr?.getManifest(p.appId) as { scopeId?: string } | undefined;
  return installed?.scopeId === 'system';
}

// ── D28: tokenless callers by their container network address ───────────────

/** What `networkInstance` reads. Structural, so tests can fake it. */
export interface NetworkDeps {
  instances(): ReadonlyArray<Pick<AppInstance, 'appId' | 'instanceId'> & { sandbox?: string; state?: string; inPool?: boolean }>;
  /** Every address a container name resolves to (Docker's DNS on the app network). */
  resolve(name: string): Promise<string[]>;
  now?(): number;
}

const NETWORK_TTL_MS = 10_000;
/** A miss rebuilds the table at most this often, so unknown peers can't drive lookups. */
const NETWORK_RETRY_MS = 2_000;
const LIVE_STATES = new Set(['resumed', 'started', 'paused', 'starting']);

export const normalizePeer = (addr: string | null | undefined): string | null => {
  const a = String(addr ?? '').trim().toLowerCase().replace(/^::ffff:/, '');
  return isIP(a) ? a : null;
};

/**
 * D28: the running container instance whose address on the app network is
 * `peer`, by its container name (`aura-<instanceId>`, the name the shell
 * dials it by). Docker's DNS answers for the network, and a TCP peer address
 * on it can't be taken over without the reply, so this names the container
 * that opened the connection. Loopback and anything else that is no
 * instance's address stay null: a PRoot app or the shell itself is never
 * named this way, nor is the address a published port's traffic comes from.
 */
export function createNetworkIdentity(deps: NetworkDeps) {
  const now = () => (deps.now ?? Date.now)();
  let table: Map<string, { appId: string; instanceId: string }> = new Map();
  let builtAt = -Infinity;
  let building: Promise<void> | null = null;

  async function rebuild(): Promise<void> {
    const next = new Map<string, { appId: string; instanceId: string }>();
    const live = deps.instances().filter((i) => i.sandbox === 'container' && !i.inPool && (!i.state || LIVE_STATES.has(i.state)));
    await Promise.all(live.map(async (i) => {
      try {
        for (const addr of await deps.resolve(`aura-${i.instanceId}`)) {
          const a = normalizePeer(addr);
          if (a) next.set(a, { appId: i.appId, instanceId: i.instanceId });
        }
      } catch { /* not resolvable: not on the network */ }
    }));
    table = next;
    builtAt = now();
  }

  const refresh = (): Promise<void> => (building ??= rebuild().finally(() => { building = null; }));

  return async function networkInstance(peer: string | null | undefined): Promise<InstancePrincipal | null> {
    const a = normalizePeer(peer);
    if (!a || a.startsWith('127.') || a === '::1') return null;
    const age = now() - builtAt;
    if (age > NETWORK_TTL_MS || (!table.has(a) && age > NETWORK_RETRY_MS)) await refresh();
    const hit = table.get(a);
    return hit ? { kind: 'instance', appId: hit.appId, instanceId: hit.instanceId, verification: 'verified' } : null;
  };
}

/** The live table over an AppManager (read when it is up), resolved through the container's DNS. */
export function liveNetworkIdentity(mgr: () => Pick<AppManager, 'getAllInstances'> | null) {
  return createNetworkIdentity({
    instances: () => {
      try { return mgr()?.getAllInstances() ?? []; } catch { return []; }
    },
    resolve: async (name) => (await dnsLookup(name, { all: true })).map((r) => r.address),
  });
}
