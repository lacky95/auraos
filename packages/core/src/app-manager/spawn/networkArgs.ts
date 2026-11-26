/**
 * Network arguments of an app container (Phase 5 Stage 1 extraction; stream
 * N owns this file: D58 adds the per-user Terminal network here).
 */
export function containerNetworkArgs(o: { network: string }): string[] {
  return ['--network', o.network];
}
