import * as core from '@aura/core';
import type { AccessPrincipal, InstancePrincipal, Principal } from '@aura/core';
import type {
  AccessReason, AccessRule, AccessTarget, Decide, DecideInput, DecideResult, PolicyResource,
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
 */

export interface DecideDeps {
  authorizer: { authorize(principal: Principal, action: string): Promise<{ allow: boolean; reason: string }> };
  /** D29: whether this instance acts for the owner (identify.ts `isTrustedOwnerAgent`). Never asked at the gateway. */
  ownerAgent?(principal: InstancePrincipal): boolean;
}

/** What a trusted owner agent never reaches as the owner: the owner's login session and a shell screen. */
const OWNER_AGENT_EXCLUDED_TARGETS: ReadonlySet<AccessTarget> = new Set(['session', 'client-session']);

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
    const canHold = p.kind === 'instance' || p.kind === 'apiKey'
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

  const via = input.auth.via;
  const refusedAs: AccessReason = principal.kind === 'anonymous' ? 'unauthenticated' : 'wrong-principal';
  // D28: a network-identified caller is good for a `networkCaller` rule and nothing else.
  if (via === 'network') return rule.networkCaller ? allow('network-caller') : deny('unauthenticated');
  if (rule.credentials && !(via && rule.credentials.includes(via))) return deny(refusedAs);

  const { granted, failure } = await matchLevel(input, rule, deps);
  if (!granted) return deny(failure);

  let reason = granted;
  const target = await targetPermissionsHeld(deps, rule, resource, input.strict);
  if (target.outcome !== 'allow') return target;
  if (target.reason === 'auto-granted') reason = 'auto-granted';

  if (rule.freshAuth && !input.auth.fresh) {
    return input.transport === 'https'
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
export const decide: Decide = (input) => createDecide({ authorizer: core.getAuthServices().authorizer })(input);
