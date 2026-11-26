/**
 * Which Context keys reach an app (Phase 5 stream C, Q7, D56): the one rule
 * for the spawn env and for `osClient.context.get` (D48).
 *
 * A key reaches an app only when the app DECLARES it (manifest `context[]`)
 * and it is GRANTED. For an instance that acts for a user, the key resolves
 * from that user's vault first (`context:user:<userId>`, the app's raw-read
 * grant `credential.read:<KEY>` in that vault, D56: personal keys belong to
 * the user), then from the system Context (the app's `context.read:<KEY>`,
 * OS-wide). Nothing else: no broadcast env, no `/run/context` mount.
 *
 * For the env a system key must also be injected as `env` (its owner's
 * choice in Settings → Context); `file` keys are materialised for the AuraOS
 * shells only (ContextStore). A vault key has no inject set: its raw-read
 * grant is the owner's audited answer, and every read of it is audited.
 *
 * Grants are pinned to the app's install scope, like every app grant: a
 * clone or scaffold that shadows the app under the same id does not inherit
 * them. Values never appear in a log, an error or the audit trail.
 */
import type { GrantRecord, GrantStore } from '../auth/GrantStore.js';
import { contextReadPermission, credentialReadPermission, userScope } from '../auth/GrantStore.js';
import { OS_SCOPE, type GrantScope } from '../auth/types.js';
import type { AuditInput } from '../auth/AdminAudit.js';
import type { ContextStore } from './ContextStore.js';
import type { CredentialVault } from './CredentialVault.js';

/** Where a granted key's value came from. */
export type ContextSource = 'vault' | 'system';

export interface GrantedContextRequest {
  appId: string;
  /** The app's manifest `context[]`. */
  declared: readonly string[] | undefined;
  /** The user the instance acts for (its owner); absent: the system Context only. */
  userId?: string;
  /** The instance, for the audit row of a vault read. */
  instanceId?: string;
}

export interface GrantedContextDeps {
  /** Whether the app holds `context.read:<key>` (OS-wide, pinned to its install scope). */
  systemGranted(appId: string, key: string): Promise<boolean>;
  /** Whether the app holds `credential.read:<key>` in `userId`'s vault (pinned likewise). */
  vaultGranted(appId: string, userId: string, key: string): Promise<boolean>;
  /** The system values of `keys` whose inject set has `env` (ContextStore.resolveEnv). */
  systemEnv(keys: readonly string[]): Promise<Record<string, string>>;
  /** One system value, whatever its inject set; null when unset. */
  systemValue(key: string): Promise<string | null>;
  /** One vault value, recorded as used and audited; null when the user has none. */
  vaultValue(userId: string, key: string, read: { appId: string; instanceId?: string; via: string }): Promise<string | null>;
}

/** Why `context.get` gets no value. */
export type ContextRefusal = 'undeclared' | 'not-granted' | 'not-set';

const KEY_RE = /^[A-Z_][A-Z0-9_]*$/;

function declaredKeys(declared: readonly string[] | undefined): string[] {
  return [...new Set((declared ?? []).filter((k) => typeof k === 'string' && KEY_RE.test(k)))].sort();
}

/**
 * The env an app instance starts with: its declared and granted keys, the
 * user's vault first. `sources` names where each key came from (no values).
 */
export async function grantedContextEnv(
  req: GrantedContextRequest, deps: GrantedContextDeps, via = 'spawn-env',
): Promise<{ env: Record<string, string>; sources: Record<string, ContextSource> }> {
  const env: Record<string, string> = {};
  const sources: Record<string, ContextSource> = {};
  const system: string[] = [];
  for (const key of declaredKeys(req.declared)) {
    if (req.userId && await deps.vaultGranted(req.appId, req.userId, key)) {
      const value = await deps.vaultValue(req.userId, key, { appId: req.appId, ...(req.instanceId ? { instanceId: req.instanceId } : {}), via });
      if (value !== null) { env[key] = value; sources[key] = 'vault'; continue; }
    }
    if (await deps.systemGranted(req.appId, key)) system.push(key);
  }
  if (system.length) {
    const values = await deps.systemEnv(system);
    for (const key of system) {
      if (values[key] !== undefined) { env[key] = values[key]; sources[key] = 'system'; }
    }
  }
  return { env, sources };
}

/** `osClient.context.get(key)`: the same rule for one key (any inject target of a system key). */
export async function grantedContextValue(
  req: GrantedContextRequest & { key: string }, deps: GrantedContextDeps,
): Promise<{ value: string; source: ContextSource } | { refused: ContextRefusal }> {
  if (!declaredKeys(req.declared).includes(req.key)) return { refused: 'undeclared' };
  const vault = !!req.userId && await deps.vaultGranted(req.appId, req.userId, req.key);
  if (vault) {
    const value = await deps.vaultValue(req.userId!, req.key, { appId: req.appId, ...(req.instanceId ? { instanceId: req.instanceId } : {}), via: 'context.get' });
    if (value !== null) return { value, source: 'vault' };
  }
  const system = await deps.systemGranted(req.appId, req.key);
  if (!system) return { refused: vault ? 'not-set' : 'not-granted' };
  const value = await deps.systemValue(req.key);
  return value === null ? { refused: 'not-set' } : { value, source: 'system' };
}

/**
 * Whether an app grant counts: it exists and was given for the app's
 * current install scope (a shadowing copy from another scope has to be
 * granted again).
 */
export function appGrantCounts(record: Pick<GrantRecord, 'appScope'> | null, currentScope: string | undefined): boolean {
  if (!record) return false;
  return !(record.appScope && currentScope && record.appScope !== currentScope);
}

export interface LiveGrantedContextOptions {
  grants: Pick<GrantStore, 'get'>;
  /** The install scope an app id resolves to now. */
  appScope(appId: string): string | undefined;
  store: Pick<ContextStore, 'resolveEnv' | 'get'>;
  vault: Pick<CredentialVault, 'reveal'>;
  audit(entry: AuditInput): Promise<unknown>;
}

/** The live deps: GrantStore, the system Context, the vault, the admin audit. */
export function liveGrantedContextDeps(o: LiveGrantedContextOptions): GrantedContextDeps {
  const held = async (appId: string, permission: string, scope: GrantScope) =>
    appGrantCounts(await o.grants.get({ kind: 'app', id: appId }, permission, scope), o.appScope(appId));
  return {
    systemGranted: (appId, key) => held(appId, contextReadPermission(key), OS_SCOPE),
    vaultGranted: (appId, userId, key) => held(appId, credentialReadPermission(key), userScope(userId)),
    systemEnv: (keys) => o.store.resolveEnv(keys),
    systemValue: (key) => o.store.get(key),
    vaultValue: async (userId, key, read) => {
      const value = await o.vault.reveal(userId, key, read.appId);
      try {
        await o.audit({
          by: { kind: 'system' }, action: 'vault.read', target: `vault:${key}`, outcome: value === null ? 'failed' : 'ok',
          detail: { name: key, app: read.appId, ...(read.instanceId ? { instance: read.instanceId } : {}), user: userId, via: read.via },
        });
      } catch { /* the audit trail must not fail the read */ }
      return value;
    },
  };
}
