import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Per-instance bearer tokens — the first caller identity the OS API has.
 *
 * Every other `/api/instances/:id/*` route trusts the instance id in the URL,
 * so any caller can act as any instance. That is tolerable for reads and for
 * mount/port grants, but not for an endpoint that STARTS CONTAINERS on an
 * app's behalf (SidecarManager). Those routes require the caller to present
 * the token the OS handed the instance at spawn (`AURA_INSTANCE_TOKEN`).
 *
 * Design: stateless HMAC + a nonce that lives where the container lives.
 *   token  = aura1.<b64url(json {i, s?, n})>.<b64url(HMAC-SHA256(key, payload))>
 *   key    = 32 random bytes in <dataDir>/aura/secrets/instance-token.key (0600)
 *   nonce  = fresh per spawn, recorded as a docker label on the container it
 *            belongs to (`aura.token.nonce`, or inside an OS sidecar's spec
 *            label), and registered here in memory.
 *
 * Nothing to store, garbage-collect or migrate: after a shell restart the
 * nonces come back from `docker inspect` during orphan adoption. A recycled
 * instance id (`app-2` reused) or a deleted sidecar gets a new nonce or none,
 * so every token minted for the previous life stops verifying. Rotating the
 * key file revokes everything.
 *
 * Accepted limit: anything holding the docker socket can read another
 * container's env and with it its token. The socket is host root already, so
 * that adds no exposure.
 */

export interface TokenClaims {
  instanceId: string;
  /** Set when the token belongs to an OS-managed sidecar of `instanceId`. */
  sidecar?: string;
}

interface Payload { i: string; s?: string; n: string }

const PREFIX = 'aura1';

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

/** Map key for a consumer: `<instanceId>` or `<instanceId>--<sidecar>`. */
export function consumerKey(instanceId: string, sidecar?: string): string {
  return sidecar ? `${instanceId}--${sidecar}` : instanceId;
}

export class InstanceTokens {
  private key: Buffer | null = null;
  private readonly nonces = new Map<string, string>();

  constructor(private readonly keyFile: string) {}

  private secret(): Buffer {
    if (this.key) return this.key;
    if (existsSync(this.keyFile)) {
      const raw = readFileSync(this.keyFile);
      if (raw.length >= 32) return (this.key = raw);
    }
    mkdirSync(dirname(this.keyFile), { recursive: true });
    const fresh = randomBytes(32);
    writeFileSync(this.keyFile, fresh, { mode: 0o600 });
    try { chmodSync(this.keyFile, 0o600); } catch { /* best effort on odd filesystems */ }
    return (this.key = fresh);
  }

  private mac(payload: string): Buffer {
    return createHmac('sha256', this.secret()).update(payload).digest();
  }

  private sign(p: Payload): string {
    const payload = b64url(Buffer.from(JSON.stringify(p)));
    return `${PREFIX}.${payload}.${b64url(this.mac(payload))}`;
  }

  /** New token + nonce for a spawn. The nonce is registered immediately. */
  mint(instanceId: string, sidecar?: string): { token: string; nonce: string } {
    const nonce = b64url(randomBytes(12));
    this.register(instanceId, nonce, sidecar);
    return { token: this.sign({ i: instanceId, ...(sidecar ? { s: sidecar } : {}), n: nonce }), nonce };
  }

  /** Re-register a nonce read back from a container label (adoption, reconcile). */
  register(instanceId: string, nonce: string, sidecar?: string): void {
    this.nonces.set(consumerKey(instanceId, sidecar), nonce);
  }

  /** Drop one consumer's nonce: its tokens stop verifying. */
  forget(instanceId: string, sidecar?: string): void {
    this.nonces.delete(consumerKey(instanceId, sidecar));
  }

  /** Drop an instance AND every sidecar under it (instance stopped / crashed). */
  forgetInstance(instanceId: string): void {
    for (const k of [...this.nonces.keys()]) {
      if (k === instanceId || k.startsWith(`${instanceId}--`)) this.nonces.delete(k);
    }
  }

  hasNonce(instanceId: string, sidecar?: string): boolean {
    return this.nonces.has(consumerKey(instanceId, sidecar));
  }

  /** Claims of a valid, current token, or null. Never throws. */
  verify(token: string | null | undefined): TokenClaims | null {
    if (!token) return null;
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== PREFIX) return null;
    const [, payload, sig] = parts as [string, string, string];
    let given: Buffer;
    try { given = Buffer.from(sig, 'base64url'); } catch { return null; }
    const want = this.mac(payload);
    if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
    let p: Payload;
    try { p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as Payload; } catch { return null; }
    if (typeof p.i !== 'string' || typeof p.n !== 'string') return null;
    const current = this.nonces.get(consumerKey(p.i, p.s));
    if (!current || current !== p.n) return null;
    return { instanceId: p.i, ...(p.s ? { sidecar: p.s } : {}) };
  }
}
