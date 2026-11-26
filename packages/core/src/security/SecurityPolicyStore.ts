/**
 * The stored values of the writable security options (options.ts, D64): one
 * record at `user:policy:security`, in the private `user:` namespace that
 * `/api/kv` cannot reach, sealed like the password policy with a MAC from
 * identity.key (SealedPolicyRecord, shared with the Runtime Settings), so a Valkey writer cannot change it.
 *
 * A missing record, or one that fails its MAC, means the defaults; a bad
 * record is reported once. Who may change it, and the audit entry naming
 * them, are the caller's: the shell's `/api/admin/security-options`, at the
 * `fresh` level.
 */
import type { Redis } from '@aura/kv-store';
import { SealedPolicyRecord } from './SealedPolicyRecord.js';
import {
  parseOptionValue, parseSecurityPolicy, securityOption, type SecurityPolicy,
} from './options.js';

export const SECURITY_POLICY_KEY = 'user:policy:security';
/** The audit actions of a change (written by the route) and of a bad record. */
export const SECURITY_AUDIT_ACTIONS = {
  optionChanged: 'security.option-changed',
  policyTampered: 'security.policy-tampered',
} as const;

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
  private readonly record: SealedPolicyRecord<SecurityPolicy>;

  constructor(opts: SecurityPolicyStoreOptions) {
    this.record = new SealedPolicyRecord<SecurityPolicy>({
      key: SECURITY_POLICY_KEY, purpose: 'security-policy',
      identityKeyFile: opts.identityKeyFile, redis: opts.redis,
      parse: parseSecurityPolicy, canonical,
      ...(opts.onTampered ? { onTampered: opts.onTampered } : {}),
    });
  }

  /** The stored values; missing or tampered means `{}` (every default). */
  async get(): Promise<SecurityPolicy> {
    return (await this.record.read()).value ?? {};
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
    this.record.assertKey(); // Fail before writing on a bad key.

    const { value: stored, stored: bytes } = await this.record.read();
    const current = stored ?? {};
    const previous = current[id] ?? (option.default as boolean | string);
    if (previous === value) return { ok: true, changed: false, previous, value };
    const next = { ...current, [id]: value };
    if (!(await this.record.compareAndSet(bytes, next))) return { ok: false, reason: 'conflict' };
    return { ok: true, changed: true, previous, value };
  }
}
