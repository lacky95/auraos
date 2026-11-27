/**
 * The container runner's facts the container module's groups and the kernel
 * managers read (5b G; Phase 6): mount roots and daemon paths, the mount and
 * idmap probes (the `mounts` group, `mounts.ts`), the sidecar coordinates
 * (the `workloads` group's OS sidecars, `sidecars.ts`; SidecarManager's
 * storage dirs), liveness for PortManager. ContainerRunner implements them.
 * Facts only: every Docker call is in the module's groups.
 *
 * A leaf: types and one constant, no runtime import.
 */

import type { SystemTree } from '../spawn/systemTreeArgs.js';

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
  dataDir: string; appDataVolume: string; network: string;
  osApiBase: string; shellHostname: string; toolsMode: string;
  /** Where its view of the AuraOS tree comes from (runtimes/spawn/systemTreeArgs.ts). */
  systemTree: SystemTree;
}

/** What SidecarManager asks of the container runtime. */
export interface ContainerSidecarBackend {
  sidecarRuntime(): SidecarRuntimeFacts;
  toolsDir(consumer: string): string;
  clearToolsDir(consumer: string): void;
  mountRootDir(consumer: string): string;
  mountRootSubpath(consumer: string): string;
}
