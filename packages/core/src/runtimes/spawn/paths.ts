/**
 * Where the OS puts its pieces inside a workload (the runtimes' spawn
 * helpers, the kernel managers and the sidecar argv share them). A leaf:
 * constants only, no import.
 */

/** A workload's tools allowlist dir (`tools[]`, D100 §5). */
export const MY_TOOLS_PATH = '/aura/my-tools';

/**
 * Canonical mount root inside a consumer (cross-app mounts). Provisioned at
 * spawn by the container runtime, so only containers started since that
 * change have it.
 */
export const MOUNT_ROOT_PATH = '/mnt/aura';
