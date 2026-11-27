/**
 * Runtime contract (ARI §2.3 subset, §9; Phase 5 Stage 1).
 *
 * A runtime is a string id (the manifest's `sandbox`), not a closed pair.
 * The kernel compares what a request needs with what the runtime declares
 * and fails closed on a miss: it never downgrades a request and never falls
 * back to another runtime (Q17). The registry, the settings store and the
 * resolver (stream R) are built on these types: registry.ts, settingsStore.ts.
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
  /**
   * The network model (informational in 5b: no request needs it). `shell-netns`:
   * the shell's own namespace (PRoot on the master); `bridge`: a sandbox on the
   * shared Docker network; `remote`: a provider elsewhere (designed, ARI §4.1).
   */
  network: RuntimeNetwork;
  /** Mounts the kernel-resolved App Home (`ResolvedHome`) at /home/aura (D65). */
  appHome: boolean;
  /** D65/D67/D74: the Private Home bound only in a session's own mount namespace. */
  privateHomeSession: boolean;
  /** D74: opens an isolated session inside the running environment (never a separate container). */
  sessionExec: boolean;
  /** D70: how logical uids reach processes. `none`: everything runs as root. */
  identity: 'none' | 'emulated' | 'enforced';
  /** Read-only binds are enforced (a closed source needs it; ARI-4). */
  readOnlyBinds: boolean;
  /**
   * D85 A4: runs on this host and can bind host paths. The provider-local
   * placement facts of a spawn (`appDir`, `instanceDataDir`, the tools dir,
   * `ResolvedHome.hostPath`) reach only a runtime that declares it.
   */
  hostFilesystem: boolean;
  /** Cross-app mounts (MountManager). */
  mounts: boolean;
  /** D80: writable cross-app mounts between different app uids through an idmapped bind (5b G probes it). */
  idmappedMounts: boolean;
  /** `ports` with `into` (PortManager). */
  portExpose: boolean;
  /** Manifest `services[]` and the sidecar routes. */
  sidecars: boolean;
  warmPool: boolean;
  /** Instances outlive a shell restart and are re-adopted (D77). */
  survivesShellRestart: boolean;
  /** Live resource usage per instance and sidecar (`usage`). */
  usage: boolean;
  /** Reserved: `false` everywhere until a runtime offers it. */
  gpu: boolean;
}

export type RuntimeNetwork = 'shell-netns' | 'bridge' | 'remote';

export type RuntimeCapability = keyof RuntimeCapabilities;

/**
 * Every capability, in display order: the one list the shell, the CLI and
 * Settings use (no copies). The `Record` makes it exhaustive at compile time.
 */
const CAPABILITY_ORDER: Record<RuntimeCapability, number> = {
  isolation: 0, network: 1, appHome: 2, privateHomeSession: 3, sessionExec: 4, identity: 5, readOnlyBinds: 6,
  hostFilesystem: 7, mounts: 8, idmappedMounts: 9, portExpose: 10, sidecars: 11, warmPool: 12,
  survivesShellRestart: 13, usage: 14, gpu: 15,
};
export const RUNTIME_CAPABILITY_KEYS: readonly RuntimeCapability[] = Object.freeze(
  (Object.keys(CAPABILITY_ORDER) as RuntimeCapability[]).sort((a, b) => CAPABILITY_ORDER[a] - CAPABILITY_ORDER[b]),
);
/** The capabilities a request needs as `true` (everything but the levels and the informational `network`). */
export const RUNTIME_BOOLEAN_CAPABILITIES: readonly RuntimeCapability[] = Object.freeze(
  RUNTIME_CAPABILITY_KEYS.filter((k) => k !== 'isolation' && k !== 'identity' && k !== 'network'),
);

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

/**
 * ARI §2.2: a request needs a capability the runtime does not declare. Never
 * downgraded and never auto-picked (Q17): `suggest` only names the enabled
 * runtimes that could run it (D73), for the message and the owner's decision.
 */
export class RuntimeCapabilityError extends Error {
  override readonly name = 'RuntimeCapabilityError';
  readonly code = 'capability-missing' as const;
  constructor(readonly runtime: string, readonly missing: RuntimeCapability[], message?: string, readonly suggest?: string[]) {
    super(message ?? `runtime ${runtime} cannot do this: missing ${missing.join(', ')}`);
  }
}

/**
 * A feature, or a part of one, the runtime can't enforce for this request
 * (D100 §17; D106 mandatory resource limits): refused, never silently
 * ignored, dropped or downgraded. `missing` names the parts
 * (`resources.limits.memoryBytes`), `suggest` the runtimes that enforce
 * them, `hint` what the owner can do (D105 shape).
 */
export class RuntimeFeatureError extends Error {
  override readonly name = 'RuntimeFeatureError';
  readonly code = 'feature-unsupported' as const;
  constructor(readonly runtime: string, readonly missing: string[], message: string, readonly suggest?: string[], readonly hint?: string) {
    super(message);
  }
}

/** The tail of a capability refusal: which enabled runtimes could run it, or that none can (D73). */
export function suggestText(suggest: readonly string[]): string {
  return suggest.length ? `; it could run on: ${suggest.join(', ')}` : '; no installed runtime can run it';
}

/** Why a runtime module is not registered (ARI §4.3): never loaded, so the Q17 error applies to its id. */
export type RuntimeModuleRefusalCode = 'ari-unsupported' | 'invalid-runtime-id' | 'invalid-descriptor' | 'runtime-duplicate';

export class RuntimeModuleError extends Error {
  override readonly name = 'RuntimeModuleError';
  constructor(readonly code: RuntimeModuleRefusalCode, readonly runtime: string, message: string) {
    super(message);
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
    // `network` is informational in 5b: nothing needs it, so nothing fails on it.
    if (want === undefined || key === 'network') continue;
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

/**
 * Every refusal of the runtime layer, as data (D97: the ARI boundary carries
 * records, and every refusal a `code`): what an API answers and an external
 * provider would send. Null for anything that is not a runtime refusal.
 */
export interface RuntimeRefusal {
  code: RuntimeRefusalCode;
  /** D100 §17: what a client may do about it. Clients read this, never the message text. */
  category: RuntimeErrorCategory;
  message: string;
  runtime?: string;
  appId?: string;
  /** Capabilities (`capability-missing`) or feature parts (`feature-unsupported`, e.g. `resources.limits.pids`). */
  missing?: Array<RuntimeCapability | string>;
  suggest?: string[];
  /** What the owner can do about it (D105). */
  hint?: string;
}

export function runtimeRefusal(err: unknown): RuntimeRefusal | null {
  if (err instanceof RuntimeCapabilityError) {
    return { code: err.code, category: CATEGORY_OF_CODE[err.code], message: err.message, runtime: err.runtime, missing: err.missing, ...(err.suggest ? { suggest: err.suggest } : {}) };
  }
  if (err instanceof RuntimeFeatureError) {
    return { code: err.code, category: CATEGORY_OF_CODE[err.code], message: err.message, runtime: err.runtime, missing: [...err.missing],
      ...(err.suggest ? { suggest: [...err.suggest] } : {}), ...(err.hint ? { hint: err.hint } : {}) };
  }
  if (err instanceof RuntimeUnavailableError || err instanceof RuntimeModuleError) {
    return { code: err.code, category: CATEGORY_OF_CODE[err.code], message: err.message, runtime: err.runtime };
  }
  if (err instanceof RuntimeResolutionError) return { code: err.code, category: CATEGORY_OF_CODE[err.code], message: err.message, appId: err.appId };
  return null;
}

/**
 * The standard error categories (D100 §17), so a client tells "not
 * authorized", "not supported", "temporary", "restart needed", "needs more
 * infrastructure" and "not applied yet" apart without parsing messages.
 */
export type RuntimeErrorCategory =
  | 'unsupported-operation' | 'unsupported-feature' | 'permission-denied' | 'runtime-unavailable'
  | 'instance-not-found' | 'resource-exhausted' | 'restart-required' | 'recreate-required'
  | 'provisioning-failed' | 'enforcement-failed' | 'operation-timeout' | 'operation-cancelled' | 'conflict';

/** Every code a runtime refusal or a failed operation carries. */
export type RuntimeRefusalCode =
  | RuntimeUnavailableCode | 'capability-missing' | RuntimeResolutionCode | RuntimeModuleRefusalCode
  | 'feature-unsupported' | 'instance-not-found' | 'provisioning-failed' | 'enforcement-failed' | 'restart-required' | 'operation-timeout';

/** The one table from a code to its category (a `Record`: exhaustive at compile time). */
export const CATEGORY_OF_CODE: Readonly<Record<RuntimeRefusalCode, RuntimeErrorCategory>> = Object.freeze({
  'capability-missing': 'unsupported-feature',
  'feature-unsupported': 'unsupported-feature',
  'runtime-not-installed': 'runtime-unavailable',
  'runtime-disabled': 'runtime-unavailable',
  'runtime-unresolved': 'runtime-unavailable',
  'runtime-decision-needed': 'conflict',
  'ari-unsupported': 'unsupported-operation',
  'invalid-runtime-id': 'unsupported-operation',
  'invalid-descriptor': 'unsupported-operation',
  'runtime-duplicate': 'conflict',
  'instance-not-found': 'instance-not-found',
  'provisioning-failed': 'provisioning-failed',
  'enforcement-failed': 'enforcement-failed',
  'restart-required': 'restart-required',
  'operation-timeout': 'operation-timeout',
});

/**
 * A process a runtime could not start or read in a workload (exec, logs;
 * 5b-2 D-X), by code: `not-found` (no such workload), `not-running`,
 * `engine` (the runtime's execution engine failed). The exec bridge maps the
 * code to its HTTP answer; callers read `code`, not the message.
 */
export type RuntimeExecErrorCode = 'not-found' | 'not-running' | 'engine';
export class RuntimeExecError extends Error {
  override readonly name: string = 'RuntimeExecError';
  constructor(readonly code: RuntimeExecErrorCode, message: string) { super(message); }
}

/** Where an installation's runtime came from (§11.2). */
export type RuntimeSource = 'manifest' | 'default' | 'override' | 'migration';

/**
 * D75: how an installation ran before the runtime release. `proot-master`:
 * wrapped in PRoot on the master; `master-direct`: unwrapped in the kernel's
 * own container (no `AURA_USE_PROOT`, `useProot: false` or no rootfs).
 */
export type LegacyRuntime = 'container' | 'proot-master' | 'master-direct';

/** ARI-3: one installation's runtime override, in `RuntimeSettingsRecord.overrides`. */
export interface RuntimeOverride {
  runtime: string;
  settings?: RuntimeSettings;
  source: 'migration' | 'override';
  recordedAt: string;
  /** D75: the legacy effective runtime a migration override keeps. */
  legacy?: LegacyRuntime;
  /** For display: the app the installation is of (the key stays the installation). */
  appId?: string;
}

/**
 * D75: an installation whose legacy runtime does not meet the mandatory
 * requirements. It does not start until the owner decides (`aura runtime
 * migrate`, Settings → Runtimes): no fallback, no silent switch.
 */
export interface RuntimeMigrationPending {
  appId: string;
  legacy: LegacyRuntime;
  /** Did the manifest name its runtime? */
  sandbox: 'explicit' | 'omitted';
  reason: 'master-direct' | 'closed-on-proot';
  recordedAt: string;
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
  /** D75: installations waiting for the owner's decision, by installation. */
  pending?: Record<string, RuntimeMigrationPending>;
  /** Migrations recorded in this record: `d75` is when the legacy runtimes were recorded. */
  migrations?: { d75?: string };
  /**
   * ARI §4.3: the `settingsVersion` each runtime's stored settings were
   * written at. Absent (a record from before 5b, or never written): 1. An
   * older one is migrated by the module on read; one that fails leaves the
   * runtime disabled with an error, never on guessed values.
   */
  settingsVersions?: Record<string, number>;
}

export type RuntimeResolutionCode = 'runtime-decision-needed' | 'runtime-unresolved';

/**
 * The runtime of a start cannot be decided: a D75 decision is open, or the
 * Runtime Settings or the installation cannot be read. Fails closed.
 */
export class RuntimeResolutionError extends Error {
  override readonly name = 'RuntimeResolutionError';
  constructor(readonly code: RuntimeResolutionCode, readonly appId: string, message: string) {
    super(message);
  }
}
