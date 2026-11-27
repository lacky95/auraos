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
import type { SidecarInfo } from '../types/instance.js';
import type { LifecycleStatus } from '../app-manager/lifecycleGate.js';
import type { ResolvedSidecarSpec } from '../app-manager/sidecar-spec.js';
import {
  CATEGORY_OF_CODE, RUNTIME_ID_PATTERN, RuntimeModuleError,
  type RuntimeCapabilities, type RuntimeRefusal, type RuntimeRefusalCode, type RuntimeSettings,
} from './types.js';

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

// ─── Features (D100 §12): a derived, declared view ─────────────────────────

/**
 * Every feature id of D100 §12, in display order. The `Record` makes the
 * list exhaustive at compile time, like `CAPABILITY_ORDER`.
 */
const FEATURE_ORDER = {
  'instance.lifecycle': 0, 'instance.adoption': 1, 'instance.warmPool': 2,
  'execution.command': 3, 'execution.interactive': 4, 'execution.processControl': 5,
  'tools.provision': 6, 'tools.liveGrant': 7, 'tools.liveRevoke': 8, 'tools.inheritance': 9,
  'storage.privateHome': 10, 'storage.sharedHome': 11, 'storage.persistent': 12,
  'mount.attach': 13, 'mount.detach': 14, 'mount.live': 15, 'mount.inheritance': 16,
  'workload.dynamic': 17, 'workload.identityInheritance': 18,
  'network.isolation': 19, 'network.endpointExposure': 20,
  'resources.limits': 21, 'resources.hardware': 22,
  'build.execute': 23, 'build.sourceSync': 24,
  'observability.logs': 25, 'observability.metrics': 26, 'observability.events': 27,
} as const;
export type RuntimeFeatureId = keyof typeof FEATURE_ORDER;
export const RUNTIME_FEATURE_IDS: readonly RuntimeFeatureId[] = Object.freeze(
  (Object.keys(FEATURE_ORDER) as RuntimeFeatureId[]).sort((a, b) => FEATURE_ORDER[a] - FEATURE_ORDER[b]),
);

export type RuntimeFeatureSupport = 'supported' | 'conditional' | 'unsupported';
export type RuntimeApplyMode = 'live' | 'restart-required' | 'recreate-required';

/**
 * What a runtime can technically do (D100 §12), as data. Feasibility only:
 * capabilities and permissions stay the one authorization and gating
 * mechanism (owner decision 4), and both must be satisfied.
 */
export interface RuntimeFeature {
  id: RuntimeFeatureId;
  support: RuntimeFeatureSupport;
  applyMode?: RuntimeApplyMode;
  constraints?: Record<string, string | number | boolean>;
}

/** A module's refinements of the derived view: `conditional`, an apply mode, constraints. */
export type RuntimeFeatureOverrides = Partial<Record<RuntimeFeatureId, Partial<Omit<RuntimeFeature, 'id'>>>>;

const yes = (b: boolean): RuntimeFeatureSupport => (b ? 'supported' : 'unsupported');

/**
 * The one table from capabilities to features (no second gating mechanism,
 * D36): what each feature follows, and how a change applies. A module adds
 * only `featureOverrides` on top.
 */
const FEATURE_OF_CAPS: Record<RuntimeFeatureId, (c: RuntimeCapabilities) => Omit<RuntimeFeature, 'id'>> = {
  'instance.lifecycle': () => ({ support: 'supported' }),
  'instance.adoption': (c) => ({ support: yes(c.survivesShellRestart) }),
  'instance.warmPool': (c) => ({ support: yes(c.warmPool) }),
  'execution.command': () => ({ support: 'supported' }),
  'execution.interactive': (c) => ({ support: yes(c.sessionExec) }),
  'execution.processControl': () => ({ support: 'supported' }),
  // Today's tool provisioning hands over a host directory (A4).
  'tools.provision': (c) => ({ support: yes(c.hostFilesystem), applyMode: 'live' }),
  'tools.liveGrant': (c) => ({ support: yes(c.hostFilesystem), applyMode: 'live' }),
  'tools.liveRevoke': (c) => ({ support: yes(c.hostFilesystem), applyMode: 'live' }),
  'tools.inheritance': (c) => ({ support: yes(c.sidecars && c.hostFilesystem), applyMode: 'live' }),
  'storage.privateHome': (c) => ({ support: yes(c.privateHomeSession) }),
  'storage.sharedHome': (c) => ({ support: yes(c.appHome) }),
  'storage.persistent': (c) => ({ support: yes(c.hostFilesystem) }),
  'mount.attach': (c) => ({ support: yes(c.mounts), applyMode: 'live' }),
  'mount.detach': (c) => ({ support: yes(c.mounts), applyMode: 'live' }),
  'mount.live': (c) => ({ support: yes(c.mounts), applyMode: 'live' }),
  'mount.inheritance': (c) => ({ support: yes(c.mounts && c.sidecars), applyMode: 'live' }),
  'workload.dynamic': (c) => ({ support: yes(c.sidecars) }),
  'workload.identityInheritance': (c) => ({ support: yes(c.sidecars) }),
  'network.isolation': (c) => ({ support: yes(c.network !== 'shell-netns' && c.isolation !== 'none') }),
  'network.endpointExposure': (c) => ({ support: yes(c.portExpose), applyMode: 'live' }),
  'resources.limits': () => ({ support: 'unsupported' }),
  'resources.hardware': (c) => ({ support: yes(c.gpu) }),
  'build.execute': () => ({ support: 'unsupported' }),
  'build.sourceSync': () => ({ support: 'unsupported' }),
  'observability.logs': () => ({ support: 'supported' }),
  'observability.metrics': (c) => ({ support: yes(c.usage) }),
  'observability.events': () => ({ support: 'supported' }),
};

/** The features of a runtime under its capabilities: the derived view plus the module's overrides. Plain data. */
export function featuresOf(caps: RuntimeCapabilities, overrides: RuntimeFeatureOverrides = {}): RuntimeFeature[] {
  return RUNTIME_FEATURE_IDS.map((id) => {
    const f = { ...FEATURE_OF_CAPS[id](caps), ...(overrides[id] ?? {}) };
    return {
      id, support: f.support,
      ...(f.applyMode ? { applyMode: f.applyMode } : {}),
      ...(f.constraints && Object.keys(f.constraints).length ? { constraints: { ...f.constraints } } : {}),
    };
  });
}

// ─── Operation results (D100 §13) ───────────────────────────────────────────

/**
 * The provider's account of one operation (D100 §13): a successful call is
 * not enforcement until the provider says `applied`. The synchronous
 * reference returns terminal states only; `applying` plus `opId` is the hook
 * for an asynchronous provider (BT7). The kernel adds `requested` and
 * `authorized` in its own audit; a provider never claims them. Plain data.
 */
export interface RuntimeOperationResult {
  opId: string;
  feature: RuntimeFeatureId;
  target: { instanceId: string; workload?: string };
  state: 'applying' | 'applied' | 'failed' | 'restart-required' | 'recreate-required' | 'unsupported';
  error?: RuntimeRefusal;
  detail?: Record<string, string | number | boolean>;
}

let opSeq = 0;
/** A terminal result of a synchronous operation (ids are unique within this kernel). */
export function operationResult(
  feature: RuntimeFeatureId, target: RuntimeOperationResult['target'], state: RuntimeOperationResult['state'],
  opts: { error?: { code: RuntimeRefusalCode; message: string }; detail?: RuntimeOperationResult['detail'] } = {},
): RuntimeOperationResult {
  return {
    opId: `op-${Date.now().toString(36)}-${(++opSeq).toString(36)}`,
    feature, target: { ...target }, state,
    ...(opts.error ? { error: { code: opts.error.code, category: CATEGORY_OF_CODE[opts.error.code], message: opts.error.message } } : {}),
    ...(opts.detail ? { detail: { ...opts.detail } } : {}),
  };
}

// ─── Capability groups (D100 §§3-11): provider-neutral, optional ──────────────
//
// A group is present on a module exactly when its features are supported
// (`GROUP_FEATURE`); the registry refuses a module where they disagree. Shapes
// carry instance ids, workload ids and opaque refs: never a PID, a container
// name or id, a host path or an engine handle. 5b-2 stream D moved the
// endpoints, build, diagnostics, logs and workload exec/logs mechanisms behind
// these groups; Phase 6 (ari-rest) moved OS sidecars (`workloads`, D-S) and
// cross-app mounts (`mounts`, D-M).

/** An instance that outlived the previous kernel, as its runtime reports it (D77). */
export interface RuntimeSurvivor {
  instanceId: string;
  appId: string;
  port: number;
  /** Opaque: meaningful to its runtime only. */
  ref: string;
  /** D89: the workload token's nonce; absent on workloads from before tokens (never adopted). */
  tokenNonce?: string;
  /** The user it was started for, as the runtime recorded it. */
  owner?: string;
  /** The identity it runs as, `<uid>:<gid>`; absent for root. */
  user?: string;
  /** A preview's workspace (Track P). */
  preview?: string;
}

/** `instance.adoption`: survivors of a kernel restart (present ⇔ `survivesShellRestart`). */
export interface RuntimeAdoption {
  /** Every survivor; null when the scan failed (unknown, not absent: nothing is reaped). */
  list(): Promise<RuntimeSurvivor[] | null>;
  /** Takes a listed survivor back under the runtime's bookkeeping (exit watch, lifecycle). */
  adopt(instanceId: string): { pid: number | null };
  /** The lifecycle checks again for an adopted instance (reported only). */
  measure(instanceId: string): Promise<LifecycleStatus | null>;
  /** Removes every workload of an app, tracked or not (the uninstall sweep). */
  removeAllOf(appId: string): Promise<void>;
}

/** An app process in a runtime's own process space (`orphans`; the pid is local to that space). */
export interface RuntimeOrphanProcess { pid: number; appId: string; cmdline: string }
/**
 * Squatters (5b-2 D-#11): app processes in the runtime's process space that
 * no tracked process reaches (the kernel's instance records plus every
 * runtime's in-flight processes). Present on a runtime whose workloads run in
 * the kernel's own process space; reported only: the kernel decides the kill.
 */
export interface RuntimeOrphans {
  scan(tracked: ReadonlySet<number>): { all: RuntimeOrphanProcess[]; squatters: RuntimeOrphanProcess[] };
}

/** A session open inside an instance (D74), as listed. */
export interface RuntimeSessionInfo {
  sessionId: string;
  instanceId: string;
  kind: SessionSpec['kind'];
  userId?: string;
  home: SessionSpec['home']['mode'];
  uid: number;
  startedAt: string;
}
/** `execution.interactive` session management (present ⇔ `sessionExec`). */
export interface RuntimeSessions {
  list(): RuntimeSessionInfo[];
  end(sessionId: string): Promise<boolean>;
}

/**
 * A process running in a workload (a session, an exec), its stdio streamed
 * (`aura jump`, `aura exec`). A stream handle, not data: it never crosses
 * a process boundary as is.
 */
export interface RuntimeExecSession {
  input(data: Buffer): void;
  /** Close the process's stdin (non-TTY: EOF). */
  endInput(): void;
  resize(cols: number, rows: number): void;
  /**
   * A signal for the process. With a TTY, INT, QUIT and TSTP go in as the
   * terminal's control characters; anything else (and every signal without a
   * TTY) ends the session where the runtime cannot signal an exec process.
   * Returns false when the session was ended instead.
   */
  signal(sig: string): boolean;
  close(): void;
  /** The exit code; null when it could not be read (the session was cut). */
  readonly exited: Promise<number | null>;
}

/** A process to run in an associated workload (5b-2 D-X: `jump --sidecar`, `exec sc`), with the workload's own user unless `user`. */
export interface RuntimeWorkloadExec {
  argv: string[];
  tty: boolean;
  env: Record<string, string>;
  cols: number;
  rows: number;
  /** Attach stdin (absent: the runtime's default for the kind of session). */
  attachStdin?: boolean;
  user?: string;
  workdir?: string;
}

/** A workload's output (`aura logs`): `out` or `err`. */
export type RuntimeOutputStream = 'out' | 'err';
export interface RuntimeLogsRequest { tail?: number; since?: number; timestamps?: boolean; follow?: boolean }
/** A running read of a log: `done` resolves when the output ends (never, while following, until `close`). */
export interface RuntimeLogsStream { done: Promise<void>; close(): void }
/** Reads a workload's log (`observability.logs`, 5b-2 D-X); `onChunk` gets each piece as it comes. */
export type RuntimeLogs = (id: string, req: RuntimeLogsRequest, onChunk: (stream: RuntimeOutputStream, data: Buffer) => void) => Promise<RuntimeLogsStream>;

/**
 * An associated workload as its runtime keeps it (Phase 6 D-S): its state and
 * the tags it was created with. The kernel's record of an OS sidecar travels
 * as one tag until Phase 8 moves that desired state into the kernel; the
 * tags are actual state, reported only.
 */
export interface RuntimeWorkloadState {
  /** The runtime's handle of it, also where it is reached on the runtime's network (opaque to the kernel). */
  ref: string;
  /** The runtime's word for its state (`running`, `exited`, `created`, ...). */
  state: string;
  tags: Record<string, string>;
  /** Restarts by the runtime's restart policy since it was created. */
  restarts: number;
}
/** One OS-managed workload of a listing: its ref, its instance, its state (per-instance listings) and the kernel's record. */
export interface RuntimeManagedWorkload { ref: string; instanceId: string; state?: string; record?: string }

/**
 * One OS sidecar as the kernel decided it (Phase 6 D-S): the resolved spec
 * (sidecar-spec.ts: what the app may run, checked against its templates and
 * permissions), the record the runtime keeps with it, the env and the
 * identity pieces. The runtime only realises it (its own argv, network,
 * tools and mount-root wiring). Plain data; `home` carries host fields only
 * for a runtime with `hostFilesystem` (A4).
 */
export interface RuntimeWorkloadCreate {
  instanceId: string;
  appId: string;
  spec: ResolvedSidecarSpec;
  /** The kernel's record (JSON), kept with the workload; `owner`: the sidecar that spawned it. */
  record: string;
  owner?: string;
  /** Inherited, then the spec's own (the runtime adds HOME and the identity after it). */
  env: Record<string, string>;
  /** D89: its own workload token when the spec inherits the identity. */
  token: string | null;
  /** D65: the parent's App Home when the spec inherits it. */
  home: ResolvedHome | null;
  /** The parent's process identity (P5-3: an inheritHome base-image sidecar is the app's own code). */
  parentIdentity?: SpawnIdentity;
  /** The app's permissions when the spec inherits them. */
  permissions?: string[];
}
/** A one-shot command in a running workload, its output captured (`POST …/sidecars/:name/exec`). */
export interface RuntimeWorkloadRun {
  argv: string[];
  user?: string;
  workdir?: string;
  env?: Record<string, string>;
  /** Small stdin payload. */
  stdin?: string;
  timeoutMs: number;
}
export interface RuntimeWorkloadRunResult { exitCode: number | null; stdout: string; stderr: string; truncated: boolean; timedOut: boolean }

/**
 * `workload.dynamic`: associated workloads (sidecars; present ⇔ `sidecars`).
 * The kernel (SidecarManager) decides what runs, for whom, with which
 * tokens, tools and mounts; the runtime creates, starts, lists, inspects and
 * removes (Phase 6 D-S). Refusals throw with the runtime's own words.
 */
export interface RuntimeWorkloads {
  /** Every associated workload; null when the runtime could not be read (never reap on that). */
  list(): Promise<SidecarInfo[] | null>;
  remove(workloadIds: string[]): void;
  /** Removes an instance's app-spawned workloads; those the kept services name stay (a restart). */
  removeOf(instanceId: string, opts?: { keepServices?: string[] }): number;
  /** Runs a process in a running workload (by its listed id); refusals are `RuntimeExecError`s. */
  exec(workloadId: string, spec: RuntimeWorkloadExec, onOutput: (channel: 1 | 2, data: Buffer) => void): Promise<RuntimeExecSession>;
  /** A workload's own output. */
  logs: RuntimeLogs;

  // OS sidecars (Phase 6 D-S).
  /** The ref of an instance's sidecar `name` (also its address). */
  ref(instanceId: string, name: string): string;
  /** The OS-managed workloads of an instance, with state and record; throws when they can't be read. */
  listOf(instanceId: string): Promise<RuntimeManagedWorkload[]>;
  /** Every OS-managed workload (reconcile after a kernel restart); null when they can't be read. */
  listManaged(): Promise<RuntimeManagedWorkload[] | null>;
  /** Refs of the OS-managed workloads of an instance that sidecar `owner` spawned. */
  spawnedBy(instanceId: string, owner: string): Promise<string[]>;
  inspect(ref: string): Promise<RuntimeWorkloadState | null>;
  /** A runtime storage volume of that name exists (a pre-OS-sidecar per-app volume). */
  storageExists(name: string): Promise<boolean>;
  /** The image is present (fetched once, concurrent callers share the fetch); throws when it can't be. */
  prepareImage(image: string): Promise<void>;
  /** The env an instance's own workload runs with. */
  instanceEnv(instanceId: string): Promise<Record<string, string>>;
  /** Runs the spec's one-shot seed in a throwaway workload on its storage; throws with its output. */
  seed(req: { instanceId: string; spec: ResolvedSidecarSpec; env: Record<string, string> }): Promise<void>;
  /** Creates the workload (not started); its id. Throws, leaving nothing behind. */
  create(req: RuntimeWorkloadCreate): Promise<string>;
  /** Starts a created workload and checks it stays up; on failure it is removed and the call throws with its last words. */
  start(id: string, ref: string): Promise<void>;
  /** Removes a workload; throws when the runtime could not (`quiet`: never throws). */
  destroy(ref: string, opts?: { quiet?: boolean }): Promise<void>;
  /** A one-shot command in a running workload, output captured. */
  run(ref: string, req: RuntimeWorkloadRun): Promise<RuntimeWorkloadRunResult>;
  /** The tail of a workload's output; throws when it can't be read. */
  output(ref: string, opts: { tail: number; since?: string; timestamps?: boolean }): Promise<{ stdout: string; stderr: string }>;
  /** Its last 20 lines of output, trimmed (a failure report). */
  lastWords(ref: string): Promise<string>;
}

/** The logical tool grant (D100 §5): tool ids, never a host directory. */
export interface RuntimeToolSet { tools: AppManifest['tools'] }
/** One provisioned tool of an instance, as its runtime sees it (`tools.status`). */
export interface RuntimeToolEntry {
  name: string;
  /** How the entry is provisioned: `hardlink`, `file`, `symlink` (legacy, advisory) or `unknown`. */
  kind: string;
  /** A symlink's target inside the workload; null otherwise. */
  target: string | null;
  /** The tool and the libraries it needs are there. */
  resolves: boolean;
  libs: { needed: number; missing: string[] };
}
/** What an instance's tools are, as provisioned (`tools.status`, 5b-2 D-C; `GET /api/admin/inspect-tools`). Reported only. */
export interface RuntimeToolsStatus {
  /** The instance has a provisioned tool set at all. */
  provisioned: boolean;
  entries: RuntimeToolEntry[];
  /** The granted libraries' sonames; null when the instance has none provisioned. */
  libs: string[] | null;
}
/** `tools.*`: physical provisioning of `/aura/my-tools` (present ⇔ `hostFilesystem` in this release). */
export interface RuntimeTools {
  /** Applies the grant to a running instance; `applied` only when the provider made it so. */
  apply(instanceId: string, set: RuntimeToolSet): RuntimeOperationResult;
  /** What is provisioned for the instance now. */
  status(instanceId: string): RuntimeToolsStatus;
}

/**
 * Read-only diagnostics a runtime can answer (D100 §§11, 16; 5b-2 D-R, D-C):
 * reported, never enforced. Every member is optional; a missing one is
 * reported as not inspectable, never guessed. Instance ids only: the module
 * maps them to its own workloads.
 */
export interface RuntimeDiagnostics {
  /**
   * What the workload wrote into its own root filesystem outside every mount
   * (`aura admin contract`, the dataDir report): one change per line,
   * `A|C|D <path>` (added, changed, deleted). Null when it can't be read.
   */
  inspectWrites?(instanceId: string): Promise<string[] | null>;
  /** The workload's mounts as it sees them (destination, writable). Null when they can't be read. */
  workloadMounts?(instanceId: string): Promise<Array<{ destination: string; rw: boolean }> | null>;
  /**
   * `aura cap doctor`: runs the tools probe (`script`, which prints its report
   * on stdout) in a fresh, short-lived sandbox of this runtime over the
   * toolchain store (`binDir`, `libDir`: its binaries and libraries, with the
   * libraries on `LD_LIBRARY_PATH`). `skipped`: the probe could not run here.
   */
  probeTools?(probe: { script: string; binDir: string; libDir: string }): { stdout: string } | { skipped: string; missing?: string };
}

/**
 * One cross-app bind as the kernel resolved it (Phase 6 D-M): MountManager
 * decides the source (kind, nesting, closed sources), the destination under
 * the consumer's mount root, the mode and a D80 idmapping; the runtime only
 * binds. Host paths as the runtime's host sees them (`hostPath`): a runtime
 * with `hostFilesystem` only (A4).
 */
export interface RuntimeMountBind {
  source: string;
  dest: string;
  mode: 'ro' | 'rw';
  /** D80: the on-disk owner (`from`, `uid:gid`) shows as the consumer (`to`) inside the bind only. */
  idmap?: { from: string; to: string };
}
/** One line of a consumer's own mount table: where, and its options (`ro`, `idmapped`, ...). */
export interface RuntimeMountEntry { destination: string; options: string[] }
/** What a consumer's own mount table says about a promised bind. */
export type RuntimeMountCheck = 'ok' | 'unreadable' | 'missing' | 'writable' | 'not-idmapped';
/**
 * `mount.*` (present ⇔ `mounts`; Phase 6 D-M): live binds into a running
 * consumer (an instance, or its OS sidecar `<instanceId>--<name>`). The
 * kernel keeps kinds, persistence, fan-out and authorization; the runtime
 * attaches, detaches, lists and verifies. Synchronous and terminal; a
 * failure throws with the runtime's words.
 */
export interface RuntimeMounts {
  /** Live mounts work on this host at all (propagation into running workloads). */
  capable(): { ok: boolean; reason?: string };
  /** D80: idmapped binds work here (probed at boot; fail closed until then). */
  idmapProbe(): { ok: boolean; reason?: string };
  /** The kernel-side dir a consumer's binds land under. */
  rootDir(consumer: string): string;
  /** A kernel-side path as the runtime's host sees it (bind sources and destinations). */
  hostPath(shellPath: string): string;
  /** Where a consumer's binds appear: its mount root (`canonical`) or, without one, under its data dir (`legacy`). */
  rootOf(consumer: string): 'canonical' | 'legacy';
  attach(consumer: string, bind: RuntimeMountBind): void;
  /** Ends every bind stacked at `dest` (a host path); throws when the runtime could not. */
  detach(consumer: string, dest: string): void;
  /** The consumer's own mount table; null when it can't be read. */
  table(consumer: string): RuntimeMountEntry[] | null;
  /** Whether a promised bind arrived in the consumer as promised. */
  verify(consumer: string, expect: { path: string; mode: 'ro' | 'rw'; idmap: boolean }): RuntimeMountCheck;
}
/**
 * One port exposure (`aura port expose`, 5b-2 D-P): a source instance's port
 * made reachable `into` the owner's loopback or on the `host`. The kernel
 * decides the request (who, which id, persistence); the runtime realises it.
 */
export interface RuntimeExposeRequest {
  /** The kernel's id of the exposure, unique per owner (`into-<port>`, `host-<addr>-<port>`). */
  id: string;
  kind: 'into' | 'host';
  /** `into`: the instance whose loopback gets the port; `host`: the source instance. */
  ownerInstanceId: string;
  sourceAppId: string;
  sourceInstanceId: string;
  sourcePort: number;
  /** The listen port (into) or the published host port (host). */
  port: number;
  /** `host` only: the host address bound. */
  bindAddr?: string;
  sticky: boolean;
}
/**
 * A live exposure as the runtime keeps it (its record of what runs, D100 §13
 * actual state). `containerName` is the runtime's opaque handle of it (the
 * container module: its forwarder), named so for the stored records and the
 * port API, which keep their shape (5b-2 is refactor only).
 */
export interface RuntimeExposure extends RuntimeExposeRequest { containerName: string; createdAt: string }
/** `network.endpointExposure` (present ⇔ `portExpose`; 5b-2 D-P). */
export interface RuntimeEndpoints {
  /** Every live exposure; [] when they can't be read. */
  list(): RuntimeExposure[];
  /** Realises one; throws (nothing left behind) when it can't. */
  expose(req: RuntimeExposeRequest): Promise<RuntimeExposure>;
  /** Ends one by its handle; throws when the runtime could not. */
  remove(containerName: string): void;
}
/**
 * `build.execute` (5b-2 D-B): app builds and dependency provisioning in a
 * throwaway sandbox of this runtime, never in the app and never in the
 * kernel. The kernel decides when and stages the result; the runtime only
 * runs it. `appDir` is a host path (A4: a runtime with `hostFilesystem`). The
 * AuraOS release builder is OS infrastructure, outside ARI.
 */
export interface RuntimeBuild {
  /** `astro build` the app's sources into its staging dir. */
  build(spec: { appId: string; appDir: string; timeoutMs?: number }): Promise<{ ok: boolean; output: string }>;
  /** Installs the app's dependencies (its package manager's tree, the `@aura/*` packages). */
  provision(spec: { appId: string; appDir: string; runtime: 'astro' | 'raw'; onLine?: (line: string) => void }): Promise<{ ok: boolean; output: string }>;
}

/**
 * Module actions (D100 §4 "runtime", diagnostics): owner and diagnose
 * operations a runtime offers beyond the instance contract. The kernel (or
 * the route) authorizes, approves and audits; the action only executes, on
 * the executor it is handed. Input and output are plain data.
 */
export interface RuntimeActionHost {
  /** Runs one program by argv (no shell); returns its output, throws with it on failure. */
  run(file: string, args: readonly string[], opts: { timeoutMs: number; cwd?: string }): string;
}
export interface RuntimeAction {
  title: string;
  /** Changes the host (needs an owner action); false: a read-only diagnostic. */
  mutating: boolean;
  run(input: Record<string, unknown>, host: RuntimeActionHost): Promise<Record<string, unknown>>;
}

/** The feature each implemented group stands for: present exactly when it is supported. */
export const GROUP_FEATURE = Object.freeze({
  adoption: 'instance.adoption',
  sessions: 'execution.interactive',
  workloads: 'workload.dynamic',
  tools: 'tools.provision',
  usage: 'observability.metrics',
  endpoints: 'network.endpointExposure',
  build: 'build.execute',
  mounts: 'mount.attach',
} as const satisfies Record<string, RuntimeFeatureId>);
export type RuntimeGroupName = keyof typeof GROUP_FEATURE;

/**
 * Why a module's groups and features disagree (a group without its
 * feature, or a supported feature without its group), or null.
 */
export function groupMismatch(module: Pick<RuntimeModule, RuntimeGroupName>, features: readonly RuntimeFeature[]): string | null {
  for (const [group, feature] of Object.entries(GROUP_FEATURE) as Array<[RuntimeGroupName, RuntimeFeatureId]>) {
    const supported = features.find((f) => f.id === feature)?.support !== 'unsupported';
    const present = module[group] !== undefined;
    if (supported !== present) return `group ${group} is ${present ? 'present' : 'missing'} but feature ${feature} is ${supported ? 'supported' : 'unsupported'}`;
  }
  return null;
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
  /** `conditional`, apply modes and constraints on top of the derived features (D100 §12). */
  featureOverrides?(settings: RuntimeSettings): RuntimeFeatureOverrides;

  // Capability groups (present ⇔ their feature is supported; `GROUP_FEATURE`).
  readonly adoption?: RuntimeAdoption;
  readonly sessions?: RuntimeSessions;
  readonly workloads?: RuntimeWorkloads;
  readonly tools?: RuntimeTools;
  readonly endpoints?: RuntimeEndpoints;
  readonly build?: RuntimeBuild;
  readonly mounts?: RuntimeMounts;
  /** Orphan app processes in the runtime's process space (no feature of its own; D-#11). */
  readonly orphans?: RuntimeOrphans;
  /**
   * An instance's own output as its runtime keeps it (5b-2 D-X). Absent: the
   * kernel reads the runner's output ring (`outputLog`), or there is none.
   */
  readonly logs?: RuntimeLogs;
  /** Read-only diagnostics (no feature of its own: a missing member is reported as not inspectable). */
  readonly diagnostics?: RuntimeDiagnostics;
  /** Live usage by instance id and workload id (a record, never a `Map`). */
  usage?(req: { instanceIds: string[]; sidecarIds: string[] }): Promise<RuntimeUsage>;
  /** Owner and diagnose actions, by id (`aura runtime`, the admin routes). */
  readonly actions?: Readonly<Record<string, RuntimeAction>>;
  /**
   * The host switches this module reads (D64/D92: each is a security option),
   * with their values here, for display only (`aura runtime show`, Settings):
   * clients render them by name, never by the runtime's id. Null: unset.
   */
  hostSwitches?(): Record<string, string | null>;
}

/** A module's features under its settings: the derived view plus its overrides. */
export function moduleFeatures(module: Pick<RuntimeModule, 'capabilities' | 'featureOverrides'>, settings: RuntimeSettings): RuntimeFeature[] {
  return featuresOf(module.capabilities(settings), module.featureOverrides?.(settings));
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
