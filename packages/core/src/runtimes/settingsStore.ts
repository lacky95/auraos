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
import type { Redis } from '@aura/kv-store';
import { SealedPolicyRecord } from '../security/SealedPolicyRecord.js';
import { builtInRuntimeRecord, type RuntimeRegistry } from './registry.js';
import { RuntimeSettingsError, validateSettings } from './settingsSchema.js';
import {
  RUNTIME_ID_PATTERN, type RuntimeMigrationPending, type RuntimeOverride, type RuntimeSettingsRecord,
} from './types.js';

export const RUNTIME_POLICY_KEY = 'user:policy:runtimes';

/** The audit actions (written by the route or the kernel). */
export const RUNTIME_AUDIT_ACTIONS = {
  settingsChanged: 'runtime.settings-changed',
  enabled: 'runtime.enabled',
  disabled: 'runtime.disabled',
  defaultChanged: 'runtime.default-changed',
  overrideRemoved: 'runtime.override-removed',
  migrationDecided: 'runtime.migration-decided',
  migrationRecorded: 'runtime.migration-recorded',
  policyTampered: 'runtime.policy-tampered',
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
  return raw as unknown as RuntimeSettingsRecord;
}

/** Deterministic JSON (keys sorted at every level), so the MAC never depends on key order. */
function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (isObj(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])]));
  return v;
}
const canonical = (r: RuntimeSettingsRecord) => JSON.stringify([RUNTIME_POLICY_KEY, 1, stable(r)]);

export type RuntimeChange<T = undefined> =
  | { ok: true; changed: boolean; previous: RuntimeSettingsRecord; record: RuntimeSettingsRecord; result: T }
  | { ok: false; reason: 'conflict' };

export class RuntimeChangeError extends Error {
  override readonly name = 'RuntimeChangeError';
  constructor(
    readonly code: 'unknown-runtime' | 'not-enabled' | 'cannot-disable' | 'invalid-settings' | 'not-found' | 'invalid-decision',
    message: string,
  ) { super(message); }
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

  /** `container` and the default can't be disabled (ARI §4.4). Running instances are the caller's check. */
  setEnabled(id: string, on: boolean): Promise<RuntimeChange> {
    return this.update((cur) => {
      this.known(id);
      if (!on && this.registry.get(id)!.descriptor.alwaysEnabled) throw new RuntimeChangeError('cannot-disable', `runtime ${id} cannot be disabled`);
      if (!on && cur.default === id) throw new RuntimeChangeError('cannot-disable', `runtime ${id} is the default; choose another default first`);
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
        settings = validateSettings(module.descriptor.settingsSchema, { ...this.registry.settingsOf(id, cur), ...(isObj(input) ? input : {}) });
        if (!isObj(input)) throw new RuntimeSettingsError('settings must be an object');
        module.checkSettings?.(settings);
      } catch (err) {
        if (err instanceof RuntimeSettingsError) throw new RuntimeChangeError('invalid-settings', err.message);
        throw err;
      }
      return { next: { ...cur, settings: { ...cur.settings, [id]: settings } } };
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
