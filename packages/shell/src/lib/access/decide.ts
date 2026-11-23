import * as core from '@aura/core';
import type { AccessPrincipal, Principal } from '@aura/core';
import type {
  AccessReason, AccessRule, Decide, DecideInput, DecideResult, PolicyResource,
} from './types.ts';

/**
 * The central access decision (5.11), over a manifest rule. Phase 1 only
 * reports what it returns. Permission checks go through core's `Authorizer`,
 * so its answers and its auto-grants stay the single source.
 *
 * The shared `admin` session counts as the report-level `operator`, which
 * satisfies `owner` so recovery keeps working. A browser login cookie is never
 * an input here (D37).
 */

export interface DecideDeps {
  authorizer: { authorize(principal: Principal, action: string): Promise<{ allow: boolean; reason: string }> };
}

const allow = (reason: AccessReason): DecideResult => ({ outcome: 'allow', reason });
const deny = (reason: AccessReason): DecideResult => ({ outcome: 'deny', reason });

const isOwner = (p: AccessPrincipal): boolean =>
  p.kind === 'operator' || p.kind === 'admin' || (p.kind === 'user' && p.role === 'owner');

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

/** Whether each permission is held; `auto` when any was only auto-granted. */
async function checkPermissions(
  deps: DecideDeps, principal: Principal, permissions: readonly string[],
): Promise<{ ok: boolean; auto: boolean }> {
  let auto = false;
  for (const permission of permissions) {
    if (permission.includes('<')) return { ok: false, auto };
    const d = await deps.authorizer.authorize(principal, permission);
    if (!d.allow) return { ok: false, auto };
    auto ||= isAutoGrant(d.reason);
  }
  return { ok: true, auto };
}

async function matchLevel(
  input: DecideInput, rule: AccessRule, deps: DecideDeps,
): Promise<{ granted: AccessReason | null; failure: AccessReason }> {
  const p = input.principal;
  let failure: AccessReason = p.kind === 'anonymous' ? 'unauthenticated' : 'wrong-principal';

  if (rule.allow.includes('owner') && isOwner(p)) return { granted: 'owner', failure };

  if (rule.allow.includes('own-instance') && p.kind === 'instance') {
    if (ownsTarget(p, input.resource)) return { granted: 'own-instance', failure };
    failure = 'wrong-target';
  }

  if (rule.allow.includes('app-permission')) {
    const permissions = rule.permissions ?? [];
    const canHold = p.kind === 'instance' || p.kind === 'apiKey'
      || (p.kind === 'anonymous' && permissions.length > 0);
    if (canHold) {
      const held = await checkPermissions(deps, p as Principal, permissions);
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

  const { granted, failure } = await matchLevel(input, rule, deps);
  if (!granted) return deny(failure);

  let reason = granted;
  if (rule.targetPermissions?.length) {
    if (!resource.appId) return deny('wrong-target');
    const target: Principal = {
      kind: 'instance',
      appId: resource.appId,
      instanceId: resource.instanceId ?? resource.appId,
      verification: 'verified',
    };
    const held = await checkPermissions(deps, target, rule.targetPermissions);
    if (!held.ok) return deny('missing-target-permission');
    if (held.auto) reason = 'auto-granted';
  }

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
