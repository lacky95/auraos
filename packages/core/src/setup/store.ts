/**
 * The desired-configuration records of D108 (§3.2, shared with D107-a,
 * decision 5): what the owner selected for an installation, and one user's
 * user-scope values.
 *
 *   app:config:<installationId>             installation scope (profile, values, overrides)
 *   app:config:<installationId>:u:<userId>  one user's values (alpha: the owner)
 *
 * Kernel-owned: `app:` is not a KvClient namespace (those are `os`,
 * `app/<id>…`, `context:…`, `user/…`), so `/api/kv` can neither read nor
 * write a record, and no per-app bucket can produce the key. Each record is
 * sealed with a MAC from the `app-config` subkey of identity.key over its key
 * and value (SealedPolicyRecord), so a record copied to another installation
 * or user fails, and a Valkey writer can delete a record but not forge one.
 * Every write is a compare-and-set.
 *
 * Secrets are vault handles (`cred_…`) by field name, never values: a
 * `secrets` entry that is not a handle is refused, so a value cannot land
 * here by mistake. A tampered record reads as absent (`tampered: true`) and
 * is reported once per stored record through `onTampered` (the composition
 * root audits `SETUP_AUDIT_ACTIONS.recordTampered`, `tamperAuditInput`); the
 * state reset is setup/state.ts's.
 *
 * A new installation id has no record (D20, D107 I7). Keep-data uninstall
 * keeps the records with the reserved installation; delete-app-data calls
 * `forgetInstallation`, which revokes the trusted handles through the vault
 * port, then deletes every record of the installation.
 */
import type { Redis } from '@aura/kv-store';
import { SealedPolicyRecord } from '../security/SealedPolicyRecord.js';
import { CREDENTIAL_HANDLE_RE } from '../context/CredentialVault.js';
import type { CredentialVault } from '../context/CredentialVault.js';
import { FIELD_NAME_RE, type ConfigValue, type ConfigValues } from '../config/schema.js';
import { HOME_ENVIRONMENTS, PROFILE_ID_RE } from '../types/setupManifest.js';
import { configRecordKey, SETUP_AUDIT_ACTIONS, type DesiredConfig, type DesiredOverrides } from './contracts.js';

/** Installation ids are UUIDs; user ids follow the vault's rule. Neither may hold `:` or a glob character. */
const INSTALLATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const USER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RUNTIME_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
const UPDATED_BY_RE = /^(?:user:[A-Za-z0-9][A-Za-z0-9._-]{0,63}|operator|kernel)$/;
const OVERRIDE_KEYS = new Set(['homeEnvironment', 'instanceScope', 'environmentScope', 'sandbox']);
const RECORD_KEYS = new Set(['v', 'setupVersion', 'profile', 'values', 'secrets', 'overrides', 'updatedAt', 'updatedBy']);
const MAX_VALUE_BYTES = 4096;
const MAX_FIELDS = 256;

export class SetupStoreError extends Error {
  constructor(readonly code: 'invalid-id' | 'invalid-record' | 'conflict', message: string) {
    super(message);
    this.name = 'SetupStoreError';
  }
}

/** Which record: the installation's, or one user's. */
export interface ConfigRecordRef {
  installationId: string;
  userId?: string;
}

/** A read: the trusted record (null when missing or tampered) and the stored bytes for a compare-and-set. */
export interface DesiredRead {
  value: DesiredConfig | null;
  stored: string | null;
  /** The stored record failed its MAC or shape: treat as absent (state.ts resets to `setup-required` once). */
  tampered: boolean;
}

/** Revokes one handle an installation held (delete-app-data). */
export type RevokeSecretHandle = (userId: string, handle: string) => Promise<void>;

export interface SetupConfigStoreOptions {
  identityKeyFile: string;
  redis: () => Redis;
  /** A stored record failed its MAC or shape. Reported once per stored record. */
  onTampered?: (ref: ConfigRecordRef) => void;
  /** Delete-app-data: revoke a handle in the vault (`vaultHandleRevoker`). Without it, `forgetInstallation` refuses records that hold handles. */
  revokeHandle?: RevokeSecretHandle;
}

function isConfigValue(v: unknown): v is ConfigValue {
  if (typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string') return Buffer.byteLength(v) <= MAX_VALUE_BYTES;
  return Array.isArray(v) && v.length <= 256 && v.every((x) => typeof x === 'string' && Buffer.byteLength(x) <= MAX_VALUE_BYTES);
}

const plainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function parseOverrides(v: unknown): DesiredOverrides | null {
  if (!plainObject(v) || !Object.keys(v).every((k) => OVERRIDE_KEYS.has(k))) return null;
  const o = v as DesiredOverrides;
  if (o.homeEnvironment !== undefined && !(HOME_ENVIRONMENTS as readonly string[]).includes(o.homeEnvironment)) return null;
  if (o.instanceScope !== undefined && o.instanceScope !== 'per-user' && o.instanceScope !== 'shared') return null;
  if (o.environmentScope !== undefined && o.environmentScope !== 'global' && o.environmentScope !== 'user') return null;
  if (o.sandbox !== undefined && (typeof o.sandbox !== 'string' || !RUNTIME_ID_RE.test(o.sandbox))) return null;
  return { ...o };
}

/**
 * A desired-configuration record, or null when `raw` is not a valid one.
 * `user`: a user's record carries no profile and no overrides (installation
 * choices only).
 */
export function parseDesiredConfig(raw: unknown, user = false): DesiredConfig | null {
  if (!plainObject(raw) || !Object.keys(raw).every((k) => RECORD_KEYS.has(k))) return null;
  const r = raw as Record<string, unknown>;
  if (r['v'] !== 1) return null;
  if (!Number.isSafeInteger(r['setupVersion']) || (r['setupVersion'] as number) < 0) return null;
  const profile = r['profile'];
  if (profile !== null && (typeof profile !== 'string' || !PROFILE_ID_RE.test(profile))) return null;
  if (user && profile !== null) return null;
  const values = r['values'];
  const secrets = r['secrets'];
  if (!plainObject(values) || !plainObject(secrets)) return null;
  const valueNames = Object.keys(values);
  const secretNames = Object.keys(secrets);
  if (valueNames.length + secretNames.length > MAX_FIELDS) return null;
  if (!valueNames.every((k) => FIELD_NAME_RE.test(k) && isConfigValue(values[k]))) return null;
  // A secret field holds a vault handle, never a value, and is never also a plain value.
  if (!secretNames.every((k) => FIELD_NAME_RE.test(k) && typeof secrets[k] === 'string' && CREDENTIAL_HANDLE_RE.test(secrets[k] as string) && !(k in values))) return null;
  const overrides = parseOverrides(r['overrides']);
  if (!overrides || (user && Object.keys(overrides).length > 0)) return null;
  if (typeof r['updatedAt'] !== 'string' || Number.isNaN(Date.parse(r['updatedAt']))) return null;
  if (typeof r['updatedBy'] !== 'string' || !UPDATED_BY_RE.test(r['updatedBy'])) return null;
  return {
    v: 1, setupVersion: r['setupVersion'] as number, profile: profile as string | null,
    values: structuredClone(values) as ConfigValues, secrets: { ...(secrets as Record<string, string>) },
    overrides, updatedAt: r['updatedAt'], updatedBy: r['updatedBy'],
  };
}

/** Sorted keys at every level, so equal records give equal bytes. */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (plainObject(v)) {
    return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

function checkRef(ref: ConfigRecordRef): void {
  if (!INSTALLATION_ID_RE.test(ref.installationId)) throw new SetupStoreError('invalid-id', 'invalid installation id');
  if (ref.userId !== undefined && !USER_ID_RE.test(ref.userId)) throw new SetupStoreError('invalid-id', 'invalid user id');
}

/** The audit entry of a tampered record (the composition root writes it; no value, no handle). */
export function tamperAuditInput(ref: ConfigRecordRef): { by: { kind: 'system' }; action: string; target: string; outcome: 'failed'; detail: Record<string, unknown> } {
  return {
    by: { kind: 'system' }, action: SETUP_AUDIT_ACTIONS.recordTampered, target: `installation:${ref.installationId}`, outcome: 'failed',
    detail: { record: ref.userId === undefined ? 'installation' : 'user', ...(ref.userId !== undefined ? { userId: ref.userId } : {}) },
  };
}

/**
 * The vault port of `forgetInstallation`: the handle's app no longer holds it
 * (CredentialVault.removeConsumer; a generated setup secret is removed
 * entirely). One `vault.revoked` audit row per handle revoked (owner
 * decision 2: revocation is audited), with the name, never a value or handle.
 */
export function vaultHandleRevoker(
  vault: Pick<CredentialVault, 'resolve' | 'removeConsumer'>,
  opts: { audit?(entry: { by: { kind: 'system' }; action: string; target: string; outcome: 'ok'; detail: Record<string, unknown> }): Promise<unknown> } = {},
): RevokeSecretHandle {
  return async (userId, handle) => {
    const hit = await vault.resolve(userId, handle);
    if (!hit) return;
    if (!(await vault.removeConsumer(userId, hit.name, hit.consumer))) return;
    try {
      await opts.audit?.({
        by: { kind: 'system' }, action: 'vault.revoked', target: `vault:${hit.name}`, outcome: 'ok',
        detail: {
          name: hit.name, app: hit.consumer, user: userId, via: 'delete-app-data',
          ...(hit.installation ? { installation: hit.installation.installationId, field: hit.installation.field, generated: true } : {}),
        },
      });
    } catch { /* the audit trail must not fail the delete */ }
  };
}

export class SetupConfigStore {
  /** One sealed record per key: each keeps its own report-once memory. */
  private readonly records = new Map<string, SealedPolicyRecord<DesiredConfig>>();

  constructor(private readonly opts: SetupConfigStoreOptions) {}

  private record(ref: ConfigRecordRef): SealedPolicyRecord<DesiredConfig> {
    checkRef(ref);
    const key = configRecordKey(ref.installationId, ref.userId);
    let r = this.records.get(key);
    if (!r) {
      const user = ref.userId !== undefined;
      const onTampered = this.opts.onTampered;
      r = new SealedPolicyRecord<DesiredConfig>({
        key, purpose: 'app-config', identityKeyFile: this.opts.identityKeyFile, redis: this.opts.redis,
        parse: (raw) => parseDesiredConfig(raw, user),
        canonical: (value) => canon([key, 1, value]),
        ...(onTampered ? { onTampered: () => onTampered({ ...ref }) } : {}),
      });
      this.records.set(key, r);
    }
    return r;
  }

  /**
   * The trusted record and its stored bytes. An unusable identity.key throws
   * (never "absent": that would look like a record to set up again); a
   * Valkey error throws.
   */
  async read(ref: ConfigRecordRef): Promise<DesiredRead> {
    const record = this.record(ref);
    record.assertKey();
    const r = await record.read();
    return { value: r.value, stored: r.stored, tampered: r.tampered === true };
  }

  async get(ref: ConfigRecordRef): Promise<DesiredConfig | null> {
    return (await this.read(ref)).value;
  }

  /**
   * Write `next` only if the record still holds `stored` (null: only if there
   * is none, or pass the tampered bytes to replace a tampered one). False on
   * a lost race. Throws `invalid-record` before writing a record that is not
   * valid (a secret that is not a handle, a profile on a user record, …).
   */
  async compareAndSet(ref: ConfigRecordRef, stored: string | null, next: DesiredConfig): Promise<boolean> {
    const record = this.record(ref);
    const valid = parseDesiredConfig(next, ref.userId !== undefined);
    if (!valid) throw new SetupStoreError('invalid-record', 'not a valid desired-configuration record (secrets must be vault handles)');
    return record.compareAndSet(stored, valid);
  }

  /**
   * Read, apply `mutate` (null: no record or a tampered one), and write by
   * compare-and-set. `{ ok: false }` on a lost race: the caller re-reads.
   */
  async update(ref: ConfigRecordRef, mutate: (cur: DesiredConfig | null) => DesiredConfig): Promise<{ ok: true; value: DesiredConfig; changed: boolean } | { ok: false; reason: 'conflict' }> {
    const cur = await this.read(ref);
    const next = mutate(cur.value ? structuredClone(cur.value) : null);
    if (cur.value && canon(cur.value) === canon(next)) return { ok: true, value: cur.value, changed: false };
    if (!(await this.compareAndSet(ref, cur.stored, next))) return { ok: false, reason: 'conflict' };
    return { ok: true, value: next, changed: true };
  }

  /** The user ids that hold a record for this installation (SCAN; the id has no glob character). */
  async userIds(installationId: string): Promise<string[]> {
    checkRef({ installationId });
    const prefix = `${configRecordKey(installationId)}:u:`;
    const out: string[] = [];
    let cursor = '0';
    do {
      const [next, keys] = await this.opts.redis().scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 200);
      cursor = next;
      for (const k of keys) {
        const userId = k.slice(prefix.length);
        if (USER_ID_RE.test(userId)) out.push(userId);
      }
    } while (cursor !== '0');
    return [...new Set(out)].sort();
  }

  /**
   * Delete app data: revoke the handles of every trusted record of the
   * installation (in `ownerUserId`'s vault for installation secrets, the
   * user's for theirs), then delete the records. A failed revocation throws
   * before its record is deleted, so the delete can be repeated. A tampered
   * record's handles are not trusted and not revoked; the record is deleted.
   */
  async forgetInstallation(installationId: string, ownerUserId: string): Promise<{ records: number; revoked: number }> {
    if (!USER_ID_RE.test(ownerUserId)) throw new SetupStoreError('invalid-id', 'invalid user id');
    const refs: ConfigRecordRef[] = [{ installationId }, ...(await this.userIds(installationId)).map((userId) => ({ installationId, userId }))];
    let records = 0;
    let revoked = 0;
    for (const ref of refs) {
      for (let attempt = 0; ; attempt++) {
        const cur = await this.read(ref);
        if (cur.stored === null) break;
        const handles = Object.values(cur.value?.secrets ?? {});
        if (handles.length && !this.opts.revokeHandle) throw new SetupStoreError('invalid-record', 'no vault port to revoke the setup secrets');
        for (const h of handles) await this.opts.revokeHandle!(ref.userId ?? ownerUserId, h);
        revoked += handles.length;
        if (await this.record(ref).compareAndDelete(cur.stored)) { records++; break; }
        if (attempt >= 8) throw new SetupStoreError('conflict', 'a setup record kept changing while it was deleted');
      }
    }
    for (const ref of refs) this.records.delete(configRecordKey(ref.installationId, ref.userId));
    return { records, revoked };
  }
}
