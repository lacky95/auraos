/**
 * The runtime registry (ARI §9.1, §9.2, §9.9; Phase 5 stream R, 5b stream K):
 * runtimes by string id, and the one resolver that picks an app's runtime.
 *
 * Resolution, first match wins (ARI §5.3, §11.2):
 *   1. a per-installation override (ARI-3) or D75 migration override (a
 *      migration override keeps what an omitted `sandbox` meant, so it
 *      lapses once the manifest names a runtime);
 *   2. the manifest's `sandbox`;
 *   3. the Runtime Settings default.
 * An open D75 decision stops it (`runtime-decision-needed`). Then the runtime
 * must be installed, enabled and healthy, its stored settings must be valid
 * (migrated when older, ARI §4.3), and it must have every capability the app
 * needs (`requirementsOf`, the one derivation). Every miss is a clear error
 * with a `code`; a capability miss names the runtimes that could run it
 * (`suggest`, D73) but nothing falls back to another runtime (Q17), and
 * `useProot` is never read.
 *
 * Registration refuses a module this kernel must not load (`ariRefusal`:
 * an ARI above `ARI_VERSION`, a bad id or descriptor, a duplicate id).
 */
import { ariRefusal, healthRefusal, type RuntimeDescriptor, type RuntimeHealth, type RuntimeModule } from './ari.js';
import type { SandboxRunner } from '../app-manager/SandboxRunner.js';
import { requirementsOf, type RequirementsManifest } from './requirements.js';
import { RuntimeSettingsError, settingsDefaults, validateSettings } from './settingsSchema.js';
import {
  missingCapabilities, RuntimeCapabilityError, RuntimeModuleError, RuntimeResolutionError, RuntimeUnavailableError, suggestText,
  type RuntimeCapabilities, type RuntimeSettings, type RuntimeSettingsRecord, type RuntimeSource,
} from './types.js';

export type { RuntimeDescriptor, RuntimeModule };

/** The manifest fields the needs are derived from. */
export type RuntimeManifest = RequirementsManifest;

/** One app's resolved runtime, latched on the instance at spawn. */
export interface ResolvedRuntime {
  runtime: string;
  source: RuntimeSource;
  module: RuntimeModule;
  settings: RuntimeSettings;
  capabilities: RuntimeCapabilities;
}

export interface ResolveInput {
  manifest: RuntimeManifest;
  /** The app's installation; null when the App Host registry cannot say. */
  installationId: string | null;
  sourceMode: 'open' | 'closed';
  /** The Runtime Settings; null when they cannot be read. */
  record: RuntimeSettingsRecord | null;
  /** The installation's recorded runAs, when known (an installation fact of `requirementsOf`). */
  runAs?: 'app' | 'root';
}

/** A runtime's stored settings, read: valid (migrated when older), or why not (the runtime is then disabled). */
export type RuntimeSettingsState = { ok: true; settings: RuntimeSettings; migratedFrom?: number } | { ok: false; reason: string };

export interface RuntimeRegistryOptions {
  /**
   * A runtime's stored settings failed to validate or migrate (ARI §4.3), once
   * per runtime and reason: the caller logs and audits it
   * (`runtime.settings-invalid`).
   */
  onSettingsInvalid?(runtime: string, reason: string): void;
}

/** The record a fresh system, or a missing or tampered one, means (Q18, Q18b). */
export function builtInRuntimeRecord(registry: RuntimeRegistry): RuntimeSettingsRecord {
  return {
    v: 1,
    default: 'container',
    // The built-in runtimes; an added one is enabled by its own owner action (ARI §4.2).
    enabled: registry.list().filter((m) => m.descriptor.builtIn).map((m) => m.descriptor.id),
    settings: Object.fromEntries(registry.list().map((m) => [m.descriptor.id, settingsDefaults(m.descriptor.settingsSchema)])),
    overrides: {},
  };
}

export class RuntimeRegistry {
  private readonly modules = new Map<string, RuntimeModule>();
  private readonly reported = new Set<string>();

  constructor(private readonly opts: RuntimeRegistryOptions = {}) {}

  /**
   * Adds a runtime. Refused, with a `RuntimeModuleError` and its code: a
   * module whose ARI is above this kernel's ("runtime X needs ARI n"), an id
   * outside `RUNTIME_ID_PATTERN`, a descriptor without a semver version or a
   * settings version, and a second module with the same id.
   */
  register(module: RuntimeModule): void {
    const refused = ariRefusal(module.descriptor);
    if (refused) throw refused;
    const id = module.descriptor.id;
    if (this.modules.has(id)) throw new RuntimeModuleError('runtime-duplicate', id, `runtime ${id} is already registered`);
    this.modules.set(id, module);
  }

  list(): RuntimeModule[] { return [...this.modules.values()]; }

  get(id: string): RuntimeModule | undefined { return this.modules.get(id); }

  /** The module for a runtime id; unknown is the Q17 error. */
  require(id: string): RuntimeModule {
    const m = this.modules.get(id);
    if (!m) throw new RuntimeUnavailableError('runtime-not-installed', id);
    return m;
  }

  /** The runner of a latched runtime (an instance's `sandbox`). Unknown is the Q17 error. */
  runner(id: string): SandboxRunner {
    return this.require(id).runner;
  }

  isEnabled(id: string, record: RuntimeSettingsRecord): boolean {
    return Boolean(this.modules.get(id)?.descriptor.alwaysEnabled) || record.enabled.includes(id);
  }

  /**
   * A runtime's stored settings, completed with the schema's defaults (ARI
   * §4.3): settings written at an older `settingsVersion` go through the
   * module's `migrateSettings` first. Settings that fail to migrate or
   * validate are reported (once) and never replaced by guessed values: the
   * runtime is disabled with that error until the owner fixes its settings.
   * A missing or tampered record still means the built-in defaults.
   */
  settingsState(id: string, record: RuntimeSettingsRecord | null): RuntimeSettingsState {
    const m = this.require(id);
    const d = m.descriptor;
    const stored = record?.settings[id];
    if (stored === undefined) return { ok: true, settings: settingsDefaults(d.settingsSchema) };
    const from = record?.settingsVersions?.[id] ?? 1;
    try {
      let raw: unknown = stored;
      if (from !== d.settingsVersion) {
        if (from > d.settingsVersion) throw new RuntimeSettingsError(`they were written by a newer version (settings ${from}, this module reads ${d.settingsVersion})`);
        if (!m.migrateSettings) throw new RuntimeSettingsError(`no migration from settings version ${from} to ${d.settingsVersion}`);
        raw = m.migrateSettings(from, structuredClone(stored));
      }
      const settings = validateSettings(d.settingsSchema, raw);
      m.checkSettings?.(settings);
      return { ok: true, settings, ...(from !== d.settingsVersion ? { migratedFrom: from } : {}) };
    } catch (err) {
      const reason = `its settings failed to migrate: ${(err as Error).message}`;
      const key = `${id}\0${reason}`;
      if (!this.reported.has(key)) {
        this.reported.add(key);
        try { this.opts.onSettingsInvalid?.(id, reason); } catch { /* reporting never decides */ }
      }
      return { ok: false, reason };
    }
  }

  /** A runtime's valid settings; invalid ones are the `runtime-disabled` error (never guessed values). */
  settingsOf(id: string, record: RuntimeSettingsRecord | null): RuntimeSettings {
    const s = this.settingsState(id, record);
    if (!s.ok) throw new RuntimeUnavailableError('runtime-disabled', id, `runtime ${id} is disabled: ${s.reason}`);
    return s.settings;
  }

  /** The capabilities of a runtime under its current settings. */
  capabilitiesOf(id: string, record: RuntimeSettingsRecord | null): RuntimeCapabilities {
    return this.require(id).capabilities(this.settingsOf(id, record));
  }

  /**
   * A runtime's health under its current settings (ARI §2.3): the module's own
   * checks, or `unavailable` when its stored settings are invalid. One
   * mechanism: `resolve` refuses exactly what this reports as unavailable.
   */
  healthOf(id: string, record: RuntimeSettingsRecord | null, settings?: RuntimeSettings): RuntimeHealth {
    if (!settings) {
      const s = this.settingsState(id, record);
      if (!s.ok) return { status: 'unavailable', checks: [{ id: 'settings', ok: false, detail: s.reason }] };
      settings = s.settings;
    }
    return this.require(id).health(settings);
  }

  /**
   * The enabled, healthy runtimes whose capabilities meet `needs` (D73
   * `suggest`): for the message and the owner's decision only, never picked
   * automatically (Q17).
   */
  suggest(needs: Partial<RuntimeCapabilities>, record: RuntimeSettingsRecord | null, except?: string): string[] {
    if (!record) return [];
    const out: string[] = [];
    for (const m of this.modules.values()) {
      const id = m.descriptor.id;
      if (id === except || !this.isEnabled(id, record)) continue;
      const s = this.settingsState(id, record);
      if (!s.ok || healthRefusal(m.health(s.settings))) continue;
      if (missingCapabilities(m.capabilities(s.settings), needs).length === 0) out.push(id);
    }
    return out.sort();
  }

  /** The override that applies: the owner's always; a migration one only while the manifest names no runtime. */
  private overrideFor(manifest: RuntimeManifest, installationId: string, record: RuntimeSettingsRecord) {
    const o = record.overrides[installationId];
    return o && !(o.source === 'migration' && manifest.sandbox) ? o : undefined;
  }

  /** Which runtime an installation asks for, and why; before any check. */
  choose(input: Pick<ResolveInput, 'manifest' | 'installationId' | 'record'>): { runtime: string; source: RuntimeSource } {
    const { manifest, installationId, record } = input;
    if (!record || !installationId) {
      // Unknown overrides: only a runtime that cannot be disabled, named by the manifest, is still certain.
      const named = manifest.sandbox ? this.modules.get(manifest.sandbox) : undefined;
      if (named?.descriptor.alwaysEnabled) return { runtime: named.descriptor.id, source: 'manifest' };
      throw new RuntimeResolutionError('runtime-unresolved', manifest.id,
        `the runtime of ${manifest.id} cannot be decided: ${record ? 'its installation is not recorded yet' : 'the Runtime Settings cannot be read'}; try again`);
    }
    // D75 decisions and migration overrides are about what an omitted (or PRoot) `sandbox` meant before
    // the release. A manifest that now names another runtime (an app update, e.g. P1) decides by itself.
    const pending = record.pending?.[installationId];
    if (pending && (!manifest.sandbox || manifest.sandbox === 'proot')) {
      throw new RuntimeResolutionError('runtime-decision-needed', manifest.id,
        `runtime migration decision needed for ${manifest.id} (${pending.legacy === 'master-direct' ? 'it ran unwrapped in the master' : 'a closed app on PRoot'}): `
        + `\`aura runtime migrate --adopt-default ${manifest.id}\` (container, recommended) or \`--keep ${manifest.id} proot\` (open apps only)`);
    }
    const override = this.overrideFor(manifest, installationId, record);
    if (override) return { runtime: override.runtime, source: override.source };
    if (manifest.sandbox) return { runtime: manifest.sandbox, source: 'manifest' };
    return { runtime: record.default, source: 'default' };
  }

  /**
   * The runtime a start uses, checked: installed, enabled, available and
   * capable. Throws `RuntimeUnavailableError`, `RuntimeResolutionError` or
   * `RuntimeCapabilityError`; never falls back.
   */
  resolve(input: ResolveInput): ResolvedRuntime {
    const { runtime, source } = this.choose(input);
    const module = this.require(runtime);
    const record = input.record;
    if (record && !this.isEnabled(runtime, record)) throw new RuntimeUnavailableError('runtime-disabled', runtime);
    const override = input.installationId && record ? this.overrideFor(input.manifest, input.installationId, record) : undefined;
    const base = this.settingsOf(runtime, record);
    const settings = override?.settings && override.runtime === runtime ? { ...base, ...override.settings } : base;
    const why = healthRefusal(module.health(settings));
    if (why) throw new RuntimeUnavailableError('runtime-not-installed', runtime, `runtime ${runtime} is not available: ${why}`);
    const capabilities = module.capabilities(settings);
    const { needs } = requirementsOf(input.manifest, { sourceMode: input.sourceMode, ...(input.runAs ? { runAs: input.runAs } : {}) });
    const missing = missingCapabilities(capabilities, needs);
    if (missing.length) {
      const suggest = this.suggest(needs, record, runtime);
      throw new RuntimeCapabilityError(runtime, missing,
        `${input.manifest.id} cannot run on ${runtime}: missing ${missing.join(', ')}`
        + (missing.includes('readOnlyBinds') ? ' (a closed app needs enforced read-only binds, ARI-4)' : '')
        + (record ? suggestText(suggest) : ''), record ? suggest : undefined);
    }
    return { runtime, source, module, settings, capabilities };
  }
}
