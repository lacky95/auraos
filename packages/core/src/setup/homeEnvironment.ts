/**
 * D107-a owner subset in the setup framework (D108 P9; review §9.1 "D107
 * parts needed"): the user's Private Home as an app's home environment.
 *
 *   desired     `homeEnvironment: private` in the setup record (P2), via a
 *               profile overlay or the operator override (P1 merge)
 *   authorized  `homePrivateAuthorized()`: the user's `home.private` grant
 *               (and `home.private.sidecar:<n>` per `owner-environment`
 *               sidecar) counts ∧ D64 `app-private-home` = `grant` ∧ the
 *               runtime holds a Private Home per instance
 *               (`storage.privateHome` constraint `instance`; PRoot never)
 *               ∧ the installation runs as its app identity (never a root
 *               installation, I3) ∧ no sidecar listens on the shared
 *               network (D107 §8.1, the net-iso2 rule `templateNetwork`)
 *   effective   the app process runs as that user (identity (A): the
 *               `user-environment` context, identity/appIdentityProvider.ts
 *               `userApp`) with that user's Private Home; the kernel asks
 *               `privateHomeSpawnPort()` at every start
 *
 * Grants (`grantHomePrivate`): app subject, scope `{kind:'user', id}` of the
 * home's own user, pinned to the installation (the `credential.read:<NAME>`
 * pattern, auth/GrantStore.ts). Given only when the engine consumes that
 * user's forced + fresh `app.setup.apply` approval (`setupApplyClass`);
 * never by an install or update approval, never by the app.
 *
 * Revocation (`privateHomeTeardown`): the instances running with the user's
 * Private Home stop, with their sidecars (the runtime removes them with the
 * instance) and the sessions open in them; the engine (P3) writes `blocked`
 * and keeps the desired record at `private`. Never a reconfiguration to the
 * App Home (owner decision: desired ≠ authorized ≠ effective).
 *
 * Owner-only alpha: the home's user is a real user id (the instance owner);
 * there is no constant fallback, and no user ever reaches another's home.
 * Errors are D105 bodies (setup/contracts.ts codes), reader-aware: they name
 * the missing grant or condition, never another user's grants or values.
 */
import { appGrantCounts, userScope, type GrantRecord, type GrantStore } from '../auth/GrantStore.js';
import type { AuditInput } from '../auth/AdminAudit.js';
import type { AppGrantBinding, ChangeAttribution } from '../auth/types.js';
import { SIDECAR_NAME_RE, templateHome, templateNetwork } from '../app-manager/sidecar-spec.js';
import { featuresOf, type RuntimeFeatureOverrides } from '../runtimes/ari.js';
import type { RuntimeCapabilities } from '../runtimes/types.js';
import type { HomeEnvironmentsDeclaration, SidecarHome } from '../types/setupManifest.js';
import {
  APP_PRIVATE_HOME_OPTION, HOME_PRIVATE_PERMISSION, homePrivateSidecarPermission, setupError,
  type AuthorizationRequest, type EffectiveConfig, type SetupErrorBody,
} from './contracts.js';

/** The audit actions of the Private Home grant (AdminAudit). */
export const HOME_PRIVATE_AUDIT = { granted: 'home.private.granted', revoked: 'home.private.revoked' } as const;

/** A refusal with its D105 body (thrown by the grant and the spawn port). */
export class HomePrivateError extends Error {
  override readonly name = 'HomePrivateError';
  readonly status = 409;
  readonly code: SetupErrorBody['error'];
  constructor(readonly body: SetupErrorBody) {
    super(body.message);
    this.code = body.error;
  }
}

// ── authorization ───────────────────────────────────────────────────────────

/** The `ResolverPorts.isAuthorized` kinds this module answers (P1 requirements.ts). */
export type HomePrivateRequest = Extract<AuthorizationRequest, { kind: 'home-private' | 'home-private-sidecar' }>;

/** A `services[]` template as far as the Private Home rules read it (the effective view when a profile overlays it). */
export interface HomePrivateService {
  name: string;
  network?: 'instance' | 'shared';
  home?: SidecarHome;
  inheritHome?: boolean;
  privileged?: boolean;
  capabilities?: string[];
  devices?: string[];
  user?: string;
}

/**
 * Everything `homePrivateAuthorized` decides on, read beforehand
 * (`loadHomePrivateFacts`), so the decision is pure and synchronous like the
 * resolver's ports.
 */
export interface HomePrivateFacts {
  appId: string;
  installationId: string;
  /** The home's user: the instance owner (alpha: the owner; a real id, never a fallback). */
  userId: string;
  /** The app's current install scope and installation (S1). */
  binding: AppGrantBinding;
  /** The user-scope grants as read now: `home.private`, and `home.private.sidecar:<n>` per asked sidecar. */
  grants: { home: GrantRecord | null; sidecars: Readonly<Record<string, GrantRecord | null>> };
  /** D64 `app-private-home` (`off | grant`). */
  policy: string | boolean | null;
  /** The manifest declares `homeEnvironments.supported: [..., 'private']` (a grant counts only while it does). */
  declaresPrivate: boolean;
  /** The resolved runtime; `privateHomeInstance` = `storage.privateHome` constraint `instance`. Null: unknown runtime. */
  runtime: { id: string; privateHomeInstance: boolean } | null;
  /** The installation's process identity (P5-3) and a root execution request or approval (identity/execution.ts). */
  installation: { runAs: 'app' | 'root' | null; rootExecution: boolean };
  services: readonly HomePrivateService[];
}

export type HomePrivateDecision = { ok: true } | { ok: false; error: SetupErrorBody };

const PROOT_RUNTIME = 'proot';

/** Does a stored grant count for this app, installation and user (S1 + the user scope)? */
function counts(rec: GrantRecord | null, facts: HomePrivateFacts, permission: string): boolean {
  if (!rec || rec.permission !== permission || rec.subject?.kind !== 'app' || rec.subject.id !== facts.appId) return false;
  if (rec.scope?.kind !== 'user' || rec.scope.id !== facts.userId) return false;
  return facts.binding.installationId === facts.installationId && appGrantCounts(rec, facts.binding);
}

const sidecarUnsafe = (s: HomePrivateService): string | null => {
  if (s.privileged) return 'privileged';
  if ((s.capabilities ?? []).length) return 'capabilities';
  if ((s.devices ?? []).length) return 'devices';
  if (s.user !== undefined) return `user ${s.user}`;
  return null;
};

/**
 * Whether a `home-private` / `home-private-sidecar` request is authorized for
 * the facts' installation and user. Every condition fails closed with its
 * D105 body; nothing is ever met by a weaker configuration.
 */
export function homePrivateAuthorized(facts: HomePrivateFacts, request: HomePrivateRequest): HomePrivateDecision {
  const refuse = (error: SetupErrorBody): HomePrivateDecision => ({ ok: false, error });
  const target = request.kind === 'home-private-sidecar' ? { target: request.sidecar } : {};
  // I1: only the home's own user. The body names nobody (reader-aware).
  if (request.userId !== facts.userId) {
    return refuse(setupError('requirement-unauthorized', 'a Private Home is its own user\'s only: this app can\'t run with another user\'s home', target));
  }
  if (facts.policy !== 'grant') {
    return refuse(setupError('policy-refused', `apps may not run with a Private Home on this AuraOS (security option ${APP_PRIVATE_HOME_OPTION} = ${facts.policy === null ? 'unset' : String(facts.policy)}): `
      + 'it stays blocked and never falls back to the App Home', { policy: APP_PRIVATE_HOME_OPTION, ...target }));
  }
  if (!facts.declaresPrivate) {
    return refuse(setupError('requirement-unsupported', `${facts.appId} does not declare the Private Home (homeEnvironments.supported), so a home.private grant does not count`, {
      manifestField: 'homeEnvironments.supported', missing: [HOME_PRIVATE_PERMISSION], ...target,
    }));
  }
  if (!facts.runtime || facts.runtime.id === PROOT_RUNTIME || !facts.runtime.privateHomeInstance) {
    return refuse(setupError('requirement-unsupported', `${facts.runtime ? `runtime ${facts.runtime.id}` : 'the app\'s runtime'} can't hold a Private Home for an instance `
      + '(storage.privateHome instance: a namespace boundary and an enforced identity; PRoot never)', {
      missing: ['storage.privateHome'], hint: 'run the app on the container runtime', ...target,
    }));
  }
  if (facts.installation.runAs !== 'app' || facts.installation.rootExecution) {
    return refuse(setupError('requirement-unsupported', `${facts.appId} is installed to run as root: a root installation never gets a Private Home (it could reach every home)`, {
      missing: ['identity:app'], hint: `run it as its app identity (aura admin apps run-as ${facts.appId} app) and drop any root request`, ...target,
    }));
  }
  // D107 §8.1 / net-iso2: a Private Home only where no sidecar listens on the shared network.
  const shared = facts.services.filter((s) => templateNetwork(s) === 'shared').map((s) => s.name);
  if (shared.length) {
    return refuse(setupError('requirement-unsupported', `${facts.appId}'s sidecar${shared.length > 1 ? 's' : ''} ${shared.join(', ')} would listen on the shared app network, `
      + 'so the app can\'t run with a Private Home (a Private Home only where network isolation is guaranteed)', {
      missing: shared.map((n) => `services[${n}].network`), hint: `declare "network": "instance" for ${shared.map((n) => `services[${n}]`).join(', ')}`, ...target,
    }));
  }
  if (!counts(facts.grants.home, facts, HOME_PRIVATE_PERMISSION)) {
    return refuse(setupError('requirement-unauthorized', `${facts.appId} holds no ${HOME_PRIVATE_PERMISSION} grant for your Private Home: it needs your approval`, {
      missing: [HOME_PRIVATE_PERMISSION], ...target,
    }));
  }
  if (request.kind === 'home-private') return { ok: true };

  const permission = homePrivateSidecarPermission(request.sidecar);
  const svc = facts.services.find((s) => s.name === request.sidecar);
  if (!svc || templateHome(svc) !== 'owner-environment') {
    return refuse(setupError('requirement-unsupported', `${facts.appId} has no sidecar ${request.sidecar} with home owner-environment`, {
      manifestField: `services[${request.sidecar}].home`, missing: [permission], ...target,
    }));
  }
  const unsafe = sidecarUnsafe(svc);
  if (unsafe) {
    return refuse(setupError('requirement-unsupported', `sidecar ${request.sidecar} sets ${unsafe}, so it can't get your Private Home (it runs only as you, with no capability)`, {
      manifestField: `services[${request.sidecar}]`, missing: [permission], ...target,
    }));
  }
  if (!counts(facts.grants.sidecars[request.sidecar] ?? null, facts, permission)) {
    return refuse(setupError('requirement-unauthorized', `sidecar ${request.sidecar} holds no ${permission} grant: it needs your approval`, { missing: [permission], ...target }));
  }
  return { ok: true };
}

/** What `loadHomePrivateFacts` reads. */
export interface HomePrivateFactsDeps {
  grants: Pick<GrantStore, 'get'>;
  binding(appId: string): Promise<AppGrantBinding>;
  /** D64 `app-private-home` from the owner's security policy. */
  policy(): Promise<string | boolean | null>;
  /** The runtime the app resolves to (its id, capabilities and feature overrides); null when none. */
  runtime(appId: string): Promise<{ id: string; capabilities: RuntimeCapabilities; featureOverrides?: RuntimeFeatureOverrides } | null>;
  /** The installation record's runAs and root approval (`apphost:install`). */
  installation(appId: string): Promise<{ runAs?: 'app' | 'root'; execution?: unknown } | null>;
}

export interface HomePrivateFactsInput {
  appId: string;
  installationId: string;
  userId: string;
  /** The manifest (or its effective view): declarations, services, a root execution request. */
  manifest: { homeEnvironments?: HomeEnvironmentsDeclaration; execution?: unknown; services?: readonly HomePrivateService[] };
  /** The `owner-environment` sidecars whose grants to read. */
  sidecars?: readonly string[];
}

export async function loadHomePrivateFacts(deps: HomePrivateFactsDeps, input: HomePrivateFactsInput): Promise<HomePrivateFacts> {
  const subject = { kind: 'app' as const, id: input.appId };
  const scope = userScope(input.userId);
  const [binding, policy, rt, installation, home] = await Promise.all([
    deps.binding(input.appId), deps.policy(), deps.runtime(input.appId), deps.installation(input.appId),
    deps.grants.get(subject, HOME_PRIVATE_PERMISSION, scope),
  ]);
  const sidecars: Record<string, GrantRecord | null> = {};
  for (const name of new Set(input.sidecars ?? [])) {
    sidecars[name] = SIDECAR_NAME_RE.test(name) ? await deps.grants.get(subject, homePrivateSidecarPermission(name), scope) : null;
  }
  const feature = rt ? featuresOf(rt.capabilities, rt.featureOverrides ?? {}).find((f) => f.id === 'storage.privateHome') : undefined;
  return {
    appId: input.appId, installationId: input.installationId, userId: input.userId, binding,
    grants: { home, sidecars }, policy,
    declaresPrivate: input.manifest.homeEnvironments?.supported.includes('private') === true,
    runtime: rt ? { id: rt.id, privateHomeInstance: feature?.constraints?.['instance'] === true } : null,
    installation: {
      runAs: installation?.runAs ?? (installation ? 'root' : null),
      rootExecution: input.manifest.execution !== undefined || installation?.execution !== undefined,
    },
    services: [...(input.manifest.services ?? [])],
  };
}

// ── grants (the engine consumes the approved app.setup.apply) ───────────────

export interface HomePrivateGrantDeps {
  grants: Pick<GrantStore, 'grant'>;
  binding(appId: string): Promise<AppGrantBinding>;
  audit(entry: AuditInput): Promise<unknown>;
  /** The owner's user id: the host operator decides for the owner's home only (it acts for the owner, D50). */
  ownerId: string;
}

export interface HomePrivateGrantInput {
  appId: string;
  installationId: string;
  /** The home's user (the grant's scope). */
  userId: string;
  /** `owner-environment` sidecars that get the home too (`adds.homePrivateSidecars`). */
  sidecars: readonly string[];
  /** Who decided the forced + fresh `app.setup.apply` (the consumed approval's decider). */
  decidedBy: ChangeAttribution;
  /** That approval (the audit names it). */
  approvalId: string;
}

export interface HomePrivateGrantResult {
  granted: string[];
}

/**
 * Writes `home.private` and each `home.private.sidecar:<n>` for (app,
 * installation, user) after the user's approval. Only the home's own user
 * decides (the host operator for the owner's home); the installation must
 * still be the one the approval was for. Everything is checked before the
 * first write; a refusal throws `HomePrivateError`.
 */
export async function grantHomePrivate(deps: HomePrivateGrantDeps, input: HomePrivateGrantInput): Promise<HomePrivateGrantResult> {
  const refuse = (message: string, extra: Partial<SetupErrorBody> = {}): never => {
    throw new HomePrivateError(setupError('requirement-unauthorized', message, { missing: [HOME_PRIVATE_PERMISSION], ...extra }));
  };
  const by = input.decidedBy as { kind?: unknown; userId?: unknown };
  const ownDecision = by?.kind === 'user' && typeof by.userId === 'string' && by.userId === input.userId;
  const operatorForOwner = by?.kind === 'operator' && input.userId === deps.ownerId;
  if (!ownDecision && !operatorForOwner) refuse('only the home\'s own user can give an app their Private Home');
  if (typeof input.approvalId !== 'string' || !input.approvalId) refuse('a Private Home is given only on its user\'s approval');
  const sidecars = [...new Set(input.sidecars)].sort();
  const bad = sidecars.filter((n) => !SIDECAR_NAME_RE.test(n));
  if (bad.length) refuse(`invalid sidecar name: ${bad.join(', ')}`);
  const binding = await deps.binding(input.appId);
  if (!binding.installationId || binding.installationId !== input.installationId) {
    refuse(`the approval was for another installation of ${input.appId}: approve it again`);
  }
  const opts = { by: input.decidedBy, scope: userScope(input.userId), installationId: input.installationId, ...(binding.scope ? { appScope: binding.scope } : {}) };
  const subject = { kind: 'app' as const, id: input.appId };
  const granted: string[] = [];
  for (const permission of [HOME_PRIVATE_PERMISSION, ...sidecars.map(homePrivateSidecarPermission)]) {
    await deps.grants.grant(subject, permission, opts);
    granted.push(permission);
  }
  await deps.audit({
    by: input.decidedBy, action: HOME_PRIVATE_AUDIT.granted, target: `app:${input.appId}`, outcome: 'ok',
    detail: { installation: input.installationId, user: input.userId, sidecars, approval: input.approvalId },
  });
  return { granted };
}

// ── the kernel's start path (AppManager option `privateHome`) ──────────────

/**
 * What AppManager asks at every start (`spawnContext`) and sidecar spawn.
 * `homeEnvironmentFor` answers `app` for every app whose effective
 * configuration is not `private`; for a `private` one it re-checks the
 * authorization now and throws `HomePrivateError` when it fails (never `app`).
 */
export interface PrivateHomeSpawnPort {
  homeEnvironmentFor(appId: string, userId: string | undefined): Promise<'app' | 'private'>;
  /** Does `owner-environment` sidecar `sidecar` of `appId`'s private instance for `userId` hold its own grant now? */
  sidecarAuthorized(appId: string, userId: string, sidecar: string): Promise<boolean>;
}

export interface PrivateHomeSpawnDeps {
  /**
   * The gate-validated effective configuration of the app for this user
   * (P3), or null for an app without setup/profiles. The gate refuses a
   * non-ready app before this is asked.
   */
  effective(appId: string, userId: string | undefined): Promise<Pick<EffectiveConfig, 'installationId' | 'homeEnvironment' | 'ownerEnvironmentSidecars'> | null>;
  /** `loadHomePrivateFacts` with the app's manifest (or effective view). */
  facts(appId: string, installationId: string, userId: string, sidecars: readonly string[]): Promise<HomePrivateFacts>;
}

export function privateHomeSpawnPort(deps: PrivateHomeSpawnDeps): PrivateHomeSpawnPort {
  return {
    async homeEnvironmentFor(appId, userId) {
      const eff = await deps.effective(appId, userId);
      if (!eff || eff.homeEnvironment !== 'private') return 'app';
      if (!userId) {
        throw new HomePrivateError(setupError('requirement-unauthorized', `${appId} runs with its user's Private Home, so it starts only for that user (never warmed for nobody)`, {
          missing: [HOME_PRIVATE_PERMISSION],
        }));
      }
      const facts = await deps.facts(appId, eff.installationId, userId, []);
      const d = homePrivateAuthorized(facts, { kind: 'home-private', userId });
      if (!d.ok) throw new HomePrivateError(d.error);
      return 'private';
    },
    async sidecarAuthorized(appId, userId, sidecar) {
      const eff = await deps.effective(appId, userId);
      if (!eff || eff.homeEnvironment !== 'private' || !eff.ownerEnvironmentSidecars.includes(sidecar)) return false;
      const facts = await deps.facts(appId, eff.installationId, userId, [sidecar]);
      return homePrivateAuthorized(facts, { kind: 'home-private-sidecar', sidecar, userId }).ok;
    },
  };
}

// ── revocation (P3 blocking.ts on permissions:changed / a policy change) ────

export interface PrivateHomeTeardownDeps {
  /** The app's instances (AppManager `getInstancesByApp`). */
  instances(appId: string): ReadonlyArray<{ instanceId: string; owner?: string; runAs?: 'root' | 'app' | 'user'; inPool?: boolean }>;
  /** Stops one instance and its sidecars (AppManager `stop`). */
  stop(instanceId: string): Promise<void>;
  /** The open in-environment sessions (stream J; AppManager `openSessions`). */
  sessions(): ReadonlyArray<{ sessionId: string; instanceId: string }>;
  endSession(sessionId: string): Promise<boolean>;
  audit(entry: AuditInput): Promise<unknown>;
}

export interface PrivateHomeTeardownInput {
  appId: string;
  installationId: string;
  /** The user whose Private Home the app no longer may use. */
  userId: string;
  cause: { kind: 'grant'; permission: string } | { kind: 'policy' } | { kind: 'manifest' } | { kind: 'feature'; feature: string };
  /** Who revoked (the audit names them); `system` for a policy, manifest or feature change the kernel noticed. */
  actor: AuditInput['by'];
}

export interface PrivateHomeTeardownResult {
  stopped: string[];
  failed: string[];
  sessionsEnded: number;
}

/**
 * Ends the app's access to the user's Private Home now: every instance that
 * runs as that user (the effective `private` instances; `runAs: user`)
 * stops, with its sidecars, after the sessions open in it are ended. A
 * running process keeps open files, so access ends only when the process
 * does. It writes no setup state and never reconfigures: the engine marks
 * the setup `blocked` and keeps `homeEnvironment: private` desired.
 */
export async function privateHomeTeardown(deps: PrivateHomeTeardownDeps, input: PrivateHomeTeardownInput): Promise<PrivateHomeTeardownResult> {
  const affected = deps.instances(input.appId).filter((i) => i.runAs === 'user' && i.owner === input.userId);
  const ids = new Set(affected.map((i) => i.instanceId));
  let sessionsEnded = 0;
  for (const s of deps.sessions()) {
    if (ids.has(s.instanceId) && await deps.endSession(s.sessionId).catch(() => false)) sessionsEnded++;
  }
  const stopped: string[] = [];
  const failed: string[] = [];
  for (const i of affected) {
    try {
      await deps.stop(i.instanceId);
      stopped.push(i.instanceId);
    } catch {
      failed.push(i.instanceId);
    }
  }
  await deps.audit({
    by: input.actor, action: HOME_PRIVATE_AUDIT.revoked, target: `app:${input.appId}`, outcome: failed.length ? 'failed' : 'ok',
    detail: { installation: input.installationId, user: input.userId, cause: input.cause, stopped, failed, sessionsEnded },
  });
  return { stopped, failed, sessionsEnded };
}
