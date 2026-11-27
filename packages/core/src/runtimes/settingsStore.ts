/**
 * The Runtime Settings (ARI §9.7): one sealed owner record at
 * `user:policy:runtimes` (D64 entry `runtimes`), on the shared
 * SealedPolicyRecord. A missing record, or one that fails its MAC, means the
 * built-in defaults (container the default, PRoot on the master), reported
 * once like `user:policy:security`. A Valkey error throws: the caller fails
 * closed (registry.ts).
 *
 * Who may change it (the owner at `fresh`, or the host operator) and the
 * audit entry are the caller's (the shell's `/api/admin/runtimes`). Every
 * write is a compare-and-set, so a concurrent change is never overwritten.
 */
import { createHash } from 'node:crypto';
import type { Redis } from '@aura/kv-store';
import { requirementsOf, type RequirementsInstallation, type RequirementsManifest } from './requirements.js';
import { SealedPolicyRecord } from '../security/SealedPolicyRecord.js';
import { builtInRuntimeRecord, type RuntimeRegistry } from './registry.js';
import { RuntimeSettingsError, settingsDefaults, validateSettings } from './settingsSchema.js';
import { healthRefusal } from './ari.js';
import {
  missingCapabilities, RUNTIME_ID_PATTERN, suggestText,
  type RuntimeCapability, type RuntimeMigrationPending, type RuntimeOverride, type RuntimeSettings, type RuntimeSettingsRecord,
} from './types.js';

export const RUNTIME_POLICY_KEY = 'user:policy:runtimes';

/** The audit actions (written by the route or the kernel). */
export const RUNTIME_AUDIT_ACTIONS = {
  settingsChanged: 'runtime.settings-changed',
  enabled: 'runtime.enabled',
  disabled: 'runtime.disabled',
  defaultChanged: 'runtime.default-changed',
  /** ARI-3: the owner set (or replaced) one installation's runtime override. */
  overrideSet: 'runtime.override-set',
  overrideRemoved: 'runtime.override-removed',
  migrationDecided: 'runtime.migration-decided',
  migrationRecorded: 'runtime.migration-recorded',
  policyTampered: 'runtime.policy-tampered',
  /** ARI §4.3: a runtime's stored settings failed to migrate; it is disabled until they are fixed (kernel, once). */
  settingsInvalid: 'runtime.settings-invalid',
  /** ARI §4.3: a runtime module was refused at registration (ARI version, id, descriptor; kernel). */
  moduleRefused: 'runtime.module-refused',
} as const;

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const isId = (v: unknown): v is string => typeof v === 'string' && RUNTIME_ID_PATTERN.test(v);
const LEGACY = ['container', 'proot-master', 'master-direct'];

function parseOverride(v: unknown): RuntimeOverride | null {
  if (!isObj(v) || !isId(v['runtime']) || (v['source'] !== 'migration' && v['source'] !== 'override')) return null;
  if (typeof v['recordedAt'] !== 'string') return null;
  if (v['settings'] !== undefined && !isObj(v['settings'])) return null;
  if (v['legacy'] !== undefined && !LEGACY.includes(v['legacy'] as string)) return null;
  if (v['appId'] !== undefined && typeof v['appId'] !== 'string') return null;
  return v as unknown as RuntimeOverride;
}

function parsePending(v: unknown): RuntimeMigrationPending | null {
  if (!isObj(v) || typeof v['appId'] !== 'string' || !LEGACY.includes(v['legacy'] as string)) return null;
  if (v['sandbox'] !== 'explicit' && v['sandbox'] !== 'omitted') return null;
  if (v['reason'] !== 'master-direct' && v['reason'] !== 'closed-on-proot') return null;
  if (typeof v['recordedAt'] !== 'string') return null;
  return v as unknown as RuntimeMigrationPending;
}

/** A stored record's shape, or null. Values are checked against the registry when used. */
export function parseRuntimeRecord(raw: unknown): RuntimeSettingsRecord | null {
  if (!isObj(raw) || raw['v'] !== 1 || !isId(raw['default'])) return null;
  if (!Array.isArray(raw['enabled']) || !raw['enabled'].every(isId)) return null;
  if (!isObj(raw['settings']) || !Object.values(raw['settings']).every(isObj)) return null;
  if (!isObj(raw['overrides']) || !Object.values(raw['overrides']).every((o) => parseOverride(o))) return null;
  if (raw['pending'] !== undefined && (!isObj(raw['pending']) || !Object.values(raw['pending']).every((p) => parsePending(p)))) return null;
  if (raw['migrations'] !== undefined && (!isObj(raw['migrations'])
    || (raw['migrations']['d75'] !== undefined && typeof raw['migrations']['d75'] !== 'string'))) return null;
  if (raw['settingsVersions'] !== undefined && (!isObj(raw['settingsVersions'])
    || !Object.values(raw['settingsVersions']).every((n) => Number.isInteger(n) && (n as number) >= 1))) return null;
  return raw as unknown as RuntimeSettingsRecord;
}

/** Deterministic JSON (keys sorted at every level), so the MAC never depends on key order. */
function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (isObj(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])]));
  return v;
}
const canonical = (r: RuntimeSettingsRecord) => JSON.stringify([RUNTIME_POLICY_KEY, 1, stable(r)]);

/**
 * A short revision of a runtime's effective settings (5b S): latched on an
 * instance at spawn (`AppInstance.runtimeSettingsRev`), so the Runtimes page
 * can say how many instances still run on older settings. Key order never
 * changes it.
 */
export function runtimeSettingsRevision(settings: RuntimeSettings): string {
  return createHash('sha256').update(JSON.stringify(stable(settings))).digest('hex').slice(0, 12);
}

export type RuntimeChange<T = undefined> =
  | { ok: true; changed: boolean; previous: RuntimeSettingsRecord; record: RuntimeSettingsRecord; result: T }
  | { ok: false; reason: 'conflict' };

export type RuntimeChangeCode =
  | 'unknown-runtime' | 'not-enabled' | 'cannot-disable' | 'invalid-settings' | 'not-found' | 'invalid-decision'
  /** ARI-3: the installation cannot run on the runtime an override names (with `missing` and `suggest`, D73). */
  | 'capability-missing'
  /** ARI-3: a D75 decision is open for the installation: `aura runtime migrate` decides it first. */
  | 'decision-open'
  /** The record changed after the owner approved the change (compare-and-set on what was shown). */
  | 'conflict';

export class RuntimeChangeError extends Error {
  override readonly name = 'RuntimeChangeError';
  constructor(
    readonly code: RuntimeChangeCode,
    message: string,
    readonly missing?: RuntimeCapability[],
    readonly suggest?: string[],
  ) { super(message); }
}

/** The installation an owner override is for (ARI-3), with the facts its requirements are derived from. */
export interface OverrideTarget extends RequirementsInstallation {
  installationId: string;
  appId: string;
  manifest: RequirementsManifest;
}

/**
 * ARI-3: may `target` get an owner override to `runtime` under `cur`? The
 * one check, used for the dry run before the owner is asked and inside the
 * write (`setOverride`); `registry.resolve` checks the same at every start.
 * Throws `RuntimeChangeError`: `unknown-runtime`, `not-enabled` (disabled,
 * invalid stored settings or unavailable), `invalid-settings`,
 * `decision-open` (a D75 decision is decided by `aura runtime migrate`, so
 * the record never holds both) and `capability-missing` with `missing` and
 * `suggest` (D73: named, never picked).
 */
export function checkOverride(
  registry: RuntimeRegistry, cur: RuntimeSettingsRecord, target: OverrideTarget, runtime: string, settings?: RuntimeSettings,
): void {
  if (cur.pending?.[target.installationId]) {
    throw new RuntimeChangeError('decision-open',
      `${target.appId} waits for its runtime migration decision: \`aura runtime migrate --adopt-default ${target.appId}\` or \`--keep ${target.appId} <runtime>\` first`);
  }
  const module = registry.get(runtime);
  if (!module) throw new RuntimeChangeError('unknown-runtime', `runtime ${runtime} is not installed`);
  if (!registry.isEnabled(runtime, cur)) throw new RuntimeChangeError('not-enabled', `runtime ${runtime} is disabled; enable it first`);
  const base = registry.settingsState(runtime, cur);
  if (!base.ok) throw new RuntimeChangeError('not-enabled', `runtime ${runtime} is disabled: ${base.reason}`);
  let effective: RuntimeSettings;
  try {
    if (settings !== undefined && !isObj(settings)) throw new RuntimeSettingsError('settings must be an object');
    effective = validateSettings(module.descriptor.settingsSchema, { ...base.settings, ...settings });
    module.checkSettings?.(effective);
  } catch (err) {
    if (err instanceof RuntimeSettingsError) throw new RuntimeChangeError('invalid-settings', err.message);
    throw err;
  }
  const down = healthRefusal(module.health(effective));
  if (down) throw new RuntimeChangeError('not-enabled', `runtime ${runtime} is not available: ${down}`);
  const { needs } = requirementsOf(target.manifest, { sourceMode: target.sourceMode, ...(target.runAs ? { runAs: target.runAs } : {}) });
  const missing = missingCapabilities(module.capabilities(effective), needs);
  if (missing.length) {
    const suggest = registry.suggest(needs, cur, runtime);
    throw new RuntimeChangeError('capability-missing',
      `${target.appId} cannot run on ${runtime}: missing ${missing.join(', ')}`
      + (missing.includes('readOnlyBinds') ? ' (a closed app needs enforced read-only binds, ARI-4)' : '') + suggestText(suggest),
      missing, suggest);
  }
}

export interface RuntimeSettingsStoreOptions {
  identityKeyFile: string;
  redis: () => Redis;
  registry: RuntimeRegistry;
  onTampered?: () => void;
}

export class RuntimeSettingsStore {
  private readonly record: SealedPolicyRecord<RuntimeSettingsRecord>;
  private readonly registry: RuntimeRegistry;

  constructor(opts: RuntimeSettingsStoreOptions) {
    this.registry = opts.registry;
    this.record = new SealedPolicyRecord<RuntimeSettingsRecord>({
      key: RUNTIME_POLICY_KEY, purpose: 'runtime-policy',
      identityKeyFile: opts.identityKeyFile, redis: opts.redis,
      parse: parseRuntimeRecord, canonical,
      ...(opts.onTampered ? { onTampered: opts.onTampered } : {}),
    });
  }

  /** The record (built-in defaults when missing or tampered) and whether one is stored and trusted. */
  async read(): Promise<{ record: RuntimeSettingsRecord; stored: string | null; trusted: boolean }> {
    const { value, stored } = await this.record.read();
    return { record: value ?? builtInRuntimeRecord(this.registry), stored, trusted: value !== null };
  }

  async get(): Promise<RuntimeSettingsRecord> {
    return (await this.read()).record;
  }

  /**
   * Apply `mutate` to the current record and write it by compare-and-set.
   * `mutate` returns the next record (or the same object for no change) and
   * may throw `RuntimeChangeError` to refuse.
   */
  async update<T = undefined>(mutate: (cur: RuntimeSettingsRecord) => { next: RuntimeSettingsRecord; result?: T }): Promise<RuntimeChange<T>> {
    this.record.assertKey();
    const { record: previous, stored } = await this.read();
    const { next, result } = mutate(structuredClone(previous));
    const changed = canonical(next) !== canonical(previous);
    if (changed && !(await this.record.compareAndSet(stored, next))) return { ok: false, reason: 'conflict' };
    return { ok: true, changed, previous, record: changed ? next : previous, result: result as T };
  }

  private known(id: string): void {
    if (!this.registry.get(id)) throw new RuntimeChangeError('unknown-runtime', `runtime ${id} is not installed`);
  }

  /** The default for apps that name no runtime. It must be installed and enabled. */
  setDefault(id: string): Promise<RuntimeChange> {
    return this.update((cur) => {
      this.known(id);
      if (!this.registry.isEnabled(id, cur)) throw new RuntimeChangeError('not-enabled', `runtime ${id} is disabled; enable it first`);
      return { next: { ...cur, default: id } };
    });
  }

  /** Why `id` can't be disabled under `cur` (ARI §4.4: `container` and the default), or null. */
  disableRefusal(id: string, cur: RuntimeSettingsRecord): RuntimeChangeError | null {
    this.known(id);
    if (this.registry.get(id)!.descriptor.alwaysEnabled) return new RuntimeChangeError('cannot-disable', `runtime ${id} cannot be disabled`);
    if (cur.default === id) return new RuntimeChangeError('cannot-disable', `runtime ${id} is the default; choose another default first`);
    return null;
  }

  /** `container` and the default can't be disabled (disableRefusal). Running instances are the caller's check. */
  setEnabled(id: string, on: boolean): Promise<RuntimeChange> {
    return this.update((cur) => {
      this.known(id);
      const refusal = on ? null : this.disableRefusal(id, cur);
      if (refusal) throw refusal;
      const enabled = on ? [...new Set([...cur.enabled, id])] : cur.enabled.filter((e) => e !== id);
      return { next: { ...cur, enabled } };
    });
  }

  /** Validated against the runtime's schema; unknown keys and bad values are refused. */
  setSettings(id: string, input: unknown): Promise<RuntimeChange> {
    return this.update((cur) => {
      this.known(id);
      const module = this.registry.get(id)!;
      let settings;
      try {
        // Settings that failed to migrate are replaced, never merged into (ARI §4.3).
        const state = this.registry.settingsState(id, cur);
        const base = state.ok ? state.settings : settingsDefaults(module.descriptor.settingsSchema);
        settings = validateSettings(module.descriptor.settingsSchema, { ...base, ...(isObj(input) ? input : {}) });
        if (!isObj(input)) throw new RuntimeSettingsError('settings must be an object');
        module.checkSettings?.(settings);
      } catch (err) {
        if (err instanceof RuntimeSettingsError) throw new RuntimeChangeError('invalid-settings', err.message);
        throw err;
      }
      // Written at the module's settings version, so the next read needs no migration (absent means 1).
      const v = module.descriptor.settingsVersion;
      const next: RuntimeSettingsRecord = { ...cur, settings: { ...cur.settings, [id]: settings } };
      if ((cur.settingsVersions?.[id] ?? 1) !== v) next.settingsVersions = { ...cur.settingsVersions, [id]: v };
      return { next };
    });
  }

  /**
   * ARI-3: the owner's runtime for one installation (`source: 'override'`),
   * winning over the manifest and the default; it replaces a migration
   * override. Capability-checked now, as a dry run of the start through the
   * one derivation (`requirementsOf`), and again at every start
   * (`registry.resolve`): an override never bypasses a capability (D75).
   * Refused: an unknown or disabled runtime, settings its schema refuses, an
   * unavailable runtime, a capability miss (`capability-missing` with
   * `suggest`, never auto-picked) and an open D75 decision (decided by `aura
   * runtime migrate`, so the record never holds both). `expected` is the
   * override's runtime the owner saw (null: none); a different one is a
   * `conflict`. Settings are stored as given (validated merged over the
   * runtime's own, like `resolve` merges them).
   */
  setOverride(
    target: OverrideTarget, runtime: string, opts: { settings?: RuntimeSettings; expected?: string | null; now?: () => Date } = {},
  ): Promise<RuntimeChange<{ override: RuntimeOverride; previous: RuntimeOverride | null }>> {
    return this.update((cur) => {
      const previous = cur.overrides[target.installationId] ?? null;
      if (opts.expected !== undefined && (previous?.runtime ?? null) !== opts.expected) {
        throw new RuntimeChangeError('conflict', `the runtime override of ${target.appId} changed meanwhile (now ${previous?.runtime ?? 'none'}); try again`);
      }
      checkOverride(this.registry, cur, target, runtime, opts.settings);
      const override: RuntimeOverride = {
        runtime, source: 'override', recordedAt: (opts.now ?? (() => new Date()))().toISOString(), appId: target.appId,
        ...(opts.settings && Object.keys(opts.settings).length ? { settings: { ...opts.settings } } : {}),
      };
      // The same choice again changes nothing (no new timestamp, no audit).
      if (previous && previous.source === 'override' && previous.runtime === runtime
        && JSON.stringify(stable(previous.settings ?? {})) === JSON.stringify(stable(override.settings ?? {}))) {
        return { next: cur, result: { override: previous, previous } };
      }
      return { next: { ...cur, overrides: { ...cur.overrides, [target.installationId]: override } }, result: { override, previous } };
    });
  }

  /** Removes one installation's override (migration or owner); the next start resolves without it. */
  removeOverride(installationId: string): Promise<RuntimeChange<RuntimeOverride>> {
    return this.update<RuntimeOverride>((cur) => {
      const o = cur.overrides[installationId];
      if (!o) throw new RuntimeChangeError('not-found', 'no runtime override for this installation');
      const overrides = { ...cur.overrides };
      delete overrides[installationId];
      return { next: { ...cur, overrides }, result: o };
    });
  }
}
