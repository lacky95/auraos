/**
 * The shell's relay claim (D28/D89 B4): proof, on a call the shell forwards
 * to an owner-agent app's server (the Terminal, aurashelld), that the shell
 * itself relayed it and which caller it authorized. It replaces the peer
 * address as that proof (H3/H4, app-sdk shell-peer): an address is at most a
 * second factor.
 *
 *   x-aura-relay: agr1.<b64url(json RelayClaim)>.<b64url(HMAC-SHA256(key, payload))>
 *
 * The `agw1` format of the App Host gateway claim (shell gateway-identity.mjs),
 * under its own prefix. The key is derived from the instance's per-start
 * lifecycle token (`AURA_LIFECYCLE_TOKEN`), the secret the kernel and that one
 * start already share, so no key is distributed: `HMAC-SHA256(lifecycleToken,
 * "aura-relay-v1")`. A claim names the instance, method and path, and lives
 * for seconds. The shell removes the header from anything a caller sends
 * (shell-credentials.mjs), so only the shell can put one on a request.
 *
 * The source is packages/core/src/app-hosts/relayClaim.ts. The SDK carries a
 * byte-identical copy at packages/app-sdk/src/relayClaim.ts (an app can
 * install @aura/app-sdk without @aura/core); core's relay-claim test fails if
 * the two differ.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const RELAY_CLAIM_HEADER = 'x-aura-relay';
const PREFIX = 'agr1';
const KEY_LABEL = 'aura-relay-v1';
export const RELAY_CLAIM_TTL_S = 30;

/** What the shell asserts about a call it relays. Never a credential. */
export interface RelayClaim {
  v: 1;
  /** The instance the call is for. */
  i: string;
  /** Method and path (with query) the instance's server receives. */
  m: string;
  p: string;
  /** The user the shell authorized: the owner in the desktop, or the user an instance token names. */
  u?: string;
  /** The login session it rode on (an App Host session), if any. */
  sid?: string;
  /** Who called: `user`, `instance:<instanceId>`, `owner-through:<appId>`, `system`. */
  c?: string;
  iat: number;
  exp: number;
}

/** The claim key of one start: derived from its lifecycle token, never the token itself. */
export function relayKey(lifecycleToken: string): Buffer {
  return createHmac('sha256', lifecycleToken).update(KEY_LABEL).digest();
}

/** `/a/../b?x` and `/b?x` are one path: compare what the server will see. */
export function relayPath(path: string): string {
  const u = new URL(String(path || '/'), 'http://relay');
  return `${u.pathname}${u.search}`;
}

const mac = (key: Buffer, payload: string): Buffer => createHmac('sha256', key).update(payload).digest();

export function signRelayClaim(
  key: Buffer,
  claim: { i: string; m: string; p: string; u?: string; sid?: string; c?: string },
  now = Date.now(),
): string {
  const iat = Math.floor(now / 1000);
  const body: RelayClaim = {
    v: 1, i: claim.i, m: claim.m.toUpperCase(), p: relayPath(claim.p),
    ...(claim.u ? { u: claim.u } : {}), ...(claim.sid ? { sid: claim.sid } : {}), ...(claim.c ? { c: claim.c } : {}),
    iat, exp: iat + RELAY_CLAIM_TTL_S,
  };
  const payload = Buffer.from(JSON.stringify(body)).toString('base64url');
  return `${PREFIX}.${payload}.${mac(key, payload).toString('base64url')}`;
}

/**
 * The claim, if the token is genuine (this key), current, for this instance
 * and for this method and path; null otherwise. Never throws.
 */
export function verifyRelayClaim(
  token: string | null | undefined,
  o: { key: Buffer; instanceId: string; method: string; path: string; now?: number },
): RelayClaim | null {
  try {
    const parts = String(token ?? '').split('.');
    if (parts.length !== 3 || parts[0] !== PREFIX) return null;
    const given = Buffer.from(parts[2]!, 'base64url');
    const want = mac(o.key, parts[1]!);
    if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
    const claim = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf-8')) as RelayClaim;
    if (claim?.v !== 1 || typeof claim.exp !== 'number' || typeof claim.iat !== 'number') return null;
    const seconds = (o.now ?? Date.now()) / 1000;
    if (claim.exp < seconds || claim.iat > seconds + 5) return null;
    if (claim.i !== o.instanceId) return null;
    if (claim.m !== String(o.method).toUpperCase() || claim.p !== relayPath(o.path)) return null;
    return claim;
  } catch {
    return null;
  }
}
