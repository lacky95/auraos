/**
 * ARI, the Aura Runtime Interface (Phase 5b, `ari-phase-draft.md` §2.3): the
 * contract between the kernel and a runtime module, as data.
 *
 * A leaf contract file (D97 `contract-leaf`): it imports no other core module
 * at runtime, only types, so a module, a test fake and later an
 * out-of-process provider can all implement it. Every shape that crosses the
 * boundary is plain data and JSON-serializable apart from streams: no `Map`,
 * no class instance; exits and usage are records; every refusal carries a
 * `code` (`RuntimeRefusal`, types.ts).
 *
 * **D93 G1, one emit site per fact.** A runtime reports an exit only through
 * `onExit`. The kernel turns it into `app:crashed` / `app:stateChanged`
 * (AppManager `handleUnexpectedExit` and the reconciler). No runtime module
 * imports `OsEventBus` (5b-2 makes this a dep-check rule, `runtime-no-bus`).
 *
 * Today's `SandboxRunner` (app-manager/SandboxRunner.ts) stays the
 * implementation interface behind the built-in modules (draft "minimal-change
 * note"). `AuraRuntime` is the runtime-facing whole; `RuntimeModule` is the
 * part the registry uses in this release, picked from it, so the two cannot
 * drift.
 */
import type { AppManifest } from '../types/manifest.js';
import type { ResourceUsage } from '../types/instance.js';
import type { ResolvedHome, JumpHomeMode } from '../homes/types.js';
import type { SpawnIdentity } from '../identity/types.js';
import type { SpawnContext } from '../scopes/types.js';
import type { SandboxRunner } from '../app-manager/SandboxRunner.js';
import type { SettingsSchema } from './settingsSchema.js';
import { RUNTIME_ID_PATTERN, RuntimeModuleError, type RuntimeCapabilities, type RuntimeSettings } from './types.js';

/** The contract major this kernel implements (ARI §4.3, like `auraContract`). */
export const ARI_VERSION = 1;

/** A module's own version: semver (`1.2.3`, optionally `-pre`). */
export const RUNTIME_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** What a runtime module declares about itself (ARI §2.1). Plain data: the Runtimes API serves it as is. */
export interface RuntimeDescriptor {
  /** The manifest's `sandbox` value (`RUNTIME_ID_PATTERN`). */
  id: string;
  /** The module's own version (semver). */
  version: string;
  /** The ARI major it implements; above `ARI_VERSION` it is refused at registration. */
  ari: number;
  title: string;
  description: string;
  builtIn: boolean;
  /** Never disabled, so an app naming it always resolves (`container`, ARI §4.4). */
  alwaysEnabled?: boolean;
  settingsSchema: SettingsSchema;
  /** The version of `settingsSchema`; stored settings of an older one go through `migrateSettings`. */
  settingsVersion: number;
}

/** A module's health (ARI §2.3). `unavailable` blocks every start on it (fail closed). */
export interface RuntimeHealth {
  status: 'ok' | 'degraded' | 'unavailable';
  checks: RuntimeHealthCheck[];
}
export interface RuntimeHealthCheck { id: string; ok: boolean; detail?: string }

/**
 * Where to dial an instance (D88: an object, so a replica list can be added
 * later without breaking callers; no replica field now). For dialing only,
 * never an identity (D89: identity is the workload token).
 */
export interface RuntimeEndpoint { host: string; port: number; address?: string }

/** A workload exit, as a record (G1: the kernel turns it into the events). */
export interface RuntimeExit { instanceId: string; code: number | null }

/** Live usage by instance id and sidecar id; ids the runtime cannot measure are absent. */
export type RuntimeUsage = Record<string, ResourceUsage>;

/** D89: the workload token of a start. Mandatory: every runtime injects it as `AURA_INSTANCE_TOKEN`. */
export interface WorkloadToken { token: string; nonce: string }

/**
 * Everything the kernel resolved for one start (ARI §2.3), as data. `appDir`,
 * `instanceDataDir` and `home.hostPath` are provider-local placement facts
 * (D85 A4): only a runtime with `hostFilesystem` receives them.
 */
export interface SpawnSpec extends SpawnContext {
  instanceId: string;
  appId: string;
  port: number;
  manifest: AppManifest;
  /** The user the instance is for; absent for warm-pool members. */
  owner?: string;
  instanceToken: WorkloadToken;
}

/**
 * A session inside a running instance (jump, interactive exec; D67, D74),
 * built by the kernel (AppManager `sessionContext`) and only executed by the
 * runtime, which fails closed on anything it can't enforce.
 */
export interface SessionSpec {
  sessionId: string;
  instanceId: string;
  /** `user`: the user's identity (private, ephemeral); `app`: the app's (D79); `root`: a root tab (J.6). */
  kind: 'user' | 'app' | 'root';
  home: { mode: JumpHomeMode; hostPath: string | null };
  uid: number;
  gid: number;
  groups: number[];
  env: Record<string, string>;
  cwd?: string;
  argv: string[];
  tty: boolean;
  cols: number;
  rows: number;
  /** The session's /etc/passwd and /etc/group, bound in its mount namespace only. */
  passwd?: string;
  group?: string;
  /** A root tab only: the Docker socket and CLI in the session's namespace (J.6). */
  dockerSocket?: boolean;
  /** The human user the session acts for (audit, the session table). */
  userId?: string;
}

/** The identity a runtime realises for a workload (D70): logical ids, mapped by the runtime. */
export type RuntimeIdentity = SpawnIdentity;
export type { ResolvedHome };

/**
 * The whole runtime contract (draft §2.3). Optional members are gated by the
 * matching capability: an optional group is present exactly when its
 * capability is true (5b CR checks it at registration).
 */
export interface AuraRuntime {
  readonly descriptor: RuntimeDescriptor;
  capabilities(settings: RuntimeSettings): RuntimeCapabilities;

  // Module lifecycle (no-ops for the built-ins).
  /** Upgrades stored settings written at `from` < `descriptor.settingsVersion`. Throws when it can't. */
  migrateSettings?(from: number, raw: unknown): unknown;
  enable?(settings: RuntimeSettings): Promise<void>;
  /** Only called with zero live instances. */
  disable?(): Promise<void>;
  /** Whether new settings affect running instances (they apply at the next start otherwise). */
  applySettings?(next: RuntimeSettings, prev: RuntimeSettings): Promise<{ affectsRunning: boolean }>;
  health(settings: RuntimeSettings): RuntimeHealth;

  // Instances.
  spawn(spec: SpawnSpec): Promise<{ pid: number | null }>;
  stop(instanceId: string): Promise<void>;
  forceKill(instanceId: string): boolean;
  isRunning(instanceId: string): boolean;
  endpoint(instanceId: string): RuntimeEndpoint | null;
  onExit(instanceId: string, cb: (exit: RuntimeExit) => void): void;
  activePids(): number[];

  // Optional, gated by capabilities.
  exec?(instanceId: string, argv: string[], opts?: { env?: Record<string, string>; timeoutMs?: number }): Promise<{ stdout: string; stderr: string }>;
  /** `usage` */
  usage?(req: { instanceIds: string[]; sidecarIds: string[] }): Promise<RuntimeUsage>;
}

/**
 * A runtime module as the registry holds it in this release: the contract's
 * descriptor, capabilities, health, endpoint and lifecycle hooks, over
 * today's `SandboxRunner` for the instance operations (5b CR/PR move the
 * built-ins into `runtimes/<id>/` behind full `AuraRuntime` adapters).
 */
export interface RuntimeModule extends Pick<AuraRuntime,
  'descriptor' | 'capabilities' | 'health' | 'endpoint' | 'migrateSettings' | 'enable' | 'disable' | 'applySettings'> {
  readonly runner: SandboxRunner;
  /** Extra checks on top of the schema (e.g. a placement this release cannot run). Throws `RuntimeSettingsError`. */
  checkSettings?(settings: RuntimeSettings): void;
}

/** The health of a module that has nothing to check: always ok. */
export const HEALTHY: RuntimeHealth = Object.freeze({ status: 'ok', checks: [] }) as RuntimeHealth;

/** Why a health blocks starts (`unavailable`), joined from its failed checks; null when it does not. */
export function healthRefusal(h: RuntimeHealth): string | null {
  if (h.status !== 'unavailable') return null;
  const failed = h.checks.filter((c) => !c.ok).map((c) => c.detail ?? c.id);
  return failed.length ? failed.join('; ') : 'unavailable';
}

/**
 * The ARI refusal (ARI §4.3): a module this kernel must not load, as a
 * `RuntimeModuleError` with a code, or null. An `ari` above `ARI_VERSION` is
 * "runtime X needs ARI n"; an id outside `RUNTIME_ID_PATTERN`, a version that
 * is not semver or a settings version below 1 is an invalid descriptor.
 */
export function ariRefusal(d: Pick<RuntimeDescriptor, 'id' | 'version' | 'ari' | 'settingsVersion'>): RuntimeModuleError | null {
  const id = typeof d.id === 'string' ? d.id : String(d.id);
  if (!RUNTIME_ID_PATTERN.test(id)) return new RuntimeModuleError('invalid-runtime-id', id, `runtime id ${JSON.stringify(id)} is not valid (${RUNTIME_ID_PATTERN})`);
  if (!Number.isInteger(d.ari) || d.ari < 1) return new RuntimeModuleError('invalid-descriptor', id, `runtime ${id} declares no valid ARI version`);
  if (d.ari > ARI_VERSION) return new RuntimeModuleError('ari-unsupported', id, `runtime ${id} needs ARI ${d.ari} (this AuraOS implements ARI ${ARI_VERSION})`);
  if (typeof d.version !== 'string' || !RUNTIME_VERSION_PATTERN.test(d.version)) return new RuntimeModuleError('invalid-descriptor', id, `runtime ${id} has no semver version`);
  if (!Number.isInteger(d.settingsVersion) || d.settingsVersion < 1) return new RuntimeModuleError('invalid-descriptor', id, `runtime ${id} has no valid settings version`);
  return null;
}

/** An instance's endpoint from today's runner surface (`getHost`/`getPort`/`addresses`). */
export function runnerEndpoint(runner: Pick<SandboxRunner, 'getHost' | 'getPort' | 'addresses'>, instanceId: string): RuntimeEndpoint | null {
  const host = runner.getHost(instanceId);
  const port = runner.getPort(instanceId);
  if (host === null || port === null) return null;
  const address = runner.addresses?.(instanceId)?.[0];
  return { host, port, ...(address ? { address } : {}) };
}
