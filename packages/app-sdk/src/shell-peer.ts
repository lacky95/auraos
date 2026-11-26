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
 * names it in `AURA_SHELL_PEERS` (comma-separated host names), resolved too. *
 * D89 B4: the address is not proof (D28). The shell signs each call it relays
 * to such an app with a relay claim (`x-aura-relay`, ./relayClaim.ts), keyed
 * from this start's lifecycle token. `checkShellRelay` verifies it on a call
 * from the shell's address: in `strict` (the default since 5-main, the
 * `relay-strict` security option) a missing or invalid claim is refused; in
 * `warn` (`AURA_RELAY_STRICT=warn`, a rollback aid) it is reported in the
 * app's log and still served. The kernel's own lifecycle calls (the runner's
 * hooks and health probes) carry this start's lifecycle token instead
 * (`x-aura-lifecycle`), which proves the kernel just as well. Loopback and
 * the container's own addresses are the app itself and need no claim.
 * `fromShell` stays the address-only check.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { RELAY_CLAIM_HEADER, relayKey, verifyRelayClaim, type RelayClaim } from './relayClaim.js';

export { RELAY_CLAIM_HEADER, type RelayClaim };

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

  /** `self`: this container (loopback, its own addresses); `shell`: the shell's address; null: anyone else. */
  async function peerKind(peer: string | null | undefined): Promise<PeerKind | null> {
    const a = normalize(peer);
    if (!a) return null;
    if (a.startsWith('127.') || a === '::1') return 'self';
    if (deps.own?.().some((o) => normalize(o) === a)) return 'self';
    if (addresses.has(a)) return 'shell';
    if (now() - resolvedAt > RETRY_MS) await refresh();
    return addresses.has(a) ? 'shell' : null;
  }

  async function fromShell(peer: string | null | undefined): Promise<boolean> {
    return (await peerKind(peer)) !== null;
  }
  return Object.assign(fromShell, { peerKind });
}

export type PeerKind = 'self' | 'shell';

/** The live check, over OS_API_BASE and the container's DNS. */
export const fromShell = createShellPeer({
  base: () => process.env['OS_API_BASE'],
  peers: () => (process.env['AURA_SHELL_PEERS'] ?? '').split(','),
  resolve: async (host) => (await lookup(host, { all: true })).map((r) => r.address),
  own: () => Object.values(networkInterfaces()).flat().map((i) => i?.address ?? ''),
});

// ── D89 B4: the relay claim ────────────────────────────────────────────────

/** `kernel`: the call carried this start's lifecycle token (the runner's lifecycle calls). */
export type RelayVerdict = 'valid' | 'missing' | 'invalid' | 'self' | 'kernel';

export interface ShellRelayResult {
  /** Serve the call. */
  ok: boolean;
  /** `self`: this container's own call, no claim needed. Only for a peer that is self or the shell. */
  verdict: RelayVerdict | null;
  /** The verified claim: the instance, call and the user the shell authorized. */
  claim: RelayClaim | null;
}

export interface ShellRelayDeps {
  peerKind(peer: string | null | undefined): Promise<PeerKind | null>;
  /** This start's lifecycle token (AURA_LIFECYCLE_TOKEN); the claim key derives from it. */
  lifecycleToken(): string | undefined;
  /** This instance's id (APP_INSTANCE_ID). */
  instanceId(): string | undefined;
  /** `AURA_RELAY_STRICT`: `warn` serves and reports; anything else (unset included) is `strict`. */
  mode(): string | undefined;
  /** A missing or invalid claim on a call from the shell's address (never the claim's value). */
  report?(verdict: 'missing' | 'invalid', call: { method: string; path: string; mode: 'warn' | 'strict' }): void;
  now?(): number;
}

export function createShellRelay(deps: ShellRelayDeps) {
  let cachedToken: string | undefined;
  let cachedKey: Buffer | null = null;
  const key = (): Buffer | null => {
    const token = deps.lifecycleToken();
    if (!token) return null;
    if (token !== cachedToken) { cachedToken = token; cachedKey = relayKey(token); }
    return cachedKey;
  };

  /**
   * The verdict on one call: `peer` its socket address, `header` the
   * `x-aura-relay` value, `method` and `path` (with query) as this server got them.
   */
  return async function checkShellRelay(call: {
    peer: string | null | undefined; header: string | string[] | null | undefined; method: string; path: string;
    /** The `x-aura-lifecycle` value, if any: the kernel's own call. */
    lifecycle?: string | string[] | null | undefined;
  }): Promise<ShellRelayResult> {
    const kind = await deps.peerKind(call.peer);
    if (kind === null) return { ok: false, verdict: null, claim: null };
    if (kind === 'self') return { ok: true, verdict: 'self', claim: null };
    if (lifecycleTokenMatches(call.lifecycle, deps.lifecycleToken())) return { ok: true, verdict: 'kernel', claim: null };
    const mode = (deps.mode() ?? '').trim().toLowerCase() === 'warn' ? 'warn' : 'strict';
    const header = Array.isArray(call.header) ? call.header[0] : call.header;
    const k = key();
    const instanceId = deps.instanceId();
    const claim = header && k && instanceId
      ? verifyRelayClaim(header, { key: k, instanceId, method: call.method, path: call.path, ...(deps.now ? { now: deps.now() } : {}) })
      : null;
    if (claim) return { ok: true, verdict: 'valid', claim };
    const verdict = header ? 'invalid' : 'missing';
    try { deps.report?.(verdict, { method: call.method, path: call.path, mode }); } catch { /* report-only */ }
    return { ok: mode === 'warn', verdict, claim: null };
  };
}

const digest = (v: string): Buffer => createHash('sha256').update(v).digest();

/** Whether `presented` is this start's lifecycle token (constant time). */
function lifecycleTokenMatches(presented: string | string[] | null | undefined, expected: string | undefined): boolean {
  const p = Array.isArray(presented) ? presented[0] : presented;
  if (!p || !expected) return false;
  return timingSafeEqual(digest(p), digest(expected));
}

const REPORT_EVERY_MS = 60_000;
const reported = new Map<string, number>();
/** Counts since start, by verdict (`missing`, `invalid`): what warn mode let through. */
export const relayCounts: Record<'missing' | 'invalid', number> = { missing: 0, invalid: 0 };

/** One log line per verdict and path a minute; the counts keep every call. */
function reportRelay(verdict: 'missing' | 'invalid', call: { method: string; path: string; mode: 'warn' | 'strict' }): void {
  relayCounts[verdict] += 1;
  const path = call.path.split('?', 1)[0] ?? '';
  const k = `${verdict} ${call.method} ${path}`;
  const t = Date.now();
  if (t - (reported.get(k) ?? 0) < REPORT_EVERY_MS) return;
  if (reported.size > 500) reported.clear();
  reported.set(k, t);
  console.warn(`[shell-peer] relay-claim ${verdict} (${call.mode === 'strict' ? 'refused' : 'warn, served'}): ${call.method} ${path} `
    + `(${relayCounts[verdict]} ${verdict} since start)`);
}

/** The live relay check: the live address check, this start's lifecycle token and AURA_RELAY_STRICT. */
export const checkShellRelay = createShellRelay({
  peerKind: (peer) => fromShell.peerKind(peer),
  lifecycleToken: () => process.env['AURA_LIFECYCLE_TOKEN'] || undefined,
  instanceId: () => process.env['APP_INSTANCE_ID'] || process.env['AURA_INSTANCE_ID'] || undefined,
  mode: () => process.env['AURA_RELAY_STRICT'],
  report: reportRelay,
});

/**
 * D69 (stream T): an app instance that hosts ONE user's sessions (the System
 * Terminal; the runtime names the user in `AURA_SESSION_USER`) serves only
 * calls the shell authorized for that user. The shell checks session
 * ownership before it relays (principal = instance owner); this is the same
 * check at the instance, on the claim it signed:
 *
 *   the claim names a user (`u`)   it must be this instance's user
 *   it names none                  only the shell's own call (`c: system`)
 *   self, kernel                   the instance itself, the kernel's lifecycle call
 *   no claim (warn mode only)      as `warn` serves it
 *
 * Without `AURA_SESSION_USER` (any other app, an app started by hand) the
 * relay result alone decides.
 */
export function relayServesSessionUser(
  r: Pick<ShellRelayResult, 'ok' | 'verdict' | 'claim'>, sessionUser: string | undefined = process.env['AURA_SESSION_USER'] || undefined,
): boolean {
  if (!r.ok) return false;
  if (!sessionUser || r.verdict !== 'valid' || !r.claim) return true;
  if (r.claim.u !== undefined) return r.claim.u === sessionUser;
  return r.claim.c === 'system';
}

/** The refusal an HTTP route answers to a caller that is not the shell. */
export function shellOnlyResponse(path: string): Response {
  return new Response(JSON.stringify({
    error: 'shell-only',
    message: `Call this app through the shell: $OS_API_BASE/api/proxy/<app id>${path}`,
  }), { status: 403, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
