/**
 * Capability definitions the owner added (SF-2): `aura cap registry add`.
 * One record at `user:capabilities:registry`, in the private `user:` namespace
 * `/api/kv` cannot reach, sealed with a MAC from identity.key (like the
 * security options, SecurityPolicyStore), so a Valkey writer can neither add
 * an entry nor change one. Each entry keeps the digest the owner approved
 * when it was added (`capabilityDigest`); an entry whose definition no longer
 * matches its digest, or a record that fails its MAC, is not used.
 *
 * Who may add (the owner, `fresh`) and the audit entry are the caller's: the
 * shell's `/api/admin/cap-registry`.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Redis } from '@aura/kv-store';
import { deriveIdentitySubkey, IdentityKeyError } from '../auth/identityKey.js';
import { capabilityDigest, parseCapabilityDefinition, type CapabilityDefinition } from './definition.js';

export const CAPABILITY_REGISTRY_KEY = 'user:capabilities:registry';

export interface CapabilityRegistryEntry {
  definition: CapabilityDefinition;
  /** `capabilityDigest(name, definition)`, as approved when it was added. */
  digest: string;
  addedAt: string;
  /** The approval it was added with, if any (the desktop owner and the operator act directly). */
  approval?: string;
}

export type CapabilityRegistryChange = { ok: true; changed: boolean } | { ok: false; reason: 'conflict' };

export interface CapabilityRegistryStoreOptions {
  identityKeyFile: string;
  redis: () => Redis;
  onTampered?: () => void;
}

type Entries = Record<string, CapabilityRegistryEntry>;
const SET_IF_UNCHANGED = `if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2]) return 1 end return 0`;
const canonical = (e: Entries) => JSON.stringify([CAPABILITY_REGISTRY_KEY, 1, Object.entries(e).sort(([a], [b]) => a.localeCompare(b))]);

export class CapabilityRegistryStore {
  private reportedTamper: string | null = null;

  constructor(private readonly opts: CapabilityRegistryStoreOptions) {}

  private mac(e: Entries): Buffer {
    return createHmac('sha256', deriveIdentitySubkey(this.opts.identityKeyFile, 'capability-registry')).update(canonical(e)).digest();
  }

  private seal(e: Entries): string {
    return JSON.stringify({ v: 1, entries: e, mac: this.mac(e).toString('base64url') });
  }

  private unseal(raw: string): Entries | null {
    try {
      const o = JSON.parse(raw) as { v?: unknown; entries?: unknown; mac?: unknown };
      if (o.v !== 1 || !o.entries || typeof o.entries !== 'object' || typeof o.mac !== 'string') throw new Error('shape');
      const entries = o.entries as Entries;
      const given = Buffer.from(o.mac, 'base64url');
      const want = this.mac(entries);
      if (given.length !== want.length || !timingSafeEqual(given, want)) throw new Error('mac');
      return entries;
    } catch (err) {
      if (err instanceof IdentityKeyError) return null;
      this.tampered(raw);
      return null;
    }
  }

  private tampered(raw: string): void {
    const digest = createHash('sha256').update(raw).digest('hex');
    if (digest !== this.reportedTamper) {
      this.reportedTamper = digest;
      this.opts.onTampered?.();
    }
  }

  /** The entries whose MAC holds and whose definition still validates and matches its digest. */
  async list(): Promise<Record<string, CapabilityRegistryEntry>> {
    const raw = await this.opts.redis().get(CAPABILITY_REGISTRY_KEY);
    const entries = raw ? this.unseal(raw) : null;
    const out: Record<string, CapabilityRegistryEntry> = {};
    for (const [name, e] of Object.entries(entries ?? {})) {
      try {
        const definition = parseCapabilityDefinition(name, e.definition);
        if (capabilityDigest(name, definition) !== e.digest) throw new Error('digest');
        out[name] = { ...e, definition };
      } catch {
        if (raw) this.tampered(raw);
      }
    }
    return out;
  }

  /** Add or replace one entry (the caller has the owner's approval for exactly this digest). Compare-and-set. */
  async put(name: string, definition: CapabilityDefinition, meta: { approval?: string; now?: Date } = {}): Promise<CapabilityRegistryChange & { digest?: string }> {
    const def = parseCapabilityDefinition(name, definition);
    const digest = capabilityDigest(name, def);
    return this.change((cur) => {
      if (cur[name]?.digest === digest) return null;
      return { ...cur, [name]: { definition: def, digest, addedAt: (meta.now ?? new Date()).toISOString(), ...(meta.approval ? { approval: meta.approval } : {}) } };
    }, digest);
  }

  async remove(name: string): Promise<CapabilityRegistryChange> {
    return this.change((cur) => {
      if (!cur[name]) return null;
      const next = { ...cur };
      delete next[name];
      return next;
    });
  }

  private async change(apply: (cur: Entries) => Entries | null, digest?: string): Promise<CapabilityRegistryChange & { digest?: string }> {
    deriveIdentitySubkey(this.opts.identityKeyFile, 'capability-registry'); // Fail before writing on a bad key.
    const r = this.opts.redis();
    const stored = await r.get(CAPABILITY_REGISTRY_KEY);
    const current = (stored && this.unseal(stored)) || {};
    const next = apply(current);
    if (!next) return { ok: true, changed: false, ...(digest ? { digest } : {}) };
    const written = stored
      ? (await r.eval(SET_IF_UNCHANGED, 1, CAPABILITY_REGISTRY_KEY, stored, this.seal(next))) === 1
      : (await r.set(CAPABILITY_REGISTRY_KEY, this.seal(next), 'NX')) === 'OK';
    if (!written) return { ok: false, reason: 'conflict' };
    this.reportedTamper = null;
    return { ok: true, changed: true, ...(digest ? { digest } : {}) };
  }
}
