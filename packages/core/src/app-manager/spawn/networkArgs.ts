/**
 * D88 S1: D28 names a tokenless caller by its network address, so no
 * container on a shell network may forge one. Docker's default capability set
 * keeps `NET_RAW` (raw sockets: ARP and source-address spoofing on the
 * bridge), so every container the OS creates drops it: app containers
 * (ContainerRunner), sidecars, their seed runs and port helpers.
 *
 * The one exception is a sidecar template that asks for it (`privileged`, or
 * `capabilities` naming `NET_RAW`/`ALL`). That already needs the owner's
 * `sidecars.privileged` grant (sidecar-spec.ts), the reviewed path. Such a
 * container is never in the D28 identity table: the table holds app
 * instances only (identify.ts `createNetworkIdentity`), and app containers
 * have no exception.
 */
export function rawSocketsRequested(spec: { privileged?: boolean; capabilities?: readonly string[] }): boolean {
  if (spec.privileged) return true;
  return (spec.capabilities ?? []).some((c) => {
    const cap = c.toUpperCase().replace(/^CAP_/, '');
    return cap === 'NET_RAW' || cap === 'ALL';
  });
}

/** `--cap-drop NET_RAW`, unless the reviewed exception above applies. */
export function rawSocketArgs(spec: { privileged?: boolean; capabilities?: readonly string[] } = {}): string[] {
  return rawSocketsRequested(spec) ? [] : ['--cap-drop', 'NET_RAW'];
}
