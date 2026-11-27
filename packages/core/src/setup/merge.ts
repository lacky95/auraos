/**
 * The deterministic merge of the setup resolver (D108 §2.4 rules 1–4):
 * base manifest ⊕ selected profile overlay ⊕ desired overrides → the
 * requested configuration. Pure; no ports. Requirement evaluation, `when`,
 * policy and authorization are resolve.ts / requirements.ts.
 *
 *   1  scalars: the overlay overrides the base; desired overrides only the
 *      configurable keys (`DesiredOverrides`: the D107 axes and the runtime)
 *   2  permissions/tools/context: union, sorted; a profile never removes one
 *   3  services: by name, only `SERVICE_OVERLAY_KEYS`; no new template
 *      (`inheritHome: true` is the alias of home `app`)
 *   4  fields: base ∪ profile; a profile tightens (required, enum subset,
 *      narrower minimum/maximum) and never loosens
 *
 * Anything the schema should have refused (an overlay naming no template, a
 * retyped field, `private` without the home declaration) is reported as a
 * D105 body, never merged in a weaker form.
 */
import type { ConfigField, ConfigFieldPatch } from '../config/schema.js';
import type { HomeEnvironment, InstanceScope, ProfileDeclaration, SidecarHome } from '../types/setupManifest.js';
import { setupError, type DesiredOverrides, type EffectiveService, type SetupErrorBody, type SetupManifestView } from './contracts.js';

/** Where a merged value came from: its manifest path for D105 `manifestField` (an override has none). */
export type Origin = { from: 'base' | 'profile' | 'override' | 'default'; manifestField?: string; target?: string };

export const profileField = (profileId: string, path: string): string => `profiles[${profileId}].${path}`;

// ── fields (rule 4) ─────────────────────────────────────────────────────────

/**
 * A base field tightened by a profile's patch. Only `required`, `enum`,
 * `minimum`, `maximum` and `description` count; `when`, `scope`, `default`
 * and the type of a base field are never changed by a profile. A default the
 * tightened field no longer allows is dropped (never kept as a loophole).
 */
export function tightenField(base: ConfigField, patchIn: ConfigFieldPatch | ConfigField): ConfigField {
  const patch = patchIn as ConfigFieldPatch;
  if (patch.type !== undefined && patch.type !== base.type) return base;
  const out = { ...base } as ConfigField & { enum?: string[]; minimum?: number; maximum?: number; default?: unknown };
  if (patch.required === true) out.required = true;
  if (patch.description !== undefined) out.description = patch.description;
  if (base.type === 'string' && patch.enum) {
    out.enum = base.enum ? base.enum.filter((e) => patch.enum!.includes(e)) : [...patch.enum];
    if (typeof out.default === 'string' && !out.enum.includes(out.default)) delete out.default;
  }
  if (base.type === 'integer') {
    if (patch.minimum !== undefined) out.minimum = base.minimum === undefined ? patch.minimum : Math.max(base.minimum, patch.minimum);
    if (patch.maximum !== undefined) out.maximum = base.maximum === undefined ? patch.maximum : Math.min(base.maximum, patch.maximum);
    const d = out.default;
    if (typeof d === 'number' && ((out.minimum !== undefined && d < out.minimum) || (out.maximum !== undefined && d > out.maximum))) delete out.default;
  }
  return out as ConfigField;
}

/** base ∪ profile fields, by name. A profile-only entry must be a complete field; otherwise it is reported. */
export function mergeFields(
  base: Readonly<Record<string, ConfigField>> | undefined, profile: ProfileDeclaration | null,
): { fields: Record<string, ConfigField>; origins: Record<string, string>; issues: SetupErrorBody[] } {
  const fields: Record<string, ConfigField> = { ...(base ?? {}) };
  const origins: Record<string, string> = Object.fromEntries(Object.keys(fields).map((k) => [k, `setup.fields.${k}`]));
  const issues: SetupErrorBody[] = [];
  for (const [name, patch] of Object.entries(profile?.setup?.fields ?? {})) {
    const at = profileField(profile!.id, `setup.fields.${name}`);
    const b = fields[name];
    if (b) {
      if (patch.type !== undefined && patch.type !== b.type) {
        issues.push(setupError('config-invalid', `profile ${profile!.id} changes the type of field ${name}: a profile may only tighten a field`, { manifestField: at }));
      }
      fields[name] = tightenField(b, patch);
    } else if (patch.type !== undefined && typeof patch.title === 'string') {
      fields[name] = patch as ConfigField;
      origins[name] = at;
    } else {
      issues.push(setupError('config-invalid', `profile ${profile!.id} tightens field ${name}, which the base does not declare`, { manifestField: at }));
    }
  }
  return { fields, origins, issues };
}

// ── axes, requests, services (rules 1–3) ────────────────────────────────────

export interface MergedShape {
  homeEnvironment: HomeEnvironment;
  instanceScope: InstanceScope;
  environmentScope: 'global' | 'user';
  sandbox: string | null;
  resources: { memory?: string; cpus?: number } | null;
  permissions: string[];
  tools: string[];
  context: string[];
  services: EffectiveService[];
  origins: {
    homeEnvironment: Origin; instanceScope: Origin; sandbox: Origin; resources: Origin;
    /** service name → origin of its `home` / `network`. */
    serviceHome: Record<string, Origin>; serviceNetwork: Record<string, Origin>;
    /** request (`permission:x`, `tool:x`, `context:X`) → the profile path that added it. */
    added: Record<string, string>;
  };
  issues: SetupErrorBody[];
}

const unionSorted = (base: readonly string[], add: readonly string[] | undefined): string[] => [...new Set([...base, ...(add ?? [])])].sort();

/** A base template's home: `home`, else the `inheritHome` alias, else none. */
export const baseServiceHome = (s: { home?: SidecarHome; inheritHome?: boolean }): SidecarHome => s.home ?? (s.inheritHome ? 'app' : 'none');

function pick<T>(base: T, baseOrigin: Origin, overlay: T | undefined, overlayField: string | undefined, override: T | undefined, overrideKey: string): [T, Origin] {
  if (override !== undefined) return [override, { from: 'override', target: `overrides.${overrideKey}` }];
  if (overlay !== undefined) return [overlay, { from: 'profile', ...(overlayField ? { manifestField: overlayField } : {}) }];
  return [base, baseOrigin];
}

export function mergeShape(m: SetupManifestView, profile: ProfileDeclaration | null, overrides: DesiredOverrides): MergedShape {
  const o = profile?.overlay ?? {};
  const at = (path: string) => (profile ? profileField(profile.id, `overlay.${path}`) : undefined);
  const issues: SetupErrorBody[] = [];

  const [homeEnvironment, homeOrigin] = pick<HomeEnvironment>('app', { from: 'default' }, o.homeEnvironment, at('homeEnvironment'), overrides.homeEnvironment, 'homeEnvironment');
  const [instanceScope, scopeOrigin] = pick<InstanceScope>('per-user', { from: 'default' }, o.instanceScope, at('instanceScope'), overrides.instanceScope, 'instanceScope');
  const [environmentScope] = pick(m.environmentScope, { from: 'base' }, o.environmentScope, at('environmentScope'), overrides.environmentScope, 'environmentScope');
  const [sandbox, sandboxOrigin] = pick<string | null>(m.sandbox ?? null, { from: 'base', manifestField: 'sandbox' }, o.sandbox, at('sandbox'), overrides.sandbox, 'sandbox');
  const resources = o.resources ? { ...o.resources } : null;

  if (homeEnvironment === 'private' && !m.homeEnvironments?.supported.includes('private')) {
    issues.push(setupError('config-invalid', `${m.id} does not declare the Private Home (homeEnvironments.supported): home environment private is not possible`, {
      manifestField: 'homeEnvironments.supported', ...(homeOrigin.target ? { target: homeOrigin.target } : {}),
    }));
  }

  const added: Record<string, string> = {};
  const note = (kind: string, base: readonly string[], add: readonly string[] | undefined, key: string) => {
    for (const x of add ?? []) if (!base.includes(x)) added[`${kind}:${x}`] = at(key)!;
  };
  note('permission', m.permissions, o.permissions, 'permissions');
  note('tool', m.tools, o.tools, 'tools');
  note('context', m.context, o.context, 'context');

  const names = new Set(m.services.map((s) => s.name));
  for (const name of Object.keys(o.services ?? {})) {
    if (!names.has(name)) issues.push(setupError('config-invalid', `profile ${profile!.id} overlays service ${name}, which the manifest does not declare: a profile can't add a sidecar`, { manifestField: at(`services.${name}`) }));
  }
  const serviceHome: Record<string, Origin> = {};
  const serviceNetwork: Record<string, Origin> = {};
  const services: EffectiveService[] = m.services.map((s, i) => {
    const so = o.services?.[s.name];
    const home = so?.home ?? baseServiceHome(s);
    serviceHome[s.name] = so?.home !== undefined ? { from: 'profile', manifestField: at(`services.${s.name}.home`)! } : { from: 'base', manifestField: `services[${i}].home` };
    const network = so?.network ?? s.network;
    serviceNetwork[s.name] = so?.network !== undefined ? { from: 'profile', manifestField: at(`services.${s.name}.network`)! } : { from: 'base', manifestField: `services[${i}].network` };
    const limits = so?.limits || s.limits ? { ...(s.limits ?? {}), ...(so?.limits ?? {}) } : undefined;
    const readiness = so?.readiness ?? s.readiness;
    return {
      name: s.name,
      env: { ...s.env, ...(so?.env ?? {}) },
      home,
      ...(network !== undefined ? { network } : {}),
      ...(limits ? { limits } : {}),
      ...(readiness ? { readiness: { ...readiness } } : {}),
    };
  });

  return {
    homeEnvironment, instanceScope, environmentScope, sandbox, resources,
    permissions: unionSorted(m.permissions, o.permissions),
    tools: unionSorted(m.tools, o.tools),
    context: unionSorted(m.context, o.context),
    services,
    origins: {
      homeEnvironment: homeOrigin, instanceScope: scopeOrigin, sandbox: sandboxOrigin,
      resources: resources ? { from: 'profile', manifestField: at('resources')! } : { from: 'default' },
      serviceHome, serviceNetwork, added,
    },
    issues,
  };
}

// ── the effective manifest view ─────────────────────────────────────────────

/** The configuration parts a manifest view is built from (`requested` or an `EffectiveConfig`). */
export interface ViewConfig {
  permissions: string[];
  tools: string[];
  context: string[];
  sandbox: string | null;
  environmentScope: 'global' | 'user';
  services: EffectiveService[];
}

/**
 * The manifest as the configuration makes it: the base with the merged
 * requests, axes and service overlays. Everything else (and every key the
 * structural view does not name, e.g. `ports`, `warmPool`) passes through
 * unchanged, so `requirementsOf()` and the spawn path read it like any
 * manifest. Base order is kept and additions are appended sorted, so an app
 * without setup or profiles gets its base back unchanged (the golden).
 */
export function effectiveManifestView<M extends SetupManifestView>(m: M, c: ViewConfig): M {
  const keep = (base: readonly string[], merged: readonly string[]) => [...base, ...merged.filter((x) => !base.includes(x))];
  const byName = new Map(c.services.map((s) => [s.name, s]));
  const services = m.services.map((s) => {
    const e = byName.get(s.name);
    if (!e) return s;
    const out: M['services'][number] = { ...s, env: { ...e.env } };
    if (e.home !== baseServiceHome(s)) {
      out.home = e.home;
      if (s.inheritHome !== undefined) out.inheritHome = e.home === 'app';
    }
    if (e.network !== s.network) out.network = e.network;
    if (e.limits && JSON.stringify(e.limits) !== JSON.stringify(s.limits)) out.limits = { ...e.limits };
    if (e.readiness !== undefined && JSON.stringify(e.readiness) !== JSON.stringify(s.readiness)) out.readiness = { ...e.readiness };
    return out;
  });
  const view: M = {
    ...m,
    permissions: keep(m.permissions, c.permissions),
    tools: keep(m.tools, c.tools),
    context: keep(m.context, c.context),
    environmentScope: c.environmentScope,
    services,
  };
  if (c.sandbox !== (m.sandbox ?? null)) {
    if (c.sandbox === null) delete view.sandbox; else view.sandbox = c.sandbox;
  }
  return view;
}
