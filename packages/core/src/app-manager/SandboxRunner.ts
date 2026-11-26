import type { KeepSiblings } from './sidecarParking.js';
import type { AppManifest } from '../types/manifest.js';
import type { SpawnContext } from '../scopes/types.js';
import type { ResourceUsage, SidecarInfo } from '../types/instance.js';
import type { LifecycleStatus } from './lifecycleGate.js';

/**
 * Shared abstraction for "spawn an isolated bash process that runs an app".
 *
 * AuraOS supports two backends:
 *   - PRoot  (ProotRunner)       — ptrace-based, lightweight, weak isolation.
 *                                   Apps with `sandbox: 'proot'` use this.
 *                                   Cheap to spawn (~3 ms), no privileges.
 *   - Docker (ContainerRunner)   — kernel-namespace containers, real isolation.
 *                                   Apps with `sandbox: 'container'` use this.
 *                                   Heavier to spawn (~80-150 ms) but each
 *                                   instance gets a real PID/net/mount NS.
 *
 * Both backends share the same lifecycle (spawn → onCreate/onStart/onResume,
 * health probe, onPause/onStop/onDestroy → kill) and the same per-instance
 * tool allowlist dir (/aura/my-tools), so AppManager doesn't care which
 * concrete runner backs an instance — it just calls SandboxRunner methods.
 */
/** Spawn input from AppManager. `owner` is absent for warm-pool members. */
export type InstanceSpawnContext = SpawnContext & { owner?: string };

export interface SandboxRunner {
  /** Resolve the per-instance toolchain allowlist directory on the host. */
  toolsDir(instanceId: string): string;
  /**
   * (Re)create the allowlist dir so it holds exactly the binaries the
   * manifest's `tools[]` grants. Delegates to `provisionAllowlist` — see
   * tool-provision.ts for the hardlink/symlink modes.
   */
  provisionToolsDir(instanceId: string, manifest: AppManifest): string;
  /** Tear down the allowlist dir. Called on instance destroy. */
  clearToolsDir(instanceId: string): void;

  /** Launch the app's astro process and wait until it's healthy. */
  spawn(instanceId: string, appId: string, port: number, manifest: AppManifest, ctx: InstanceSpawnContext): Promise<number>;

  /** Graceful shutdown (SIGTERM, wait, then SIGKILL on the proot group).
   *  `keep`: a restart stop — sibling containers that opted in keep running
   *  (see sidecarParking.ts / KeepSiblings). */
  kill(instanceId: string, opts?: { keep?: KeepSiblings }): Promise<void>;
  /** Hard kill (SIGKILL) — no lifecycle hooks. Returns whether anything was killed. */
  forceKill(instanceId: string): boolean;

  /** Invoke a required lifecycle hook (onCreate/onStart/onResume/onPause/onStop/onDestroy).
   *  `reason` (stop hooks) is sent as `x-aura-stop-reason: user|restart`. Every
   *  lifecycle call carries this start's `x-aura-lifecycle` token, and only to
   *  a destination bound to the instance (lifecycleGate.ts). */
  callLifecycle(instanceId: string, hook: string, opts?: { reason?: string }): Promise<void>;
  /** Invoke a best-effort lifecycle hook with optional payload. */
  callOptionalLifecycle(instanceId: string, hook: string, body?: unknown): Promise<unknown>;
  /** Health identity class and runtime-check outcome of this start; null when
   *  not measured (not healthy yet, or adopted from a previous shell). */
  lifecycleStatus(instanceId: string): LifecycleStatus | null;

  /** Port assigned to this instance, or null if it's already dead. */
  getPort(instanceId: string): number | null;
  /**
   * Hostname the shell should connect to for this instance. PRoot instances
   * live in the same network namespace as the shell → `127.0.0.1`. Container
   * instances are siblings on a shared docker network → their container name.
   * Returns null if the instance is unknown.
   */
  getHost(instanceId: string): string | null;
  /** True if the runner still tracks the instance as alive. */
  isRunning(instanceId: string): boolean;
  /** Every pid the runner currently owns (used by the reconciler's orphan reaper). */
  getActivePids(): number[];
  /** Register a one-shot exit-callback for the instance's root process. */
  onExit(instanceId: string, cb: (code: number | null) => void): void;

  /**
   * Run a command inside a running instance's sandbox — its filesystem view,
   * granted tools, HOME and env — with the app dir as working directory.
   * Rejects (with `stderr` on the error) on a non-zero exit, a timeout, or an
   * instance this runner is not running. No shell: `argv` is exec'd as given.
   */
  exec?(instanceId: string, argv: string[], opts?: SandboxExecOpts): Promise<{ stdout: string; stderr: string }>;

  /**
   * Optional — runners whose sandboxes outlive the shell process (currently
   * just ContainerRunner) implement these so AppManager.init() can pick up
   * survivors from the last shell lifetime. PRoot intentionally doesn't:
   * its proots are direct child processes of the shell node and die with it
   * (the desktop session starts running ones again: shell desktopSession.ts).
   * `null` = the scan failed: the survivors are unknown, not absent.
   */
  listOrphanRecords?(): Promise<Array<{
    instanceId: string;
    appId:      string;
    port:       number;
    hostname:   string;
    pid:        number;
    /** `aura.token.nonce` label — absent on containers spawned before tokens. */
    tokenNonce?: string;
    /** `aura.owner` label — absent on containers from before owners and on pool members. */
    ownerLabel?: string;
    /** The container's own address on the shared network (lifecycle calls go there). */
    address?:   string;
    /** `AURA_LIFECYCLE_TOKEN` from its env — absent on containers from before the token. */
    lifecycleToken?: string;
    /** `aura.preview` label: a preview instance's workspace (Track P). */
    preview?: string;
  }> | null>;

  registerAdopted?(rec: {
    instanceId: string;
    appId:      string;
    port:       number;
    hostname:   string;
    pid:        number;
    address?:   string;
    lifecycleToken?: string;
  }): void;
  /**
   * The lifecycle checks again for an instance adopted from a previous shell
   * (`registerAdopted`): its health identity and the runtime check of the
   * health guard, as a fresh start measures them. Reported only: a running
   * instance is never stopped for it. Null when the health endpoint gave no
   * answer. Container-only; PRoot instances don't survive a shell restart.
   */
  measureAdopted?(instanceId: string): Promise<LifecycleStatus | null>;
  /**
   * Remove EVERY host sandbox belonging to an app (all instances, incl.
   * untracked survivors) — used as a belt-and-braces step before uninstall.
   * Container-only; PRoot's children die with the shell so it doesn't implement it.
   */
  killAllForApp?(appId: string): Promise<void>;
  /**
   * Remove sibling runtime containers an app spawned for a given instance
   * (labelled `aura.parent=<instanceId>`). Called on graceful stop and on
   * unexpected exit so a crashed bring-your-own-runtime app doesn't leak its
   * siblings. Container-only; PRoot apps don't spawn siblings.
   */
  reapSiblingsOf?(instanceId: string, opts?: { keep?: KeepSiblings }): number;
  /**
   * Every sidecar this backend currently knows about, across all instances
   * (see `SidecarInfo`). Resolves null when the backend could not be queried,
   * so callers can tell "none" from "unknown" and never reap on a failed read.
   */
  listSidecars?(): Promise<SidecarInfo[] | null>;
  /** Remove the given sidecars (e.g. orphans whose parent instance is gone). */
  removeSidecars?(ids: string[]): void;
  /**
   * Live resource usage keyed by instanceId (for instance sandboxes) and by
   * sidecar id. Keys the backend cannot measure are simply absent.
   */
  usage?(req: { instanceIds: string[]; sidecarIds: string[] }): Promise<Map<string, ResourceUsage>>;
  /**
   * Remove an instance's cross-app mount root. Container-only; PRoot instances
   * have no mount root because they get no volume mount to propagate into.
   * Call only AFTER the mounts themselves are detached — removing the dir out
   * from under a live bind would leave the bind pinned and unreachable.
   */
  clearMountRoot?(instanceId: string): void;
}

export interface SandboxExecOpts {
  /** Extra environment for the command. */
  env?:       Record<string, string>;
  /** Default 120 s. */
  timeoutMs?: number;
}

/** What every concrete runner needs to construct. */
export interface SandboxRunnerOpts {
  baseRootfs:   string;
  toolchainDir: string;
  appsDir:      string;
  dataDir:      string;
  osApiBase:    string;
}
