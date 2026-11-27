/**
 * The identity-and-security services: the accessor. The construction lives in
 * the composition root (`system/compose.ts`, D97 Phase 6 K), which hands its
 * factory in here; this module imports no other kernel module at runtime.
 * The instance is pinned on globalThis like AppManager, so the shell's source
 * copy (Vite) and the `dist` copy share it.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ValkeyApprovalStore } from '../approvals/ValkeyApprovalStore.js';
import type { AdminAudit } from './AdminAudit.js';
import type { ApiKeyStore } from './ApiKeyStore.js';
import type { ClientSessionStore } from './ClientSessions.js';
import type { Authorizer } from './Authorizer.js';
import type { GrantStore } from './GrantStore.js';
import type { LoginSessionStore } from './LoginSessionStore.js';
import type { FileSetupTickets } from './setupTickets.js';
import type { ValkeyUserStore } from './ValkeyUserStore.js';
import type { LinuxIdentityStore } from '../identity/LinuxIdentityStore.js';
import type { SecurityPolicyStore } from '../security/SecurityPolicyStore.js';
import type { CapabilityRegistryStore } from '../capabilities/CapabilityRegistryStore.js';

/** Bump when the shape changes, so a singleton made by an older module copy is replaced. */
export const AUTH_SERVICES_VERSION = 10;

export interface AuthServices {
  version: number;
  grants: GrantStore;
  apiKeys: ApiKeyStore;
  audit: AdminAudit;
  authorizer: Authorizer;
  /** Phase 5: lock state per shell client (tab). Not a credential. */
  clientSessions: ClientSessionStore;
  /** The user accounts: the owner and (5-main) members (I.2). */
  users: ValkeyUserStore;
  /** The Linux identity registry (stream I, D70/D84): uid/gid per user and per installation. */
  identity: LinuxIdentityStore;
  /** The one session store: the owner's password sessions. */
  loginSessions: LoginSessionStore;
  /** One-time setup, reset and operator codes. */
  setupTickets: FileSetupTickets;
  /** Owner approvals (5.10). */
  approvals: ValkeyApprovalStore;
  /** The writable security options (D64, security/options.ts). */
  securityPolicy: SecurityPolicyStore;
  /** Capability definitions the owner added (SF-2, capabilities/CapabilityRegistryStore.ts). */
  capabilityRegistry: CapabilityRegistryStore;
}

const GLOBAL_KEY = '__auraAuthServices';
type G = typeof globalThis & { [GLOBAL_KEY]?: AuthServices };

let factory: (() => AuthServices) | null = null;

/** The composition root's constructor (`system/compose.ts`); installed when `@aura/core` loads. */
export function installAuthServicesFactory(create: () => AuthServices): void {
  factory = create;
}

/** The services, constructed once by the composition root's factory. */
export function getAuthServices(): AuthServices {
  const g = globalThis as G;
  const cur = g[GLOBAL_KEY];
  if (cur && cur.version >= AUTH_SERVICES_VERSION) return cur;
  if (!factory) throw new Error('auth services: no composition root (import @aura/core, or call installAuthServicesFactory)');
  return factory();
}

/** The composition root pins what it built (a newer module copy replaces an older shape). */
export function pinAuthServices(svc: AuthServices): void {
  (globalThis as G)[GLOBAL_KEY] = svc;
}

/** True while `svc` is the pinned instance (a replaced singleton's handlers stay quiet). */
export function isCurrentAuthServices(svc: AuthServices): boolean {
  return (globalThis as G)[GLOBAL_KEY] === svc;
}


/**
 * D50 boot migration: the shared admin credential is retired. Its sessions
 * left in Valkey are deleted (audited when there were any). The `admin.key`
 * file stays where it is, unused, with a log line; a later release removes it.
 * Never throws.
 */
export async function retireSharedAdminCredential(
  svc: Pick<AuthServices, 'loginSessions' | 'audit'> = getAuthServices(),
  dataDir: string = process.env['AURA_DATA_DIR'] ?? '/data',
): Promise<{ sessionsRevoked: number; keyFileLeft: boolean }> {
  let sessionsRevoked = 0;
  try {
    sessionsRevoked = await svc.loginSessions.revokeLegacySharedKey();
    if (sessionsRevoked > 0) {
      console.log(`[auth] removed ${sessionsRevoked} session(s) of the retired shared admin credential`);
      await svc.audit.record({ by: { kind: 'system' }, action: 'auth.shared-admin-retired', detail: { sessionsRevoked } }).catch(() => undefined);
    }
  } catch (err) {
    console.warn(`[auth] could not remove the retired admin sessions: ${(err as Error).message}`);
  }
  const keyFile = join(dataDir, 'aura', 'secrets', 'admin.key');
  const keyFileLeft = existsSync(keyFile);
  if (keyFileLeft) {
    console.log(`[auth] ${keyFile} is no longer used: the owner account and the host operator replace the shared admin credential (D50). It is left in place and removed in a later release.`);
  }
  return { sessionsRevoked, keyFileLeft };
}

/**
 * I.2 and stream I boot step (5-pre2): re-seal the v1 owner record as v2,
 * write the username index, and give every enabled account its Linux
 * identity (the owner is 1000). Invisible to the owner: nothing reads the
 * identities yet. Idempotent; never throws (a failure is logged and retried
 * at the next boot).
 */
export async function migrateIdentityRecords(
  svc: Pick<AuthServices, 'users' | 'identity' | 'audit'> = getAuthServices(),
): Promise<void> {
  try {
    const m = await svc.users.migrateRecords();
    if (m.resealed) {
      console.log('[auth] the owner record is now v2 (I.2)');
      await svc.audit.record({ by: { kind: 'system' }, action: 'auth.record-migrated', target: 'user:default', detail: { to: 2 } }).catch(() => undefined);
    }
    if (m.owner === 'untrusted') console.warn('[auth] the owner record failed its integrity check; left for `aura user reset-password`');
    if (m.conflicts) console.warn(`[auth] ${m.conflicts} username index entr${m.conflicts === 1 ? 'y names' : 'ies name'} another account`);
    for (const u of await svc.users.listUsers()) {
      if (!u.disabled) await svc.identity.ensureUser(u.id);
    }
  } catch (err) {
    console.warn(`[auth] identity record migration failed: ${(err as Error).message}`);
  }
}

/** Tests / soft-restart. */
export function resetAuthServices(): void {
  delete (globalThis as G)[GLOBAL_KEY];
}
