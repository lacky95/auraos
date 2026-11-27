/**
 * Network arguments of an app container (Phase 5 Stage 1 extraction; stream
 * N owns this file: D58 adds the per-user Terminal network here).
 */
import { DEFAULT_OWNER_ID } from '../../auth/identityContracts.js';
import { TERM_NETWORK_CONTAINER_LABEL, type TermNetwork } from '../TermNetworks.js';

import { TERMINAL_APP_ID } from '../../system/systemApps.js';

/** The System Terminal: the one app whose servers listen on a private network (D58). One id: system/systemApps.ts. */
export { TERMINAL_APP_ID };

/**
 * The user whose private network a container joins, or null for every other
 * app: the System Terminal's built-in copy only (its source in the system
 * scope, `/workspace/apps`; a same-id copy elsewhere is no trusted Terminal and
 * stays on the shared network). An unclaimed warm-pool member has no owner
 * yet: in the alpha it is the owner's (D58's per-user pool is stream T).
 */
export function terminalNetworkUser(appId: string, ctx: { appDir: string; owner?: string }): string | null {
  if (appId !== TERMINAL_APP_ID || !ctx.appDir.startsWith('/workspace/')) return null;
  return ctx.owner ?? DEFAULT_OWNER_ID;
}

/**
 * `--network` flags. A Terminal joins its user's private network and the
 * shared one; `gw-priority` makes the shared network carry its default route
 * and outgoing traffic (the internal network has no gateway anyway). The
 * label tells adoption which network the Terminal listens on.
 */
export function containerNetworkArgs(o: { network: string; term?: TermNetwork | null }): string[] {
  if (!o.term) return ['--network', o.network];
  return [
    '--network', `name=${o.term.name}`,
    '--network', `name=${o.network},gw-priority=1`,
    '--label', `${TERM_NETWORK_CONTAINER_LABEL}=${o.term.name}`,
  ];
}

/**
 * The shell's base URL as a container gets it (`OS_API_BASE`). A Terminal
 * names the shell by its name on the Terminal's private network
 * (`<shell>.<aura-term-user>`, Docker's DNS), so its calls to the shell go
 * over that network, never over the shared one (D89 B8, defence in depth:
 * the shell's D28 table knows the Terminal on both). Everyone else keeps it.
 */
/** A network name the shell's host policy accepts in `<shell>.<network>` (shell server/host-policy.mjs: no dot). */
const HOST_SAFE_TERM_NET_RE = /^aura-term-[a-z0-9][a-z0-9_-]{0,63}$/;

export function containerShellBase(o: { osApiBase: string; term?: TermNetwork | null; shellHostname: string }): string {
  if (!o.term || !HOST_SAFE_TERM_NET_RE.test(o.term.name)) return o.osApiBase;
  const url = new URL(o.osApiBase);
  if (url.hostname !== o.shellHostname) return o.osApiBase;
  url.hostname = `${o.shellHostname}.${o.term.name}`;
  return url.toString().replace(/\/$/, o.osApiBase.endsWith('/') ? '/' : '');
}

/**
 * The env a Terminal needs to listen privately (after the context env, so no
 * context key replaces it):
 *   AURA_LISTEN_SUBNET  its servers bind to its address in this subnet
 *                       (provisioning.ts LISTEN_HOST_SHELL)
 *   AURA_SHELL_PEERS    the shell's name on that network, which resolves to
 *                       the address the shell connects from (app-sdk shell-peer)
 */
export function containerNetworkEnv(o: { term?: TermNetwork | null; shellHostname: string }): string[] {
  if (!o.term) return [];
  return [
    '-e', `AURA_LISTEN_SUBNET=${o.term.subnet}`,
    '-e', `AURA_SHELL_PEERS=${o.shellHostname}.${o.term.name}`,
  ];
}

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
