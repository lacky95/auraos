import * as core from '@aura/core';
import type { AccessPrincipal, InstancePrincipal, Principal } from '@aura/core';
import { OWNER_AGENT_APPS, OWNER_AGENT_EXCLUDED_TARGETS, SESSION_HOST_APPS, isOwnerPrincipal } from './identify.ts';
import type {
  AccessReason, AccessRule, Decide, DecideInput, DecideResult, PolicyResource, PolicyTransport,
} from './types.ts';

/**
 * The central access decision (5.11), over a manifest rule. The middleware
 * (enforce.ts), the gateway (gatewayCaller.ts), the surface gate and the
 * report (observer.ts) all ask it. Permission checks go through core's
 * `Authorizer`, so its answers and its auto-grants stay the single source;
 * `strict` (`enforce`) stops an auto-grant from counting.
 *
 * `owner` is satisfied by the host operator (its one-time ticket), the
 * owner's login (a verified `user`, identify.ts `resolvePrincipal`), and a
 * trusted owner agent (D29): the System Terminal
 * or the owner's shell MCP by its own token, never on the owner's login
 * session or a shell screen.
 *
 * D85 A1: before any of that, a principal whose `systemId` is set and is not
 * this system's is refused (`foreign-system`); its role is never read. A
 * member (I.2) satisfies no `owner` level; it holds only its own `user`
 * grants (core `Authorizer`), on a rule's `permissions` or, where the rule
 * names them, its `memberPermissions` (D82: `app.use` / `app.jump` of the
 * target app, on the member's own instances only).
 *
 * D89 B6: an address is never a principal. A call through `/api/proxy` is
 * decided on its credential like any other (the `proxy-upstream` rules),
 * and an owner agent's upstream (OWNER_AGENT_APPS) takes the `owner` level
 * only, never `app-permission`.
 *
 * D69 (stream T): a System Terminal instance is ONE user's session host.
 * Whoever reaches its upstream (its PTY, MCP, session API: `proxy-upstream`)
 * must act for that user (`actingUser`, the user an instance acts for,
 * the operator for the owner), whatever level let them in: the owner's login
 * never reaches a member's sessions, and an unclaimed pool member nobody's.
 * A user's own session host (another of their Terminal instances: the
 * session router, MCP across instances) reaches theirs (`own-session`).
 */

export interface DecideDeps {
  authorizer: { authorize(principal: Principal, action: string): Promise<{ allow: boolean; reason: string }> };
  /** D29: whether this instance acts for the owner (identify.ts `isTrustedOwnerAgent`). Never asked at the gateway. */
  ownerAgent?(principal: InstancePrincipal): boolean;
  /** D63: the owner's switch (`freshAuthRequiresHttps`). Absent: its default, off. */
  freshAuthRequiresHttps?(): Promise<boolean>;
  /**
   * The user an instance belongs to (its `owner`); null for an unclaimed pool
   * member or an unknown instance. Absent: session hosts are refused to
   * everyone (D69) and a member reaches no named instance (I.2): fail closed.
   */
  instanceOwner?(instanceId: string): string | null;
  /** I.2: the app's current installation id, for `app.use:<installationId>`. Absent or null: not held. */
  installationOf?(appId: string): Promise<string | null>;
}

/**
 * The user a principal acts for (D46, D69): a user, the user an instance acts
 * for (its token's `u` or its owner, identify.ts), and the owner for the host
 * operator and an API key (both the owner's, host-issued, in the alpha).
 * Null for anyone else: never a guess.
 */
export function actingUser(p: AccessPrincipal | { kind: 'operator' }): string | null {
  const q = p as AccessPrincipal & { userId?: unknown };
  if (q.kind === 'operator' || q.kind === 'apiKey') return core.DEFAULT_OWNER_ID;
  if ((q.kind === 'user' || q.kind === 'instance') && typeof q.userId === 'string' && q.userId) return q.userId;
  return null;
}

/**
 * D69: whether `principal` may reach this session host target. Only for a
 * `proxy-upstream` target of a SESSION_HOST_APPS app; any other is not a
 * session host and passes. A named instance must belong to the user the
 * caller acts for; a bare app id (the route then picks the caller's own
 * instance) needs a caller that acts for a user at all.
 */
export function sessionHostReachable(
  principal: AccessPrincipal, rule: AccessRule, resource: PolicyResource, deps: Pick<DecideDeps, 'instanceOwner'>,
): boolean {
  if (rule.target !== 'proxy-upstream' || !resource.appId || !SESSION_HOST_APPS.has(resource.appId)) return true;
  const user = actingUser(principal);
  if (!user) return false;
  if (!resource.instanceId) return true;
  const owner = deps.instanceOwner?.(resource.instanceId) ?? null;
  return owner !== null && owner === user;
}

/** A session host of the same user calling another of that user's (stream T: the session router, MCP). */
function ownSessionHost(p: AccessPrincipal, resource: PolicyResource): boolean {
  return p.kind === 'instance' && !p.sidecar && SESSION_HOST_APPS.has(p.appId) && !!resource.appId && SESSION_HOST_APPS.has(resource.appId)
    && typeof p.userId === 'string' && !!p.userId;
}

// ── fresh authentication and transport (D18, D63) ───────────────────────────

/**
 * How the owner gives a `fresh` confirmation: `password` in the shell's own
 * dialog, or `operator` (`aura approve <id>` on the host, which works in
 * every mode). The one place transport decides it: the access decision
 * below, the approve route and the dialog's view all ask this.
 *
 * D63 (owner, 2026-11-26): over plain HTTP the dialog takes the password by
 * default; the security option `fresh-auth-require-https` makes HTTP the
 * host operator's again (D18). HTTPS counts only as `requestScheme` /
 * `edgeView` decide it: `X-Forwarded-Proto` only from a trusted proxy.
 */
export type FreshAuthPath = 'password' | 'operator';

export const freshAuthPath = (transport: PolicyTransport, requireHttps: boolean): FreshAuthPath =>
  transport === 'https' || !requireHttps ? 'password' : 'operator';

/**
 * The switch, from the security options registry (D64). A tampered record
 * reads as the default (off; core reports it). No store, or a read that
 * fails, keeps HTTP to the host operator.
 */
export async function freshAuthRequiresHttps(
  store: { get(): Promise<core.SecurityPolicy> } | null = core.getAuthServices().securityPolicy,
): Promise<boolean> {
  try {
    if (!store) return true;
    return core.securityPolicyValue(await store.get(), core.FRESH_AUTH_REQUIRE_HTTPS) === true;
  } catch {
    return true;
  }
}

const allow = (reason: AccessReason): DecideResult => ({ outcome: 'allow', reason });
const deny = (reason: AccessReason): DecideResult => ({ outcome: 'deny', reason });

/** The one owner test (identify.ts `isOwnerPrincipal`, A1 included). */
const isOwner = (p: AccessPrincipal): boolean => isOwnerPrincipal(p);

/** I.2: a local user whose record role is not `owner` (A1 already refused a foreign one). */
const isMember = (p: AccessPrincipal): p is Extract<AccessPrincipal, { kind: 'user' }> =>
  p.kind === 'user' && p.role !== 'owner';

const INSTALLATION_PLACEHOLDER = '<installationId>';

/**
 * A member's `memberPermissions` on this resource (I.2, D82): the target
 * instance, when named, is the member's own, and every listed grant is held,
 * `<installationId>` filled from the target app. Null when allowed, else why not.
 */
async function memberHolds(
  deps: DecideDeps, p: Extract<AccessPrincipal, { kind: 'user' }>, permissions: readonly string[], resource: PolicyResource,
): Promise<AccessReason | null> {
  if (resource.instanceId !== undefined) {
    const owner = deps.instanceOwner?.(resource.instanceId) ?? null;
    if (owner === null || owner !== p.userId) return 'wrong-target';
  }
  const concrete: string[] = [];
  for (const permission of permissions) {
    if (!permission.includes(INSTALLATION_PLACEHOLDER)) { concrete.push(permission); continue; }
    const installationId = resource.appId ? await deps.installationOf?.(resource.appId) ?? null : null;
    if (!installationId) return 'missing-permission';
    concrete.push(permission.replace(INSTALLATION_PLACEHOLDER, installationId));
  }
  return (await checkPermissions(deps, p as Principal, concrete, true)).ok ? null : 'missing-permission';
}

/** Core's wording is the only signal of an MVP auto-grant; a test pins it. */
const isAutoGrant = (reason: string): boolean => reason.includes('MVP auto-grant');

function ownsTarget(p: Extract<AccessPrincipal, { kind: 'instance' }>, r: PolicyResource): boolean {
  switch (r.target) {
    case 'instance':
    case 'sidecar':
    case 'activity':
      return r.instanceId === p.instanceId;
    case 'instance-pair':
      return r.instanceId === p.instanceId && (r.peerInstanceId === undefined || r.peerInstanceId === p.instanceId);
    case 'app':
      return r.appId === p.appId;
    default:
      return true;
  }
}

/**
 * Whether each permission is held; `auto` when any was only auto-granted. In
 * `strict` an auto-grant is not held: the permission has to be declared.
 */
async function checkPermissions(
  deps: DecideDeps, principal: Principal, permissions: readonly string[], strict = false,
): Promise<{ ok: boolean; auto: boolean }> {
  let auto = false;
  for (const permission of permissions) {
    if (permission.includes('<')) return { ok: false, auto };
    const d = await deps.authorizer.authorize(principal, permission);
    if (!d.allow) return { ok: false, auto };
    if (isAutoGrant(d.reason)) {
      if (strict) return { ok: false, auto: true };
      auto = true;
    }
  }
  return { ok: true, auto };
}

/**
 * Whether `principal` holds `permission`, as a rule's `permissions` check
 * decides it (`osClient.permissions.has`, D48). In `strict` an auto-grant
 * is not held.
 */
export async function permissionHeld(
  deps: DecideDeps, principal: Principal, permission: string, strict = false,
): Promise<boolean> {
  try { return (await checkPermissions(deps, principal, [permission], strict)).ok; } catch { return false; }
}

/** The whole `targetPermissions` check of a rule, held by the TARGET app. */
export async function targetPermissionsHeld(
  deps: DecideDeps, rule: AccessRule, resource: PolicyResource, strict = false,
): Promise<DecideResult> {
  if (!rule.targetPermissions?.length) return allow('public');
  if (!resource.appId) return deny('wrong-target');
  const target: Principal = {
    kind: 'instance',
    appId: resource.appId,
    instanceId: resource.instanceId ?? resource.appId,
    verification: 'verified',
  };
  const held = await checkPermissions(deps, target, rule.targetPermissions, strict);
  if (!held.ok) return deny('missing-target-permission');
  return allow(held.auto ? 'auto-granted' : 'public');
}

async function matchLevel(
  input: DecideInput, rule: AccessRule, deps: DecideDeps,
): Promise<{ granted: AccessReason | null; failure: AccessReason }> {
  const p = input.principal;
  let failure: AccessReason = p.kind === 'anonymous' ? 'unauthenticated' : 'wrong-principal';

  if (rule.allow.includes('owner')) {
    if (isOwner(p)) return { granted: 'owner', failure };
    if (p.kind === 'instance' && input.auth.via === 'instance-token'
      && !OWNER_AGENT_EXCLUDED_TARGETS.has(rule.target) && deps.ownerAgent?.(p)) {
      return { granted: 'owner', failure };
    }
  }

  if (rule.allow.includes('own-instance') && p.kind === 'instance') {
    if (ownsTarget(p, input.resource)) return { granted: 'own-instance', failure };
    failure = 'wrong-target';
  }

  // I.2 (D82): a member's own grants, on the rules that name them. Strict: an
  // auto-grant never counts for a member, and only `user` grants exist for one.
  if (rule.memberPermissions && isMember(p)) {
    const why = await memberHolds(deps, p, rule.memberPermissions, input.resource);
    if (why === null) return { granted: 'app-permission', failure };
    failure = why;
  }

  if (rule.allow.includes('app-permission')) {
    const permissions = rule.permissions ?? [];
    // A member holds its own `user` grants (I.2, C7); the owner matched above.
    const canHold = p.kind === 'instance' || p.kind === 'apiKey' || (p.kind === 'user' && p.role !== 'owner' && permissions.length > 0)
      || (p.kind === 'anonymous' && permissions.length > 0);
    if (canHold) {
      const held = await checkPermissions(deps, p as Principal, permissions, input.strict);
      if (held.ok) return { granted: held.auto ? 'auto-granted' : 'app-permission', failure };
      if (p.kind !== 'anonymous' && failure !== 'wrong-target') failure = 'missing-permission';
    }
  }
  return { granted: null, failure };
}

async function evaluate(input: DecideInput, deps: DecideDeps): Promise<DecideResult> {
  const { principal, resource, action: { rule } } = input;
  if (core.isSystemPrincipal(principal)) return allow('system');
  if (!rule) return deny('unclassified');
  if (rule.allow.length === 0) return deny('rule-denied');
  if (input.deployment === 'public' && input.transport === 'http' && rule.target === 'session') {
    return { outcome: 'needs-https', reason: 'https-required' };
  }
  if (rule.allow.includes('public')) return allow('public');

  // D85 A1: a remote owner is never a local owner. Absent systemId means local.
  if (core.isForeignPrincipal(principal as { systemId?: unknown })) return deny('foreign-system');

  const via = input.auth.via;
  const refusedAs: AccessReason = principal.kind === 'anonymous' ? 'unauthenticated' : 'wrong-principal';
  if (rule.credentials && !(via && rule.credentials.includes(via))) return deny(refusedAs);

  const matched = await matchLevel(input, rule, deps);
  let granted = matched.granted;
  // An owner agent's upstream (the Terminal's PTY, MCP and sessions, aurashelld's
  // MCP; H2, D89 B3/B6): the owner level only, or (D69) its user's own session host.
  if (rule.target === 'proxy-upstream' && resource.appId && OWNER_AGENT_APPS.has(resource.appId) && granted !== 'owner') {
    if (ownSessionHost(principal, resource)) granted = 'own-session';
    else return deny(granted ? 'wrong-target' : matched.failure);
  }
  if (!granted) return deny(matched.failure);
  if (!sessionHostReachable(principal, rule, resource, deps)) return deny('not-session-owner');

  let reason: AccessReason = granted;
  const target = await targetPermissionsHeld(deps, rule, resource, input.strict);
  if (target.outcome !== 'allow') return target;
  if (target.reason === 'auto-granted') reason = 'auto-granted';

  if (rule.freshAuth && !input.auth.fresh) {
    const requireHttps = input.transport === 'http' && (await deps.freshAuthRequiresHttps?.() ?? false);
    return freshAuthPath(input.transport, requireHttps) === 'password'
      ? { outcome: 'needs-fresh-auth', reason: 'fresh-auth-required' }
      : { outcome: 'needs-operator', reason: 'operator-required' };
  }
  return allow(reason);
}

export function createDecide(deps: DecideDeps): Decide {
  return async (input) => {
    try {
      return await evaluate(input, deps);
    } catch {
      return deny('policy-error');
    }
  };
}

/** The live decision, on the shell's `Authorizer`. */
export const decide: Decide = (input) => createDecide({
  authorizer: core.getAuthServices().authorizer,
  freshAuthRequiresHttps: () => freshAuthRequiresHttps(),
  instanceOwner: (id) => liveInstanceOwner(id),
  installationOf: (appId) => liveInstallationOf(appId),
})(input);

/** The live owner of an instance: null for an unknown one or an unclaimed pool member. */
export function liveInstanceOwner(instanceId: string): string | null {
  try {
    const inst = core.getAppManager().getInstance(instanceId) as { owner?: string; inPool?: boolean } | undefined;
    return inst && !inst.inPool && typeof inst.owner === 'string' ? inst.owner : null;
  } catch {
    return null;
  }
}

/** The live installation id of an app (App Host registry); null when it can't be read. */
export async function liveInstallationOf(appId: string): Promise<string | null> {
  try { return await core.getAppManager().installationIdOf(appId); } catch { return null; }
}
