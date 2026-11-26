/**
 * The stored values of the writable security options (options.ts, D64): one
 * record at `user:policy:security`, in the private `user:` namespace that
 * `/api/kv` cannot reach, sealed like the password policy with a MAC from
 * identity.key, so a Valkey writer cannot change it.
 *
 * A missing record, or one that fails its MAC, means the defaults; a bad
 * record is reported once. Who may change it, and the audit entry naming
 * them, are the caller's: the shell's `/api/admin/security-options`, at the
 * `fresh` level.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Redis } from '@aura/kv-store';
import { deriveIdentitySubkey, IdentityKeyError } from '../auth/identityKey.js';
import {
  parseOptionValue, parseSecurityPolicy, securityOption, type SecurityPolicy,
} from './options.js';

export const SECURITY_POLICY_KEY = 'user:policy:security';
/** The audit actions of a change (written by the route) and of a bad record. */
export const SECURITY_AUDIT_ACTIONS = {
  optionChanged: 'security.option-changed',
  policyTampered: 'security.policy-tampered',
} as const;

const SET_IF_UNCHANGED = `if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2]) return 1 end return 0`;

export class SecurityOptionError extends Error {
  constructor(readonly code: 'unknown-option' | 'not-writable' | 'invalid-value', message: string) {
    super(message);
    this.name = 'SecurityOptionError';
  }
}

export type SecurityOptionChangeResult =
  | { ok: true; changed: boolean; previous: boolean | string; value: boolean | string }
  | { ok: false; reason: 'conflict' };

export interface SecurityPolicyStoreOptions {
  identityKeyFile: string;
  redis: () => Redis;
  /** The stored record failed its MAC, so the defaults apply. Reported once per record. */
  onTampered?: () => void;
}

/** Sorted, so the MAC never depends on key order. */
const canonical = (p: SecurityPolicy) => JSON.stringify([SECURITY_POLICY_KEY, 1, Object.entries(p).sort(([a], [b]) => a.localeCompare(b))]);

export class SecurityPolicyStore {
  private reportedTamper: string | null = null;

  constructor(private readonly opts: SecurityPolicyStoreOptions) {}

  private mac(p: SecurityPolicy): Buffer {
    return createHmac('sha256', deriveIdentitySubkey(this.opts.identityKeyFile, 'security-policy')).update(canonical(p)).digest();
  }

  private seal(p: SecurityPolicy): string {
    return JSON.stringify({ v: 1, values: p, mac: this.mac(p).toString('base64url') });
  }

  /** The stored values if the MAC holds, else null. Reports a bad record once. */
  private unseal(raw: string): SecurityPolicy | null {
    try {
      const o = JSON.parse(raw) as Record<string, unknown>;
      const values = o['v'] === 1 ? parseSecurityPolicy(o['values']) : null;
      if (!values || typeof o['mac'] !== 'string') throw new Error('shape');
      const given = Buffer.from(o['mac'], 'base64url');
      const want = this.mac(values);
      if (given.length !== want.length || !timingSafeEqual(given, want)) throw new Error('mac');
      return values;
    } catch (err) {
      if (err instanceof IdentityKeyError) return null;
      const digest = createHash('sha256').update(raw).digest('hex');
      if (digest !== this.reportedTamper) {
        this.reportedTamper = digest;
        this.opts.onTampered?.();
      }
      return null;
    }
  }

  /** The stored values; missing or tampered means `{}` (every default). */
  async get(): Promise<SecurityPolicy> {
    const raw = await this.opts.redis().get(SECURITY_POLICY_KEY);
    return (raw && this.unseal(raw)) || {};
  }

  /**
   * Set one `policy` option. The caller has decided who may (the owner at
   * `fresh`, or the host operator). Compare-and-set, so a concurrent change
   * is never overwritten.
   */
  async set(id: string, raw: unknown): Promise<SecurityOptionChangeResult> {
    const option = securityOption(id);
    if (!option) throw new SecurityOptionError('unknown-option', `unknown security option: ${id}`);
    if (option.source !== 'policy') throw new SecurityOptionError('not-writable', `${id} is not stored by AuraOS`);
    const value = parseOptionValue(option, raw);
    if (value === undefined) throw new SecurityOptionError('invalid-value', `invalid value for ${id}`);
    deriveIdentitySubkey(this.opts.identityKeyFile, 'security-policy'); // Fail before writing on a bad key.

    const r = this.opts.redis();
    const stored = await r.get(SECURITY_POLICY_KEY);
    const current = (stored && this.unseal(stored)) || {};
    const previous = current[id] ?? (option.default as boolean | string);
    if (previous === value) return { ok: true, changed: false, previous, value };
    const next = { ...current, [id]: value };
    const written = stored
      ? (await r.eval(SET_IF_UNCHANGED, 1, SECURITY_POLICY_KEY, stored, this.seal(next))) === 1
      : (await r.set(SECURITY_POLICY_KEY, this.seal(next), 'NX')) === 'OK';
    if (!written) return { ok: false, reason: 'conflict' };
    this.reportedTamper = null;
    return { ok: true, changed: true, previous, value };
  }
}
