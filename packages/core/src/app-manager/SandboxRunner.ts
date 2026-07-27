import type { AppManifest } from '../types/manifest.js';
import type { SpawnContext } from '../scopes/types.js';

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
  spawn(instanceId: string, appId: string, port: number, manifest: AppManifest, ctx: SpawnContext): Promise<number>;

  /** Graceful shutdown (SIGTERM, wait, then SIGKILL on the proot group). */
  kill(instanceId: string): Promise<void>;
  /** Hard kill (SIGKILL) — no lifecycle hooks. Returns whether anything was killed. */
  forceKill(instanceId: string): boolean;

  /** Invoke a required lifecycle hook (onCreate/onStart/onResume/onPause/onStop/onDestroy). */
  callLifecycle(instanceId: string, hook: string): Promise<void>;
  /** Invoke a best-effort lifecycle hook with optional payload. */
  callOptionalLifecycle(instanceId: string, hook: string, body?: unknown): Promise<unknown>;

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
   * Optional — runners whose sandboxes outlive the shell process (currently
   * just ContainerRunner) implement these so AppManager.init() can pick up
   * survivors from the last shell lifetime. PRoot intentionally doesn't:
   * its proots are direct child processes of the shell node and die with it.
   */
  listOrphanRecords?(): Promise<Array<{
    instanceId: string;
    appId:      string;
    port:       number;
    hostname:   string;
    pid:        number;
  }>>;
  registerAdopted?(rec: {
    instanceId: string;
    appId:      string;
    port:       number;
    hostname:   string;
    pid:        number;
    manifest:   AppManifest;
  }): void;
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
  reapSiblingsOf?(instanceId: string): void;
}

/** What every concrete runner needs to construct. */
export interface SandboxRunnerOpts {
  baseRootfs:   string;
  toolchainDir: string;
  appsDir:      string;
  dataDir:      string;
  osApiBase:    string;
}
