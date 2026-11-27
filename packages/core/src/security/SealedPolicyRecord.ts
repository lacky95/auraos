/**
 * One sealed owner record in Valkey's private `user:` namespace (which
 * `/api/kv` cannot reach): the value with a MAC from a purpose-bound subkey of
 * identity.key, written by compare-and-set. A Valkey writer can delete the
 * record but cannot forge or change it.
 *
 * Shared by the security options (`user:policy:security`), the Runtime
 * Settings (`user:policy:runtimes`, ARI §9.7) and the app setup records
 * (`app:config:*`, D108, one instance per key): the seal, the MAC check, the
 * report-once of a bad record and the compare-and-set live here once (D36).
 * What the value is, and the defaults a missing or bad record means, are the
 * caller's.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Redis } from '@aura/kv-store';
import { deriveIdentitySubkey, IdentityKeyError } from '../auth/identityKey.js';

const SET_IF_UNCHANGED = `if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2]) return 1 end return 0`;
const DEL_IF_UNCHANGED = `if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('DEL', KEYS[1]) return 1 end return 0`;

export type SealedRecordPurpose = 'security-policy' | 'runtime-policy' | 'app-config';

export interface SealedPolicyRecordOptions<T> {
  /** The Valkey key, in a namespace `/api/kv` cannot reach (`user:`, `app:config:`). */
  key: string;
  /** The identity.key subkey the MAC uses: a MAC of one record never passes for another. */
  purpose: SealedRecordPurpose;
  identityKeyFile: string;
  redis: () => Redis;
  /** The value from the stored JSON, or null when it is not a valid one. */
  parse(raw: unknown): T | null;
  /** The bytes the MAC covers: equal values give equal bytes (sort keys). */
  canonical(value: T): string;
  /** The stored record failed its MAC or its shape. Reported once per stored record. */
  onTampered?: () => void;
}

/** A read: the trusted value (null when missing or bad) and the stored bytes for a compare-and-set. */
export interface SealedRead<T> {
  value: T | null;
  stored: string | null;
  /** A stored record failed its MAC or its shape (not set for an unusable identity.key). */
  tampered?: boolean;
}

export class SealedPolicyRecord<T> {
  private reportedTamper: string | null = null;

  constructor(private readonly opts: SealedPolicyRecordOptions<T>) {}

  private mac(value: T): Buffer {
    return createHmac('sha256', deriveIdentitySubkey(this.opts.identityKeyFile, this.opts.purpose))
      .update(this.opts.canonical(value)).digest();
  }

  private seal(value: T): string {
    return JSON.stringify({ v: 1, values: value, mac: this.mac(value).toString('base64url') });
  }

  /** The stored value if the MAC holds, else null (`bad`: it failed). Reports a bad record once. */
  private unseal(raw: string): { value: T | null; bad: boolean } {
    try {
      const o = JSON.parse(raw) as Record<string, unknown>;
      const value = o['v'] === 1 ? this.opts.parse(o['values']) : null;
      if (value === null || typeof o['mac'] !== 'string') throw new Error('shape');
      const given = Buffer.from(o['mac'], 'base64url');
      const want = this.mac(value);
      if (given.length !== want.length || !timingSafeEqual(given, want)) throw new Error('mac');
      return { value, bad: false };
    } catch (err) {
      if (err instanceof IdentityKeyError) return { value: null, bad: false };
      const digest = createHash('sha256').update(raw).digest('hex');
      if (digest !== this.reportedTamper) {
        this.reportedTamper = digest;
        this.opts.onTampered?.();
      }
      return { value: null, bad: true };
    }
  }

  /** The trusted value and the stored bytes. A Valkey error throws. */
  async read(): Promise<SealedRead<T>> {
    const stored = await this.opts.redis().get(this.opts.key);
    if (!stored) return { value: null, stored };
    const { value, bad } = this.unseal(stored);
    return { value, stored, ...(bad ? { tampered: true } : {}) };
  }

  /** Throws before a write when identity.key is unusable. */
  assertKey(): void {
    deriveIdentitySubkey(this.opts.identityKeyFile, this.opts.purpose);
  }

  /**
   * Write `next` only if the record still holds `stored` (null: only if there
   * is none). False when someone else changed it meanwhile.
   */
  async compareAndSet(stored: string | null, next: T): Promise<boolean> {
    this.assertKey();
    const r = this.opts.redis();
    const written = stored
      ? (await r.eval(SET_IF_UNCHANGED, 1, this.opts.key, stored, this.seal(next))) === 1
      : (await r.set(this.opts.key, this.seal(next), 'NX')) === 'OK';
    if (written) this.reportedTamper = null;
    return written;
  }

  /** Delete the record only if it still holds `stored`. False when it changed meanwhile. */
  async compareAndDelete(stored: string): Promise<boolean> {
    const deleted = (await this.opts.redis().eval(DEL_IF_UNCHANGED, 1, this.opts.key, stored)) === 1;
    if (deleted) this.reportedTamper = null;
    return deleted;
  }
}
