/**
 * The container runtime's Docker names, in one place (5b CR, dup #10). A
 * name is the container module's own detail (D85 A7): the kernel addresses
 * an instance by its id and asks `endpoint()` where to dial it. 5b G moves
 * the remaining re-derivations (MountManager, PortManager, SidecarManager,
 * the shell) onto these; 5b-2's boundary test forbids new ones.
 *
 * A leaf: imports nothing, so the runner and the managers share it without a
 * module cycle.
 */

/** An instance's container: `aura-<id>`, sanitised to Docker's `[a-zA-Z0-9_.-]` (instance ids may hold `:`). */
export function containerName(instanceId: string): string {
  return 'aura-' + instanceId.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

/** An OS-managed sidecar's container: `aura-<instanceId>--<name>` (SidecarManager). */
export function sidecarContainerName(instanceId: string, name: string): string {
  return `aura-${instanceId}--${name}`;
}
