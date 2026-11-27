/**
 * Requirement evaluation of the setup resolver (D108 §2.4): every check
 * goes through the `ResolverPorts`, so it stays pure.
 *
 *   explicit   `setup.requirements` + the selected profile's requirements
 *              (level required/optional, `when` on the active values)
 *   implied    what the requested configuration itself needs, always
 *              required: a Private Home (D64 `app-private-home`, the
 *              `home.private` grant, `storage.privateHome`), each
 *              `owner-environment` sidecar of a private instance (its
 *              `home.private.sidecar:<n>` grant), an `instance` network
 *              (`network.isolation`), app resources (`resources.limits`, D106)
 *   derived    `requirementsOf()` on the requested manifest view (the one
 *              derivation, D85 A5), checked as ARI features of the resolved
 *              runtime
 *
 * Feasibility counts only `supported`: `conditional` is advisory
 * enforcement and never meets a requirement (fail closed). An unmet required
 * requirement blocks; an unmet optional one is `degraded`. Nothing is ever
 * met by weakening the request.
 */
import { conditionHolds, type ConfigValues } from '../config/schema.js';
import { requirementsOf, type RequirementsManifest } from '../runtimes/requirements.js';
import type { RuntimeCapability } from '../runtimes/types.js';
import type { SetupRequirement } from '../types/setupManifest.js';
import {
  APP_PRIVATE_HOME_OPTION, HOME_PRIVATE_PERMISSION, homePrivateSidecarPermission, setupError,
  type AuthorizationRequest, type DegradedRequirement, type RequirementResult, type ResolverPorts, type SetupErrorBody,
  type SetupManifestView,
} from './contracts.js';
import type { MergedShape } from './merge.js';

/**
 * The ARI feature that follows exactly one capability `requirementsOf()` can
 * derive (the rows of `FEATURE_OF_CAPS` in runtimes/ari.ts that read only
 * that capability; test `setup-resolve` checks the table against
 * `featuresOf`). A derived need with no row here is unmet (fail closed).
 */
export const FEATURE_OF_NEED: Readonly<Partial<Record<RuntimeCapability, string>>> = Object.freeze({
  sidecars: 'workload.dynamic',
  userNamespaces: 'execution.userNamespaces',
  portExpose: 'network.endpointExposure',
  warmPool: 'instance.warmPool',
  mounts: 'mount.attach',
  hostFilesystem: 'storage.persistent',
});

export interface RequirementsInput {
  manifest: SetupManifestView;
  /** The requested manifest view (`effectiveManifestView`). */
  view: SetupManifestView;
  shape: MergedShape;
  profile: string | null;
  /** Explicit requirements with their manifest paths. */
  explicit: Array<{ requirement: SetupRequirement; manifestField: string }>;
  /** The active fields' values (`when`). */
  values: ConfigValues;
  userId: string;
}

export interface RequirementsOutcome {
  runtime: string;
  requirements: RequirementResult[];
  /** By D105 kind: policy refusals, missing authorizations, unmet features. */
  policy: SetupErrorBody[];
  unauthorized: SetupErrorBody[];
  unsupported: SetupErrorBody[];
  degraded: DegradedRequirement[];
}

const subjectKey = (r: SetupRequirement): string =>
  'feature' in r ? `feature:${r.feature}` : 'capability' in r ? `capability:${r.capability}` : `grant:${r.grant}`;

function grantRequest(grant: string, userId: string): AuthorizationRequest {
  const sidecarPrefix = `${HOME_PRIVATE_PERMISSION}.sidecar:`;
  if (grant === HOME_PRIVATE_PERMISSION) return { kind: 'home-private', userId };
  if (grant.startsWith(sidecarPrefix)) return { kind: 'home-private-sidecar', sidecar: grant.slice(sidecarPrefix.length), userId };
  return { kind: 'grant', grant, userId };
}

/** One requirement's subject against the ports: null when met, else its D105 body. */
function check(r: SetupRequirement, ctx: { runtime: string; features: ReturnType<ResolverPorts['runtimeFeatures']>; ports: ResolverPorts; userId: string }, manifestField: string | undefined): SetupErrorBody | null {
  const why = r.reason ? ` (${r.reason})` : '';
  const at = manifestField ? { manifestField } : {};
  if ('feature' in r) {
    if (!ctx.features) {
      return setupError('requirement-unsupported', `runtime ${ctx.runtime} is not installed or is disabled, so feature ${r.feature} can't be provided${why}`, { ...at, missing: [r.feature] });
    }
    const support = ctx.features[r.feature] ?? 'unsupported';
    if (support === 'supported') return null;
    return setupError('requirement-unsupported', support === 'conditional'
      ? `runtime ${ctx.runtime} supports feature ${r.feature} only conditionally (not enforced), which does not meet a requirement${why}`
      : `runtime ${ctx.runtime} does not support feature ${r.feature}${why}`, { ...at, missing: [r.feature] });
  }
  if ('capability' in r) {
    const c = ctx.ports.capability(r.capability);
    if (!c.installed) return setupError('requirement-unsupported', `capability ${r.capability} is not installed${why}`, { ...at, missing: [`capability:${r.capability}`] });
    if (!c.granted) return setupError('requirement-unauthorized', `capability ${r.capability} is installed but not granted to this app${why}`, { ...at, missing: [`capability:${r.capability}`] });
    return null;
  }
  if (ctx.ports.isAuthorized(grantRequest(r.grant, ctx.userId))) return null;
  return setupError('requirement-unauthorized', `grant ${r.grant} is missing${why}: it needs your approval`, { ...at, missing: [r.grant] });
}

export function evaluateRequirements(input: RequirementsInput, ports: ResolverPorts): RequirementsOutcome {
  const { shape, userId } = input;
  const runtime = shape.sandbox ?? ports.defaultRuntime();
  const features = ports.runtimeFeatures(runtime);
  const ctx = { runtime, features, ports, userId };
  const out: RequirementsOutcome = { runtime, requirements: [], policy: [], unauthorized: [], unsupported: [], degraded: [] };
  const file = (e: SetupErrorBody) => (e.error === 'requirement-unauthorized' ? out.unauthorized : out.unsupported).push(e);

  // Explicit requirements.
  const explicitRequired = new Set<string>();
  for (const { requirement, manifestField } of input.explicit) {
    if (!conditionHolds(requirement.when, input.values, input.profile)) {
      out.requirements.push({ requirement, status: 'inactive' });
      continue;
    }
    if (requirement.level === 'required') explicitRequired.add(subjectKey(requirement));
    const error = check(requirement, ctx, manifestField);
    out.requirements.push(error ? { requirement, status: 'unmet', error } : { requirement, status: 'met' });
    if (!error) continue;
    if (requirement.level === 'required') file(error);
    else out.degraded.push({ requirement, reason: error.message });
  }

  // Implied by the requested configuration (always required).
  const implied: Array<{ requirement: SetupRequirement; manifestField?: string; target?: string }> = [];
  const imply = (requirement: SetupRequirement, origin: { manifestField?: string; target?: string }) => {
    if (explicitRequired.has(subjectKey(requirement)) || implied.some((i) => subjectKey(i.requirement) === subjectKey(requirement))) return;
    implied.push({ requirement, ...origin });
  };
  const homeOrigin = shape.origins.homeEnvironment;
  if (shape.homeEnvironment === 'private') {
    const policy = ports.policy(APP_PRIVATE_HOME_OPTION);
    if (policy !== 'grant') {
      out.policy.push(setupError('policy-refused', `apps may not run with a Private Home on this AuraOS (security option ${APP_PRIVATE_HOME_OPTION} = ${policy === null ? 'unset' : String(policy)}): `
        + 'this configuration stays blocked; it never falls back to the App Home', {
        policy: APP_PRIVATE_HOME_OPTION,
        ...(homeOrigin.manifestField ? { manifestField: homeOrigin.manifestField } : {}), ...(homeOrigin.target ? { target: homeOrigin.target } : {}),
      }));
    }
    const reason = 'home environment private';
    imply({ grant: HOME_PRIVATE_PERMISSION, level: 'required', reason }, homeOrigin);
    imply({ feature: 'storage.privateHome', level: 'required', reason }, homeOrigin);
    for (const s of shape.services) {
      if (s.home === 'owner-environment') {
        imply({ grant: homePrivateSidecarPermission(s.name), level: 'required', reason: `sidecar ${s.name} runs in the owner environment of a private instance` }, shape.origins.serviceHome[s.name] ?? {});
      }
    }
  }
  for (const s of shape.services) {
    if (s.network === 'instance') imply({ feature: 'network.isolation', level: 'required', reason: `service ${s.name} is on the instance network` }, shape.origins.serviceNetwork[s.name] ?? {});
  }
  if (shape.resources) imply({ feature: 'resources.limits', level: 'required', reason: 'app resources must be enforced (D106)' }, shape.origins.resources);

  // Derived from the requested manifest view: the one derivation.
  const derived = requirementsOf(input.view as unknown as RequirementsManifest);
  for (const need of derived.capabilities) {
    const feature = FEATURE_OF_NEED[need];
    if (!feature) {
      const error = setupError('requirement-unsupported', `the configuration needs runtime capability ${need}, which no ARI feature reports`, { missing: [need] });
      out.requirements.push({ requirement: { feature: need, level: 'required', reason: 'derived by requirementsOf()' }, status: 'unmet', error });
      out.unsupported.push(error);
      continue;
    }
    imply({ feature, level: 'required', reason: `derived by requirementsOf(): ${need}` }, {});
  }

  for (const { requirement, manifestField, target } of implied) {
    const error = check(requirement, ctx, manifestField);
    const body = error && target ? { ...error, target } : error;
    out.requirements.push(body ? { requirement, status: 'unmet', error: body } : { requirement, status: 'met' });
    if (body) file(body);
  }

  // Requests the profile adds over the install-approved base.
  for (const [key, manifestField] of Object.entries(shape.origins.added)) {
    const [kind, name] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
    const req: AuthorizationRequest = kind === 'permission' ? { kind: 'permission', permission: name }
      : kind === 'tool' ? { kind: 'tool', tool: name } : { kind: 'context', key: name };
    if (!ports.isAuthorized(req)) {
      out.unauthorized.push(setupError('requirement-unauthorized', `the profile requests ${kind} ${name}, which this installation does not hold yet: it needs your approval`, { manifestField, missing: [key] }));
    }
  }
  return out;
}
