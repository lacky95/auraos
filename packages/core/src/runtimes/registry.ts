/**
 * The runtime registry (ARI §9.1, §9.2, §9.9; Phase 5 stream R): runtimes by
 * string id, and the one resolver that picks an app's runtime. Replaces the
 * closed `Record<'proot'|'container'>` and its silent PRoot fallbacks.
 *
 * Resolution, first match wins (ARI §5.3, §11.2):
 *   1. a per-installation override (ARI-3) or D75 migration override (a
 *      migration override keeps what an omitted `sandbox` meant, so it
 *      lapses once the manifest names a runtime);
 *   2. the manifest's `sandbox`;
 *   3. the Runtime Settings default.
 * An open D75 decision stops it (`runtime-decision-needed`). Then the runtime
 * must be installed, enabled and available, and must have every capability
 * the app needs (derived from its manifest, ARI §5.3). Every miss is a clear
 * error; nothing falls back to another runtime (Q17), and `useProot` is
 * never read.
 */
import type { AppManifest } from '../types/manifest.js';
import type { SandboxRunner } from '../app-manager/SandboxRunner.js';
import { settingsDefaults, validateSettings, type SettingsSchema } from './settingsSchema.js';
import {
  missingCapabilities, RuntimeCapabilityError, RuntimeResolutionError, RuntimeUnavailableError,
  type RuntimeCapabilities, type RuntimeSettings, type RuntimeSettingsRecord, type RuntimeSource,
} from './types.js';

/** What a runtime module declares (ARI §2.1, the Phase 5 subset). */
export interface RuntimeDescriptor {
  id: string;
  title: string;
  description: string;
  builtIn: boolean;
  /** Never disabled, so an app naming it always resolves (`container`, ARI §4.4). */
  alwaysEnabled?: boolean;
  settingsSchema: SettingsSchema;
}

export interface RuntimeModule {
  readonly descriptor: RuntimeDescriptor;
  readonly runner: SandboxRunner;
  capabilities(settings: RuntimeSettings): RuntimeCapabilities;
  /** Why the runtime cannot run anything under these settings now, or null. Fails closed. */
  unavailable(settings: RuntimeSettings): string | null;
  /** Extra checks on top of the schema (e.g. a placement this release cannot run). Throws. */
  checkSettings?(settings: RuntimeSettings): void;
}

/** The manifest fields the needs are derived from. */
export type RuntimeManifest = Pick<AppManifest, 'id' | 'sandbox' | 'services' | 'ports' | 'warmPool'>;

/**
 * The capabilities an app needs, from its manifest (ARI §5.3; no new manifest
 * field, D57): `services[]` needs sidecars, `ports.exposes` port expose, a
 * warm pool the warm pool, and a closed source enforced read-only binds
 * (ARI-4: a closed app never runs where its source would be writable).
 */
export function runtimeNeeds(m: RuntimeManifest, sourceMode: 'open' | 'closed'): Partial<RuntimeCapabilities> {
  const needs: Partial<RuntimeCapabilities> = {};
  if (m.services?.length) needs.sidecars = true;
  if (m.ports?.exposes?.length) needs.portExpose = true;
  if (m.warmPool > 0) needs.warmPool = true;
  if (sourceMode === 'closed') needs.readOnlyBinds = true;
  return needs;
}

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

  /** Adds a runtime. Ids are unique; a second one with the same id is refused. */
  register(module: RuntimeModule): void {
    const id = module.descriptor.id;
    if (this.modules.has(id)) throw new Error(`runtime ${id} is already registered`);
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

  /** A runtime's stored settings, completed with the schema's defaults. */
  settingsOf(id: string, record: RuntimeSettingsRecord | null): RuntimeSettings {
    const m = this.require(id);
    try { return validateSettings(m.descriptor.settingsSchema, record?.settings[id] ?? {}); }
    catch { return settingsDefaults(m.descriptor.settingsSchema); }
  }

  /** The capabilities of a runtime under its current settings. */
  capabilitiesOf(id: string, record: RuntimeSettingsRecord | null): RuntimeCapabilities {
    return this.require(id).capabilities(this.settingsOf(id, record));
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
    const settings = override?.settings && override.runtime === runtime
      ? { ...this.settingsOf(runtime, record), ...override.settings }
      : this.settingsOf(runtime, record);
    const why = module.unavailable(settings);
    if (why) throw new RuntimeUnavailableError('runtime-not-installed', runtime, `runtime ${runtime} is not available: ${why}`);
    const capabilities = module.capabilities(settings);
    const missing = missingCapabilities(capabilities, runtimeNeeds(input.manifest, input.sourceMode));
    if (missing.length) {
      throw new RuntimeCapabilityError(runtime, missing,
        `${input.manifest.id} cannot run on ${runtime}: missing ${missing.join(', ')}`
        + (missing.includes('readOnlyBinds') ? ' (a closed app needs enforced read-only binds, ARI-4)' : ''));
    }
    return { runtime, source, module, settings, capabilities };
  }
}
