/**
 * Runtime contract (ARI §2.3 subset, §9; Phase 5 Stage 1).
 *
 * A runtime is a string id (the manifest's `sandbox`), not a closed pair.
 * The kernel compares what a request needs with what the runtime declares
 * and fails closed on a miss: it never downgrades a request and never falls
 * back to another runtime (Q17). Stream R builds the registry, the settings
 * store and the resolver on these types.
 */

/** A runtime id, and so a manifest `sandbox` value (ARI §2.1). */
export const RUNTIME_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

export type IsolationLevel = 'none' | 'ptrace' | 'namespace' | 'vm' | 'remote';

/**
 * What a runtime can do, as a function of its current settings (PRoot on the
 * master and PRoot in the pool differ). Declared honestly: the fail-closed
 * checks of Phase 5 gate on these flags, never on the runtime's id (ARI §9.5).
 */
export interface RuntimeCapabilities {
  isolation: IsolationLevel;
  /** D65/D67/D74: the Private Home bound only in a session's own mount namespace. */
  privateHomeSession: boolean;
  /** D74: opens an isolated session inside the running environment (never a separate container). */
  sessionExec: boolean;
  /** D70: how logical uids reach processes. `none`: everything runs as root. */
  identity: 'none' | 'emulated' | 'enforced';
  /** Read-only binds are enforced (a closed source needs it; ARI-4). */
  readOnlyBinds: boolean;
  /** Cross-app mounts (MountManager). */
  mounts: boolean;
  /** `ports` with `into` (PortManager). */
  portExpose: boolean;
  /** Manifest `services[]` and the sidecar routes. */
  sidecars: boolean;
  warmPool: boolean;
  /** Instances outlive a shell restart and are re-adopted (D77). */
  survivesShellRestart: boolean;
}

export type RuntimeCapability = keyof RuntimeCapabilities;

/** A runtime's settings object, validated against its schema by stream R. */
export type RuntimeSettings = Record<string, unknown>;

export type RuntimeUnavailableCode = 'runtime-not-installed' | 'runtime-disabled';

/** Q17: the runtime an app names (or the default) is unknown or disabled. No fallback. */
export class RuntimeUnavailableError extends Error {
  override readonly name = 'RuntimeUnavailableError';
  constructor(readonly code: RuntimeUnavailableCode, readonly runtime: string, message?: string) {
    super(message ?? (code === 'runtime-disabled'
      ? `runtime ${runtime} is disabled`
      : `runtime ${runtime} is not installed`));
  }
}

/** ARI §2.2: a request needs a capability the runtime does not declare. Never downgraded. */
export class RuntimeCapabilityError extends Error {
  override readonly name = 'RuntimeCapabilityError';
  readonly code = 'capability-missing' as const;
  constructor(readonly runtime: string, readonly missing: RuntimeCapability[], message?: string) {
    super(message ?? `runtime ${runtime} cannot do this: missing ${missing.join(', ')}`);
  }
}

/**
 * The capabilities `needs` asks for that `caps` lacks. A boolean need wants
 * `true`; an `identity` need wants that level or stronger; an `isolation` need
 * wants exactly that level or a listed stronger one.
 */
export function missingCapabilities(caps: RuntimeCapabilities, needs: Partial<RuntimeCapabilities>): RuntimeCapability[] {
  const IDENTITY = ['none', 'emulated', 'enforced'] as const;
  const ISOLATION: IsolationLevel[] = ['none', 'ptrace', 'namespace', 'vm'];
  const missing: RuntimeCapability[] = [];
  for (const [key, want] of Object.entries(needs) as Array<[RuntimeCapability, unknown]>) {
    if (want === undefined) continue;
    const have = caps[key];
    if (key === 'identity') {
      if (IDENTITY.indexOf(have as typeof IDENTITY[number]) < IDENTITY.indexOf(want as typeof IDENTITY[number])) missing.push(key);
    } else if (key === 'isolation') {
      // `remote` is its own model: it satisfies only a `remote` need.
      const ok = want === 'remote' ? have === 'remote'
        : have !== 'remote' && ISOLATION.indexOf(have as IsolationLevel) >= ISOLATION.indexOf(want as IsolationLevel);
      if (!ok) missing.push(key);
    } else if (want === true && have !== true) {
      missing.push(key);
    }
  }
  return missing;
}

/** Throws `RuntimeCapabilityError` when `caps` lacks anything `needs` asks for. */
export function requireCapabilities(runtime: string, caps: RuntimeCapabilities, needs: Partial<RuntimeCapabilities>): void {
  const missing = missingCapabilities(caps, needs);
  if (missing.length) throw new RuntimeCapabilityError(runtime, missing);
}

/** Where an installation's runtime came from (§11.2). */
export type RuntimeSource = 'manifest' | 'default' | 'override' | 'migration';

/** ARI-3: one installation's runtime override, in `RuntimeSettingsRecord.overrides`. */
export interface RuntimeOverride {
  runtime: string;
  settings?: RuntimeSettings;
  source: 'migration' | 'override';
  recordedAt: string;
  /** D75: the legacy effective runtime a migration override keeps. */
  legacy?: 'container' | 'proot-master' | 'master-direct';
}

/**
 * The sealed `user:policy:runtimes` record (ARI §9.7), stored in this shape
 * from the first release even while it has only `default` and
 * `proot.placement`. Keyed per installation, never per instance (D85 A7).
 */
export interface RuntimeSettingsRecord {
  v: 1;
  default: string;
  enabled: string[];
  settings: Record<string, RuntimeSettings>;
  overrides: Record<string, RuntimeOverride>;
}
