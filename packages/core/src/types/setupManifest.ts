/**
 * The manifest blocks of D108 (operating profiles and app setup) and the
 * D107 home declarations they overlay, as zod. Both blocks are optional and
 * independent (owner clarification): an app with neither parses, resolves
 * and launches exactly as before.
 *
 *   setup      typed fields (config/schema.ts, the one field model),
 *              requirements beyond what `requirementsOf()` derives, init and
 *              readiness, declarative field renames per `setup.version`
 *   profiles   overlays on an allowlist of manifest keys (decision 4): the
 *              D107 axes, sandbox, resources, union-only requests and
 *              per-template env/home/network/limits/readiness. A profile
 *              never adds a sidecar image and never replaces anything
 *              identity-bearing.
 *
 * Declarations REQUEST, never grant (D107, `execution`): the setup engine
 * authorizes them through the approval and grant paths.
 *
 * Foundation leaf: imports only zod and config/schema.ts. The engine-side
 * contracts (states, records, digests, errors) are setup/contracts.ts.
 */
import { z } from 'zod';
import {
  ConfigFieldPatchSchema, ConfigFieldSchema, FIELD_NAME_RE, FieldConditionSchema,
  type ConfigField, type ConfigFieldPatch, type FieldCondition,
} from '../config/schema.js';

/** Operating-profile ids: kebab, stable (stored as the selection). */
export const PROFILE_ID_RE = /^[a-z][a-z0-9-]{0,47}$/;

// ── env values: a literal, or a reference (no templating, decision 7) ──────

/**
 * A setup value by reference. `map` translates an enum/boolean value into
 * the literal the workload expects (a fixed table is data, not templating);
 * a value with no entry in `map` is a setup error, never passed through.
 */
export interface FromSetupRef { fromSetup: string; map?: Record<string, string> }
/** A secret field's value, resolved server-side from its vault handle at spawn; never stored in the spec. */
export interface FromSecretRef { fromSecret: string }
export type EnvValueRef = FromSetupRef | FromSecretRef;
export type EnvValue = string | EnvValueRef;

export const EnvValueRefSchema: z.ZodType<EnvValueRef> = z.union([
  z.object({ fromSetup: z.string().regex(FIELD_NAME_RE), map: z.record(z.string(), z.string()).optional() }).strict(),
  z.object({ fromSecret: z.string().regex(FIELD_NAME_RE) }).strict(),
]);
export const EnvValueSchema: z.ZodType<EnvValue> = z.union([z.string(), EnvValueRefSchema]);

export const isEnvValueRef = (v: unknown): v is EnvValueRef =>
  !!v && typeof v === 'object' && !Array.isArray(v) && ('fromSetup' in v || 'fromSecret' in v);

// ── D107 home declarations (requests; the home.private grant authorizes) ───

/** The app process's home environment (D107): its App Home, or the user's Private Home. */
export type HomeEnvironment = 'app' | 'private';
export const HOME_ENVIRONMENTS = ['app', 'private'] as const satisfies readonly HomeEnvironment[];

/**
 * A sidecar's home (D107 §4): none, the app's App Home (`inheritHome: true`
 * is the alias), or the same home and identity as the app process
 * (`owner-environment`: the Private Home under the user's uid when the
 * instance is `private`, which needs `home.private.sidecar:<name>`).
 */
export type SidecarHome = 'none' | 'app' | 'owner-environment';
export const SIDECAR_HOMES = ['none', 'app', 'owner-environment'] as const satisfies readonly SidecarHome[];

export interface HomeEnvironmentsDeclaration {
  supported: HomeEnvironment[];
  recommended?: HomeEnvironment;
  /** The author's words, shown labelled as such. */
  reason?: string;
}

export const HomeEnvironmentsSchema: z.ZodType<HomeEnvironmentsDeclaration> = z.object({
  supported: z.array(z.enum(HOME_ENVIRONMENTS)).min(1),
  recommended: z.enum(HOME_ENVIRONMENTS).optional(),
  reason: z.string().trim().min(1).max(300).optional(),
}).strict().refine((h) => h.supported.includes('app'), {
  message: 'homeEnvironments.supported must include "app" (the App Home is always possible; private is the opt-in)', path: ['supported'],
}).refine((h) => !h.recommended || h.supported.includes(h.recommended), {
  message: 'homeEnvironments.recommended must be one of supported', path: ['recommended'],
});

// ── setup ───────────────────────────────────────────────────────────────────

export type RequirementLevel = 'required' | 'optional';

/**
 * A requirement beyond `requirementsOf()` (D108 §2.2). Exactly one subject:
 *   feature     an ARI feature id of the resolved runtime (`network.isolation`, `storage.privateHome`, …)
 *   capability  a capability (tool) of the registry: install/grant offered
 *   grant       a grant that must count (`home.private`, `home.private.sidecar:<n>`, a permission)
 * `optional` unmet → reported as `degraded`, never satisfied by weakening.
 */
export type SetupRequirement = { level: RequirementLevel; when?: FieldCondition; reason?: string } & (
  | { feature: string } | { capability: string } | { grant: string }
);

const requirementCommon = {
  level: z.enum(['required', 'optional']),
  when: FieldConditionSchema.optional(),
  reason: z.string().trim().min(1).max(300).optional(),
};
export const SetupRequirementSchema: z.ZodType<SetupRequirement> = z.union([
  z.object({ ...requirementCommon, feature: z.string().regex(/^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)*$/) }).strict(),
  z.object({ ...requirementCommon, capability: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/) }).strict(),
  z.object({ ...requirementCommon, grant: z.string().min(1).max(200) }).strict(),
]);

/** A declarative field rename: from `setup.version` `since` on, `from` is called `to` (P8). */
export interface SetupRename { since: number; from: string; to: string }

export interface SetupDeclaration {
  /** The fields' version: stored values of an older one migrate (renames, then `onMigrateConfig`). */
  version: number;
  fields: Record<string, ConfigField>;
  requirements: SetupRequirement[];
  renames: SetupRename[];
  /** `hook: true` calls the app's `onSetup` in a maintenance start (idempotent, bounded). */
  init?: { hook: boolean; idempotent: boolean; timeoutSec: number };
  /** `hook: true` calls `onValidate` after init; default: the health check + `services[].readiness`. */
  readiness?: { hook: boolean };
}

const fieldsSchema = z.record(z.string().regex(FIELD_NAME_RE, { message: 'setup field names: a letter, then letters, digits or _' }), ConfigFieldSchema);

export const SetupDeclarationSchema: z.ZodType<SetupDeclaration, z.ZodTypeDef, unknown> = z.object({
  version: z.number().int().min(1).default(1),
  fields: fieldsSchema.default({}),
  requirements: z.array(SetupRequirementSchema).default([]),
  renames: z.array(z.object({
    since: z.number().int().min(2), from: z.string().regex(FIELD_NAME_RE), to: z.string().regex(FIELD_NAME_RE),
  }).strict()).default([]),
  init: z.object({
    hook: z.boolean(),
    idempotent: z.boolean().default(true),
    timeoutSec: z.number().int().min(5).max(3600).default(300),
  }).strict().optional(),
  readiness: z.object({ hook: z.boolean() }).strict().optional(),
}).strict().superRefine((s, ctx) => {
  for (const r of s.renames) {
    if (r.since > s.version) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['renames'], message: `rename since ${r.since} is above setup.version ${s.version}` });
    if (!(r.to in s.fields)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['renames'], message: `rename target ${r.to} is not a field` });
  }
});

// ── profiles ────────────────────────────────────────────────────────────────

/** The overlay keys a profile may set (decision 4). Anything else is a parse error. */
export const PROFILE_OVERLAY_KEYS = [
  'instanceScope', 'environmentScope', 'homeEnvironment', 'sandbox', 'services', 'permissions', 'tools', 'context', 'resources',
] as const;
/** What a profile may set on a base `services[]` template, merged by name. Never an image. */
export const SERVICE_OVERLAY_KEYS = ['env', 'home', 'network', 'limits', 'readiness'] as const;

/** D19/D107 instance scope. Alpha: only `per-user`; `shared` is refused fail closed (W4, BT-M2). */
export type InstanceScope = 'per-user' | 'shared';

export interface ServiceOverlay {
  env?: Record<string, EnvValue>;
  home?: SidecarHome;
  network?: 'instance' | 'shared';
  limits?: { memory?: string; cpus?: number };
  readiness?: { path?: string; timeoutMs?: number };
}

export interface ProfileOverlay {
  instanceScope?: InstanceScope;
  environmentScope?: 'global' | 'user';
  homeEnvironment?: HomeEnvironment;
  sandbox?: string;
  services?: Record<string, ServiceOverlay>;
  /** Added requests (union with the base, sorted); never a removal. */
  permissions?: string[];
  tools?: string[];
  context?: string[];
  /** App-instance resources through ARI `resources.limits` (unenforced → refused, D106). */
  resources?: { memory?: string; cpus?: number };
}

export interface ProfileDeclaration {
  id: string;
  title: string;
  description?: string;
  recommended?: boolean;
  overlay: ProfileOverlay;
  /** Profile-only fields (complete) or tightenings of base fields (by name), and extra requirements. */
  setup?: { fields?: Record<string, ConfigField | ConfigFieldPatch>; requirements?: SetupRequirement[] };
}

const MEMORY_RE = /^\d+[bkmg]?$/i;

export const ServiceOverlaySchema: z.ZodType<ServiceOverlay> = z.object({
  env: z.record(z.string(), EnvValueSchema).optional(),
  home: z.enum(SIDECAR_HOMES).optional(),
  network: z.enum(['instance', 'shared']).optional(),
  limits: z.object({ memory: z.string().regex(MEMORY_RE).optional(), cpus: z.number().positive().optional() }).strict().optional(),
  readiness: z.object({ path: z.string().optional(), timeoutMs: z.number().int().min(1000).optional() }).strict().optional(),
}).strict();

export const ProfileOverlaySchema: z.ZodType<ProfileOverlay> = z.object({
  instanceScope: z.enum(['per-user', 'shared']).optional(),
  environmentScope: z.enum(['global', 'user']).optional(),
  homeEnvironment: z.enum(HOME_ENVIRONMENTS).optional(),
  sandbox: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/).optional(),
  services: z.record(z.string(), ServiceOverlaySchema).optional(),
  permissions: z.array(z.string().min(1)).optional(),
  tools: z.array(z.string().min(1)).optional(),
  context: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/)).optional(),
  resources: z.object({ memory: z.string().regex(MEMORY_RE).optional(), cpus: z.number().positive().optional() }).strict().optional(),
}).strict({ message: `a profile overlay may only set ${PROFILE_OVERLAY_KEYS.join(', ')} (D108 decision 4)` });

export const ProfileDeclarationSchema: z.ZodType<ProfileDeclaration, z.ZodTypeDef, unknown> = z.object({
  id: z.string().regex(PROFILE_ID_RE, { message: 'profiles[].id: kebab-case, starting with a letter' }),
  title: z.string().min(1).max(120),
  description: z.string().max(1000).optional(),
  recommended: z.boolean().optional(),
  overlay: ProfileOverlaySchema.default({}),
  setup: z.object({
    fields: z.record(z.string().regex(FIELD_NAME_RE), ConfigFieldPatchSchema).optional(),
    requirements: z.array(SetupRequirementSchema).optional(),
  }).strict().optional(),
}).strict();

// ── cross-checks over the whole manifest ────────────────────────────────────

/** The parts of a parsed manifest the D108 cross-checks read (structural, so the manifest type stays the one source). */
export interface SetupCheckManifest {
  setup?: SetupDeclaration;
  profiles?: ProfileDeclaration[];
  homeEnvironments?: HomeEnvironmentsDeclaration;
  services: Array<{ name: string; env: Record<string, EnvValue>; home?: SidecarHome; inheritHome?: boolean }>;
}

type Issue = { path: (string | number)[]; message: string };

function conditionIssues(when: FieldCondition | undefined, fields: ReadonlySet<string>, profiles: ReadonlySet<string>, path: (string | number)[]): Issue[] {
  if (!when) return [];
  if ('profile' in when) {
    return when.profile.filter((p) => !profiles.has(p)).map((p) => ({ path: [...path, 'when'], message: `when.profile names unknown profile ${p}` }));
  }
  return fields.has(when.field) ? [] : [{ path: [...path, 'when'], message: `when.field names unknown field ${when.field}` }];
}

function refIssues(env: Record<string, EnvValue>, fields: Readonly<Record<string, ConfigField>>, path: (string | number)[]): Issue[] {
  const out: Issue[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (!isEnvValueRef(v)) continue;
    if ('fromSecret' in v) {
      if (fields[v.fromSecret]?.type !== 'secret') out.push({ path: [...path, k], message: `fromSecret names ${v.fromSecret}, which is not a secret field of setup.fields` });
    } else {
      const f = fields[v.fromSetup];
      if (!f) out.push({ path: [...path, k], message: `fromSetup names unknown field ${v.fromSetup}` });
      else if (f.type === 'secret') out.push({ path: [...path, k], message: `fromSetup names secret field ${v.fromSetup}: use fromSecret` });
    }
  }
  return out;
}

/**
 * Every D108 rule the schema can check without the engine: unique profile
 * ids, overlays naming existing templates, profile fields either complete or
 * tightening a base field, `when` naming known fields and profiles, env
 * references naming fields of the right kind (and only with `setup`), the
 * sidecar `home` vs `inheritHome` alias. Returned as issues; the manifest
 * schema reports them as parse errors.
 */
export function setupManifestIssues(m: SetupCheckManifest): Issue[] {
  const out: Issue[] = [];
  const baseFields = m.setup?.fields ?? {};
  const profiles = m.profiles ?? [];
  const profileIds = new Set(profiles.map((p) => p.id));
  if (profileIds.size !== profiles.length) out.push({ path: ['profiles'], message: 'profiles[].id must be unique' });

  // All field names any profile can make exist (for `when` and refs).
  const allFields: Record<string, ConfigField> = { ...baseFields };
  profiles.forEach((p, i) => {
    for (const [name, f] of Object.entries(p.setup?.fields ?? {})) {
      if (name in baseFields) continue;
      const parsed = ConfigFieldSchema.safeParse(f);
      if (!parsed.success) out.push({ path: ['profiles', i, 'setup', 'fields', name], message: `${name} is not a base field, so the profile must declare it completely (type, title)` });
      else allFields[name] = parsed.data;
    }
  });
  const names = new Set(Object.keys(allFields));

  for (const [name, f] of Object.entries(baseFields)) out.push(...conditionIssues(f.when, names, profileIds, ['setup', 'fields', name]));
  (m.setup?.requirements ?? []).forEach((r, i) => out.push(...conditionIssues(r.when, names, profileIds, ['setup', 'requirements', i])));

  const templates = new Map(m.services.map((s) => [s.name, s]));
  profiles.forEach((p, i) => {
    for (const [name, f] of Object.entries(p.setup?.fields ?? {})) {
      const base = baseFields[name];
      if (base && 'type' in f && f.type !== undefined && f.type !== base.type) {
        out.push({ path: ['profiles', i, 'setup', 'fields', name], message: `a profile may tighten ${name}, not change its type` });
      }
      if (base && 'enum' in f && f.enum) {
        const allowed = base.type === 'string' ? base.enum : undefined;
        if (base.type !== 'string' || (allowed && f.enum.some((e) => !allowed.includes(e)))) {
          out.push({ path: ['profiles', i, 'setup', 'fields', name, 'enum'], message: `a profile's enum for ${name} must be a subset of the base field's (tighten, never loosen)` });
        }
      }
      out.push(...conditionIssues(('when' in f ? f.when : undefined), names, profileIds, ['profiles', i, 'setup', 'fields', name]));
    }
    (p.setup?.requirements ?? []).forEach((r, j) => out.push(...conditionIssues(r.when, names, profileIds, ['profiles', i, 'setup', 'requirements', j])));
    for (const [svc, o] of Object.entries(p.overlay.services ?? {})) {
      if (!templates.has(svc)) out.push({ path: ['profiles', i, 'overlay', 'services', svc], message: `no services[] template ${svc}: a profile can't add a sidecar (decision 4)` });
      if (o.env) {
        if (!m.setup && Object.values(o.env).some(isEnvValueRef)) out.push({ path: ['profiles', i, 'overlay', 'services', svc, 'env'], message: 'env references need a setup block' });
        out.push(...refIssues(o.env, allFields, ['profiles', i, 'overlay', 'services', svc, 'env']));
      }
    }
    if (p.overlay.homeEnvironment === 'private' && !m.homeEnvironments?.supported.includes('private')) {
      out.push({ path: ['profiles', i, 'overlay', 'homeEnvironment'], message: 'homeEnvironment private needs homeEnvironments.supported to include "private"' });
    }
  });
  if (profiles.filter((p) => p.recommended).length > 1) out.push({ path: ['profiles'], message: 'at most one profile is recommended' });

  m.services.forEach((s, i) => {
    if (Object.values(s.env).some(isEnvValueRef)) {
      if (!m.setup) out.push({ path: ['services', i, 'env'], message: 'env references (fromSetup/fromSecret) need a setup block' });
      out.push(...refIssues(s.env, allFields, ['services', i, 'env']));
    }
    if (s.home !== undefined && s.inheritHome !== undefined && (s.home === 'app') !== s.inheritHome) {
      out.push({ path: ['services', i, 'home'], message: 'home and inheritHome disagree (inheritHome: true is the alias of home: "app")' });
    }
  });
  return out;
}
