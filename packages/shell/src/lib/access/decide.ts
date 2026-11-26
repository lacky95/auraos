import * as core from '@aura/core';
import type { AccessPrincipal, InstancePrincipal, Principal } from '@aura/core';
import { OWNER_AGENT_APPS, OWNER_AGENT_EXCLUDED_TARGETS } from './identify.ts';
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
 * member (I.2) satisfies no `owner` level; on an `app-permission` rule it
 * holds only its own `user` grants (core `Authorizer`).
 */

export interface DecideDeps {
  authorizer: { authorize(principal: Principal, action: string): Promise<{ allow: boolean; reason: string }> };
  /** D29: whether this instance acts for the owner (identify.ts `isTrustedOwnerAgent`). Never asked at the gateway. */
  ownerAgent?(principal: InstancePrincipal): boolean;
  /** D63: the owner's switch (`freshAuthRequiresHttps`). Absent: its default, off. */
  freshAuthRequiresHttps?(): Promise<boolean>;
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

const isOwner = (p: AccessPrincipal): boolean =>
  p.kind === 'operator' || (p.kind === 'user' && p.role === 'owner');

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

  if (rule.allow.includes('app-permission')) {
    const permissions = rule.permissions ?? [];
    // A member holds its own `user` grants (I.2, C7); the owner matched above.
    const canHold = p.kind === 'instance' || p.kind === 'apiKey' || (p.kind === 'user' && p.role !== 'owner' && permissions.length > 0)
      || (p.kind === 'anonymous' && permissions.length > 0);
    if (canHold) {
      const held = await checkPermissions(deps, p as Principal, permissions, input.strict);
      if (held.ok) return { granted: held.auto ? 'auto-granted' : 'app-permission', failure };
      if (p.kind !== 'anonymous') failure = 'missing-permission';
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
  // D28: a network-identified caller is good for a `networkCaller` rule and nothing else,
  // and never for an owner agent's upstream (the Terminal's PTY, MCP and sessions,
  // aurashelld's MCP) unless it is the System Terminal itself (H2).
  if (via === 'network') {
    if (!rule.networkCaller) return deny('unauthenticated');
    if (rule.target === 'proxy-upstream' && resource.appId && OWNER_AGENT_APPS.has(resource.appId)
      && !(principal.kind === 'instance' && deps.ownerAgent?.(principal))) return deny('wrong-target');
    return allow('network-caller');
  }
  if (rule.credentials && !(via && rule.credentials.includes(via))) return deny(refusedAs);

  const { granted, failure } = await matchLevel(input, rule, deps);
  if (!granted) return deny(failure);

  let reason = granted;
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
export const decide: Decide = (input) => createDecide({ authorizer: core.getAuthServices().authorizer, freshAuthRequiresHttps: () => freshAuthRequiresHttps() })(input);
