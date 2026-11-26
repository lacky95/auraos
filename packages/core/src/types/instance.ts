import type { AppLifecycleState } from './lifecycle.js';
import type { LifecycleStatus } from '../app-manager/lifecycleGate.js';

/**
 * A running (or transitioning) instance of an app.
 *
 * For apps with manifest.instanceMode='single', instanceId === appId.
 * For apps with manifest.instanceMode='multi', instanceId === `${appId}-${counter}` (counter starts at 1).
 */
export interface AppInstance {
  instanceId: string;
  appId: string;
  state: AppLifecycleState;
  pid: number | null;
  port: number | null;
  startedAt: Date | null;
  lastTransitionAt: Date;
  restartCount: number;
  error?: string;
  /**
   * True while this instance is sitting in the AppManager's warm pool —
   * pre-spawned but not yet handed to a user. The Process Manager hides
   * these from per-app rows and the proxy must not resolve bare-appId
   * lookups to them. Cleared on claim (see AppManager.claimFromPool).
   */
  inPool?: boolean;
  /**
   * Which sandbox runner owns this instance. Latched at spawn time from the
   * manifest's `sandbox` field; needed at call sites (kill, lifecycle hooks)
   * because the manifest may change between spawn and teardown and we need
   * to dispatch to the runner that ACTUALLY launched the process. A runtime
   * id (ARI §9.1), always the resolved one, never omitted for a spawned
   * instance.
   */
  sandbox?: string;
  /**
   * The user this instance runs for. Set on spawn and on warm-pool claim;
   * undefined only while the instance is an unclaimed pool member.
   */
  owner?: string;
  /**
   * How this start passed the lifecycle checks (`AURA_LIFECYCLE_STRICT`): the
   * health identity class and the runtime check of the health guard. Absent
   * when not measured (an instance adopted from a previous shell).
   */
  lifecycle?: LifecycleStatus;
  /**
   * A preview (Track P, `aura dev patch preview`): this instance runs a patch
   * workspace (`workspace`, relative to the root dataDir) instead of the
   * installed tree, on a copy of the app's data, with its own App Host slot.
   * It is never reused for launches, intents, content providers or
   * interfaces, never restored after a restart, and reaped when idle.
   */
  preview?: { workspace: string; startedAt: string };
}

export type SidecarState = 'running' | 'starting' | 'stopped' | 'error' | 'unknown';

/**
 * A runtime an app instance brings up next to itself (database, headless
 * browser, model server, …). This is an OS concept, not a docker one: the
 * `backend` says how the sidecar is realised — today only `'container'`
 * (labelled sibling containers), later e.g. `'vm'`. Sidecars are NOT app
 * instances: they have no lifecycle hooks and live and die with their parent.
 */
export interface SidecarInfo {
  /** Backend-unique id (container backend: the container name). */
  id: string;
  /** Service name the app declared (`aura.service` / manifest `services[].name`). */
  service: string;
  parentInstanceId: string;
  appId: string;
  backend: 'container' | (string & {});
  state: SidecarState;
  image?: string;
  createdAt?: string;
  /**
   * `os` — started by the OS on the app's request (SidecarManager);
   * `app` — started by the app itself (SDK docker mode or raw docker).
   */
  managedBy?: 'os' | 'app';
  /** OS sidecars: the `services[]` template it was spawned from. */
  template?: string;
  /** OS sidecars: the sidecar that spawned this one (grandchild). */
  owner?: string;
}

/** Point-in-time resource usage of an instance sandbox or sidecar. */
export interface ResourceUsage {
  memBytes: number | null;
  cpuPct: number | null;
}
