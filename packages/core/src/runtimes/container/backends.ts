/**
 * The container runtime's mechanism, as the kernel managers still drive it in
 * 5b-1 (5b G): MountManager, PortManager and SidecarManager are typed to these
 * narrow surfaces, never to `ContainerRunner`. ContainerRunner implements
 * them. Port expose moved behind the `endpoints` group in 5b-2 D (D-P;
 * PortManager keeps only `isRunning` here); mounts and sidecars move behind
 * `mounts` and `workloads` in Phase 6 (D-M, D-S), and these surfaces go
 * with them.
 *
 * A leaf: types and one constant, no runtime import.
 */

/** Inside the mount helper container: where the session launcher (its D80 idmap subcommands) is bound. */
export const IDMAP_HELPER_PATH = '/aura-session-enter';

/** A probe of a host facility: ok, or why not. */
export interface FacilityProbe { ok: boolean; reason?: string }

/** What MountManager binds through (cross-app mounts). */
export interface ContainerMountBackend {
  /** The shell-side root a consumer's cross-app binds land under. */
  mountRootDir(consumer: string): string;
  /** A shell path as the engine's host sees it (bind sources and destinations). */
  toDaemonHostPath(shellPath: string): string;
  /** Mount propagation into running containers (cached). */
  canPropagateMounts(): FacilityProbe;
  /**
   * D80: whether an idmapped bind works on the data filesystem (probed at
   * boot; `ok: false` until the probe has run: fail closed).
   */
  canIdmapMounts(): FacilityProbe;
  /** The idmap helper binary as a daemon host path, or null when there is none (D80). */
  idmapHelperHostPath(): string | null;
}

/** What PortManager asks of the container runtime. */
export interface ContainerPortBackend {
  isRunning(instanceId: string): boolean;
}

/** The OS coordinates a sidecar container is started with. */
export interface SidecarRuntimeFacts {
  dataDir: string; appDataVolume: string; nodeModulesVolume: string; network: string;
  osApiBase: string; shellHostname: string; workspaceRoot: string; toolsMode: string;
}

/** What SidecarManager asks of the container runtime. */
export interface ContainerSidecarBackend {
  sidecarRuntime(): SidecarRuntimeFacts;
  toolsDir(consumer: string): string;
  clearToolsDir(consumer: string): void;
  mountRootDir(consumer: string): string;
  mountRootSubpath(consumer: string): string;
}
