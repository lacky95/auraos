/**
 * Whether a connection to an app's server comes from the shell (server only).
 *
 * For apps whose server acts for the owner, so that only calls the shell
 * relays reach them and the shell decides who that may be (D28, D29):
 *
 *   com.aura.aurashelld  its MCP (H3): a trusted owner agent, whose token
 *                        carries the owner's authority
 *   com.aura.terminal    its PTY socket, MCP and session API (H4 stopgap):
 *                        the owner's shell on `aura-net`
 *
 * The shell relays through `/api/proxy` (only the owner and the System
 * Terminal reach these apps there) and its App Hosts (the owner's session).
 * A direct call from another container on the app network is refused. The
 * shell is the host OS_API_BASE names, by every address Docker's DNS gives
 * for it; a TCP peer address there can't be taken over without the reply
 * (the reasoning of the shell's D28 table). Loopback and the container's
 * own addresses are the app itself (a tool in the Terminal calling its own
 * server by name).
 *
 * Phase 5's private Terminal network (D58) is the boundary now: the Terminal's
 * servers listen only there, where only the shell and that user's Terminals
 * are. This check stays as the second layer (another Terminal is no shell).
 * On that network the shell connects from its address there, which its plain
 * name need not resolve to when the container is on two networks: the runtime
 * names it in `AURA_SHELL_PEERS` (comma-separated host names), resolved too.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';

export interface ShellPeerDeps {
  /** The shell's base URL (OS_API_BASE). */
  base(): string | undefined;
  /** More host names of the shell (AURA_SHELL_PEERS): its name on a private network. */
  peers?(): string[];
  resolve(host: string): Promise<string[]>;
  /** This container's own addresses. */
  own?(): string[];
  now?(): number;
}

/** A miss re-resolves at most this often, so unknown peers can't drive lookups. */
const RETRY_MS = 2_000;

const normalize = (addr: string | null | undefined): string | null => {
  const a = String(addr ?? '').trim().toLowerCase().replace(/^::ffff:/, '');
  return isIP(a) ? a : null;
};

export function createShellPeer(deps: ShellPeerDeps) {
  const now = () => (deps.now ?? Date.now)();
  let addresses = new Set<string>();
  let resolvedAt = -Infinity;

  async function addressesOf(host: string): Promise<string[]> {
    const literal = normalize(host);
    if (literal) return [literal];
    try {
      return (await deps.resolve(host)).map(normalize).filter((a): a is string => a !== null);
    } catch { return []; }
  }

  async function refresh(): Promise<void> {
    resolvedAt = now();
    const hosts: string[] = [];
    try { hosts.push(new URL(deps.base() ?? '').hostname.replace(/^\[|\]$/g, '')); } catch { /* no base: no shell */ }
    if (hosts.length) hosts.push(...(deps.peers?.() ?? []).map((h) => h.trim()).filter(Boolean));
    addresses = new Set((await Promise.all(hosts.map(addressesOf))).flat());
  }

  return async function fromShell(peer: string | null | undefined): Promise<boolean> {
    const a = normalize(peer);
    if (!a) return false;
    if (a.startsWith('127.') || a === '::1') return true;
    if (deps.own?.().some((o) => normalize(o) === a)) return true;
    if (addresses.has(a)) return true;
    if (now() - resolvedAt > RETRY_MS) await refresh();
    return addresses.has(a);
  };
}

/** The live check, over OS_API_BASE and the container's DNS. */
export const fromShell = createShellPeer({
  base: () => process.env['OS_API_BASE'],
  peers: () => (process.env['AURA_SHELL_PEERS'] ?? '').split(','),
  resolve: async (host) => (await lookup(host, { all: true })).map((r) => r.address),
  own: () => Object.values(networkInterfaces()).flat().map((i) => i?.address ?? ''),
});

/** The refusal an HTTP route answers to a caller that is not the shell. */
export function shellOnlyResponse(path: string): Response {
  return new Response(JSON.stringify({
    error: 'shell-only',
    message: `Call this app through the shell: $OS_API_BASE/api/proxy/<app id>${path}`,
  }), { status: 403, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
