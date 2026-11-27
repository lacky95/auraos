/**
 * The setup resolver (D108 §2.4, P1): one pure, deterministic function
 *
 *   resolveEffective(input, ports) → Resolution
 *     requested  = base ⊕ profile.overlay ⊕ desired          (merge.ts)
 *     fields     = base ∪ profile, tightened, `when` applied on the values
 *     policy     = D64 (`app-private-home`): refuses, never reshapes
 *     authorized = the requested grants and the profile's added requests
 *     feasible   = requirementsOf() + setup/profile requirements as ARI
 *                  features of the resolved runtime (requirements.ts)
 *     effective  = requested when all of the above hold, else null with the
 *                  D105 reasons in `blocking`. Never a fallback: no
 *                  Private→App Home, no instance→shared network, no dropped
 *                  request, no profile picked.
 *
 * `instanceScope: shared` is refused fail closed (shared instances arrive
 * with multi-user, BT-M2). An app with profiles and none selected is
 * `profile-required`; the resolver never picks one. `autoSelectableProfile`
 * answers decision 3 ("exactly one feasible input-free profile") for a
 * caller that asks for it; `profileOptions` lists every profile with its
 * availability.
 *
 * An app without `setup`/`profiles` resolves trivially (no fields, no port
 * consulted, its manifest view identical to the base): no record is needed.
 * Ports are synchronous reads of already-loaded state (contracts.ts).
 */
import { checkConfigValues, conditionHolds, fieldValue, type ConfigField, type ConfigValues } from '../config/schema.js';
import type { ProfileDeclaration, SetupRequirement } from '../types/setupManifest.js';
import {
  declaresSetup, setupError,
  type DegradedRequirement, type DesiredConfig, type EffectiveConfig, type ProfileOption, type RequirementResult, type Resolution,
  type ResolverPorts, type SetupErrorBody, type SetupManifestView, type SetupResolveInput,
} from './contracts.js';
import { configDigestOf, grantDigestOf } from './digest.js';
import { effectiveManifestView, mergeFields, mergeShape, profileField } from './merge.js';
import { evaluateRequirements } from './requirements.js';

const SHARED_MESSAGE = 'shared instances arrive with multi-user (BT-M2); this AuraOS runs per-user instances only. '
  + 'This configuration is refused, never run as a per-user instance instead';

/** The internal answer: the resolution plus what decides availability and input-freeness. */
interface Resolved {
  resolution: Resolution;
  /** Reasons a profile can't be used here at all (policy, unsupported features, shared, structure). */
  hard: SetupErrorBody[];
  /** True when the only blocking reasons are required secrets the vault generates (no owner input). */
  generatedOnly: boolean;
}

// ── values and `when` (rules 4, 5) ──────────────────────────────────────────

interface ValueOutcome {
  fields: Record<string, ConfigField>;
  values: ConfigValues;
  secrets: Record<string, string>;
  fieldErrors: Record<string, string>;
  missing: string[];
  /** Missing required secrets whose source is `generate` (the engine creates them, no input). */
  missingGenerated: string[];
}

function resolveValues(
  all: Record<string, ConfigField>, desired: DesiredConfig | null, userDesired: DesiredConfig | null, profile: string | null,
): ValueOutcome {
  const fieldErrors: Record<string, string> = {};
  const raw: Record<string, unknown> = {};
  // Installation values for installation fields, user values for user fields: never crossed (§5.5).
  for (const [k, v] of Object.entries(desired?.values ?? {})) {
    if (all[k]?.scope === 'user') fieldErrors[k] = 'a per-user field: set per user, never for the installation';
    else raw[k] = v;
  }
  for (const [k, v] of Object.entries(userDesired?.values ?? {})) {
    const f = all[k];
    if (!f) fieldErrors[k] = 'unknown field';
    else if (f.scope !== 'user') fieldErrors[k] = 'an installation field: not set per user';
    else raw[k] = v;
  }

  // `when` after the merge, on the desired values (defaults filled). Removing a field
  // can only make conditions on it false, so this shrinks to a fixpoint.
  const candidate: Record<string, unknown> = {};
  for (const [k, f] of Object.entries(all)) {
    if (f.type === 'secret') continue;
    const v = k in raw ? fieldValue(f, raw[k]) : undefined;
    const d = v ?? f.default;
    if (d !== undefined) candidate[k] = d;
  }
  let active = Object.keys(all);
  for (;;) {
    const vals = Object.fromEntries(active.filter((k) => k in candidate).map((k) => [k, candidate[k]]));
    const next = active.filter((k) => conditionHolds(all[k]!.when, vals, profile));
    if (next.length === active.length) break;
    active = next;
  }
  const fields = Object.fromEntries(active.map((k) => [k, all[k]!]));

  // Values of an inactive field are dropped (a field that does not exist is not validated); unknown keys stay to be named.
  const input = Object.fromEntries(Object.entries(raw).filter(([k]) => k in fields || !(k in all)));
  const checked = checkConfigValues(fields, input);
  Object.assign(fieldErrors, checked.fieldErrors);

  const secrets: Record<string, string> = {};
  const takeSecrets = (src: Record<string, string> | undefined, userScope: boolean) => {
    for (const [k, h] of Object.entries(src ?? {})) {
      const f = all[k];
      if (!f) fieldErrors[k] = 'unknown field';
      else if (f.type !== 'secret') fieldErrors[k] = 'not a secret field';
      else if ((f.scope === 'user') !== userScope) fieldErrors[k] = userScope ? 'an installation secret: not set per user' : 'a per-user secret: never an installation value';
      else if (typeof h !== 'string' || h.length === 0) fieldErrors[k] = 'a secret field takes a vault handle';
      else if (k in fields) secrets[k] = h;
    }
  };
  takeSecrets(desired?.secrets, false);
  takeSecrets(userDesired?.secrets, true);

  const missing = [...checked.missing];
  const missingGenerated: string[] = [];
  for (const [k, f] of Object.entries(fields)) {
    if (f.type !== 'secret' || f.required !== true || k in secrets) continue;
    missing.push(k);
    if (f.secret.source === 'generate') missingGenerated.push(k);
  }
  return { fields, values: checked.values, secrets, fieldErrors, missing: missing.sort(), missingGenerated };
}

// ── the resolver ────────────────────────────────────────────────────────────

const emptyDesired = (setupVersion: number, profile: string | null): DesiredConfig => ({
  v: 1, setupVersion, profile, values: {}, secrets: {}, overrides: {}, updatedAt: '', updatedBy: 'kernel',
});

function resolveCore(input: SetupResolveInput, ports: ResolverPorts): Resolved {
  const m = input.manifest;
  const declares = declaresSetup(m);
  const profiles = m.profiles ?? [];
  const desired = input.desired;
  const profileId = desired?.profile ?? null;
  const structural: SetupErrorBody[] = [];

  let profile: ProfileDeclaration | null = null;
  if (profiles.length > 0 && profileId === null) {
    structural.push(setupError('profile-required', `${m.id} has operating profiles and none is selected: choose one (${profiles.map((p) => p.id).join(', ')})`, { manifestField: 'profiles', state: 'setup-required' }));
  } else if (profileId !== null) {
    profile = profiles.find((p) => p.id === profileId) ?? null;
    if (!profile) structural.push(setupError('unknown-profile', `${m.id} has no operating profile ${profileId}`, { manifestField: 'profiles' }));
  }

  const setupVersion = m.setup?.version ?? 0;
  if (declares && desired && m.setup && desired.setupVersion !== setupVersion) {
    structural.push(setupError('repair-required', `the stored values were written for setup version ${desired.setupVersion}; ${m.id} now declares version ${setupVersion}: migrate them first`, { manifestField: 'setup.version', state: 'repair-required' }));
  }

  const merged = mergeFields(m.setup?.fields, profile);
  structural.push(...merged.issues);
  const shape = mergeShape(m, profile, desired?.overrides ?? {});
  structural.push(...shape.issues);
  const unsupported: SetupErrorBody[] = [];
  if (shape.instanceScope === 'shared') {
    const o = shape.origins.instanceScope;
    unsupported.push(setupError('requirement-unsupported', SHARED_MESSAGE, {
      missing: ['instanceScope:shared'], ...(o.manifestField ? { manifestField: o.manifestField } : {}), ...(o.target ? { target: o.target } : {}),
    }));
  }

  const v = resolveValues(merged.fields, desired, input.userDesired, profileId);
  const requested: Resolution['requested'] = {
    appId: input.appId,
    installationId: input.installationId,
    profile: profileId,
    setupVersion,
    values: v.values,
    secrets: v.secrets,
    services: shape.services,
    permissions: shape.permissions,
    tools: shape.tools,
    context: shape.context,
    homeEnvironment: shape.homeEnvironment,
    ownerEnvironmentSidecars: shape.services.filter((s) => s.home === 'owner-environment').map((s) => s.name).sort(),
    instanceScope: shape.instanceScope,
    environmentScope: shape.environmentScope,
    sandbox: shape.sandbox,
    networks: Object.fromEntries(shape.services.map((s) => [s.name, s.network ?? 'shared'])),
    resources: shape.resources,
  };

  // Requirements, authorization and policy: only for an app that takes part in D108
  // (every app's runtime needs are checked at spawn by the registry anyway).
  let requirements: RequirementResult[] = [];
  let policy: SetupErrorBody[] = [];
  let unauthorized: SetupErrorBody[] = [];
  let degraded: DegradedRequirement[] = [];
  if (declares) {
    const explicit: Array<{ requirement: SetupRequirement; manifestField: string }> = [
      ...(m.setup?.requirements ?? []).map((requirement, i) => ({ requirement, manifestField: `setup.requirements[${i}]` })),
      ...(profile?.setup?.requirements ?? []).map((requirement, i) => ({ requirement, manifestField: profileField(profile!.id, `setup.requirements[${i}]`) })),
    ];
    const r = evaluateRequirements({
      manifest: m, view: effectiveManifestView(m, requested), shape, profile: profileId, explicit, values: v.values, userId: input.userId,
    }, ports);
    requirements = r.requirements;
    policy = r.policy;
    unauthorized = r.unauthorized;
    unsupported.push(...r.unsupported);
    degraded = r.degraded;
  }

  const fieldAt = (f: string) => merged.origins[f];
  const valueErrors: SetupErrorBody[] = [
    ...Object.entries(v.fieldErrors).sort(([a], [b]) => a.localeCompare(b)).map(([f, why]) => setupError('config-invalid', `setup field ${f || '(values)'}: ${why}`, {
      ...(fieldAt(f) ? { manifestField: fieldAt(f) } : {}), fieldErrors: { [f]: why },
    })),
    ...v.missing.map((f) => setupError('config-invalid', `setup field ${f} is required and has no value`, {
      ...(fieldAt(f) ? { manifestField: fieldAt(f) } : {}), fieldErrors: { [f]: 'required' },
    })),
  ];

  // Missing selection and stale stored values are the owner's input, not a property of the profile.
  const hard = [...structural.filter((e) => e.error !== 'profile-required' && e.error !== 'repair-required'), ...policy, ...unsupported];
  const blocking = [...structural, ...policy, ...unauthorized, ...unsupported, ...valueErrors];
  const configDigest = configDigestOf(requested);
  const grantDigest = grantDigestOf(requested);
  const effective: EffectiveConfig | null = blocking.length === 0 ? { ...requested, degraded, configDigest, grantDigest } : null;

  const generatedOnly = blocking.length > 0 && Object.keys(v.fieldErrors).length === 0
    && structural.length === 0 && policy.length === 0 && unauthorized.length === 0 && unsupported.length === 0
    && v.missing.every((f) => v.missingGenerated.includes(f));

  return {
    hard,
    generatedOnly,
    resolution: {
      appId: input.appId,
      installationId: input.installationId,
      profile: profileId,
      fields: v.fields,
      requested,
      policy: { ok: policy.length === 0, refusals: policy },
      authorized: { ok: unauthorized.length === 0, missing: unauthorized },
      feasible: { ok: unsupported.length === 0, requirements },
      values: { ok: valueErrors.length === 0, fieldErrors: v.fieldErrors, missing: v.missing },
      effective,
      blocking,
      degraded,
      configDigest,
      grantDigest,
    },
  };
}

const withProfile = (input: SetupResolveInput, profile: string): SetupResolveInput => ({
  ...input, desired: { ...(input.desired ?? emptyDesired(input.manifest.setup?.version ?? 0, null)), profile },
});

/** The profiles that are usable here (no policy refusal, no unsupported feature, not shared); values and grants are input. */
function availableProfiles(input: SetupResolveInput, ports: ResolverPorts): string[] {
  return (input.manifest.profiles ?? []).filter((p) => resolveCore(withProfile(input, p.id), ports).hard.length === 0).map((p) => p.id);
}

/**
 * Resolve a desired configuration (D108 §2.4). Pure and deterministic for
 * the same input and port answers. `effective` is null whenever anything
 * blocks; every blocking body of an app with profiles names the other
 * available profiles in `suggest` (never picked).
 */
export function resolveEffective(input: SetupResolveInput, ports: ResolverPorts): Resolution {
  const { resolution } = resolveCore(input, ports);
  if (resolution.blocking.length > 0 && (input.manifest.profiles ?? []).length > 0) {
    const suggest = availableProfiles(input, ports).filter((id) => id !== resolution.profile);
    if (suggest.length > 0) {
      const add = (e: SetupErrorBody): SetupErrorBody => ({ ...e, suggest });
      resolution.blocking = resolution.blocking.map(add);
      resolution.policy.refusals = resolution.policy.refusals.map(add);
      resolution.authorized.missing = resolution.authorized.missing.map(add);
    }
  }
  return resolution;
}

/** The context the profile helpers resolve in (no desired record yet, or the current one). */
export interface ProfileContext {
  appId?: string;
  installationId: string;
  userId: string;
  /** The current desired record (values and overrides are kept; only the profile changes). */
  desired?: DesiredConfig | null;
  userDesired?: DesiredConfig | null;
}

const contextInput = (manifest: SetupManifestView, ctx: ProfileContext): SetupResolveInput => ({
  appId: ctx.appId ?? manifest.id, installationId: ctx.installationId, userId: ctx.userId, manifest,
  desired: ctx.desired ?? null, userDesired: ctx.userDesired ?? null,
});

/**
 * Decision 3: the one profile a caller that asks for it may select without
 * the owner, or null. Only when EXACTLY ONE profile is feasible and needs no
 * input: with no values given, it resolves to an effective configuration
 * except for required secrets the vault generates (no missing value, no
 * grant or approval to ask for, no policy refusal, no unsupported feature).
 * The resolver itself never calls this.
 */
export function autoSelectableProfile(manifest: SetupManifestView, ports: ResolverPorts, ctx: ProfileContext): string | null {
  const version = manifest.setup?.version ?? 0;
  const ok = (manifest.profiles ?? []).filter((p) => {
    const r = resolveCore({ ...contextInput(manifest, ctx), desired: { ...emptyDesired(version, p.id), overrides: { ...(ctx.desired?.overrides ?? {}) } } }, ports);
    return r.resolution.blocking.length === 0 || r.generatedOnly;
  });
  return ok.length === 1 ? ok[0]!.id : null;
}

/**
 * Every profile as the API, CLI and wizard list it (P5/P6): `available`
 * when nothing outside the owner's input blocks it (missing values and
 * grants to approve are input); an unavailable one carries its reasons.
 */
export function profileOptions(manifest: SetupManifestView, ports: ResolverPorts, ctx: ProfileContext): ProfileOption[] {
  const base = contextInput(manifest, ctx);
  return (manifest.profiles ?? []).map((p) => {
    const { hard } = resolveCore(withProfile(base, p.id), ports);
    return {
      id: p.id, title: p.title, ...(p.description !== undefined ? { description: p.description } : {}),
      recommended: p.recommended === true, available: hard.length === 0, reasons: hard,
    };
  });
}
