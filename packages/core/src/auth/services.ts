/**
 * Shell-wide auth singletons on globalThis (like AppManager / the
 * notification service), on the central Valkey (`defaultRedis()`).
 *
 * The Authorizer reads app manifests and install scopes from the live
 * AppManager registry, lazily, so this module never forces AppManager init.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { defaultRedis } from '@aura/kv-store';
import { getAppManager } from '../app-manager/AppManager.js';
import { ValkeyApprovalStore } from '../approvals/ValkeyApprovalStore.js';
import { AdminAudit, IDENTITY_AUDIT_ACTIONS, operatorAttribution } from './AdminAudit.js';
import { ApiKeyStore } from './ApiKeyStore.js';
import { ClientSessionStore } from './ClientSessions.js';
import { Authorizer } from './Authorizer.js';
import { GrantStore } from './GrantStore.js';
import { defaultIdentityKeyFile } from './identityKey.js';
import { LoginSessionStore, loginSessionKey } from './LoginSessionStore.js';
import { OsEventBus } from '../ipc/OsEventBus.js';
import { defaultSetupTicketDir, FileSetupTickets } from './setupTickets.js';
import { ValkeyUserStore } from './ValkeyUserStore.js';
import { LinuxIdentityStore, defaultHighWaterMarkFile } from '../identity/LinuxIdentityStore.js';
import { SECURITY_AUDIT_ACTIONS, SecurityPolicyStore } from '../security/SecurityPolicyStore.js';
import { CapabilityRegistryStore } from '../capabilities/CapabilityRegistryStore.js';

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

function registry() {
  try { return getAppManager().registry; } catch { return null; }
}

export function getAuthServices(): AuthServices {
  const g = globalThis as G;
  const cur = g[GLOBAL_KEY];
  if (cur && cur.version >= AUTH_SERVICES_VERSION) return cur;

  const redis = () => defaultRedis();
  const grants = new GrantStore(redis);
  const audit = new AdminAudit(redis);
  const loginSessions = new LoginSessionStore({ identityKeyFile: defaultIdentityKeyFile(), redis });
  const authorizer = new Authorizer({
    grants,
    declared: (appId) => registry()?.getById(appId)?.permissions,
    appBinding: async (appId) => {
      try { return await getAppManager().appGrantBinding(appId); } catch { return { scope: undefined, installationId: null }; }
    },
  });
  const identity = new LinuxIdentityStore({ redis, hwmFile: defaultHighWaterMarkFile() });
  const clientSessions = new ClientSessionStore({ redis });
  const users = new ValkeyUserStore({
    identityKeyFile: defaultIdentityKeyFile(),
    redis,
    identity,
    clientSessions,
    onTampered: () => {
      console.warn('[auth] a user record failed its integrity check');
      void audit.record({ by: { kind: 'system' }, action: IDENTITY_AUDIT_ACTIONS.recordTampered, outcome: 'failed' }).catch(() => undefined);
    },
    onIdentityKeyError: (err) => {
      console.error(`[auth] ${err.message}`);
      void audit.record({ by: { kind: 'system' }, action: IDENTITY_AUDIT_ACTIONS.identityKeyError, outcome: 'failed' }).catch(() => undefined);
    },
    sessions: loginSessions,
    audit,
    onPolicyTampered: () => {
      console.warn('[auth] the password policy failed its integrity check; the defaults apply');
      void audit.record({ by: { kind: 'system' }, action: IDENTITY_AUDIT_ACTIONS.passwordPolicyTampered, outcome: 'failed' }).catch(() => undefined);
    },
    onOwnerRecovered: async (e) => {
      await audit.record({
        by: operatorAttribution(), action: IDENTITY_AUDIT_ACTIONS.ownerRecovered, target: `user:${e.userId}`,
        outcome: e.sessionsRevoked === null ? 'failed' : 'ok',
        detail: { username: e.username, recordTrusted: e.recordTrusted, usernameSource: e.usernameSource, sessionsRevoked: e.sessionsRevoked },
      });
    },
  });
  // The CLI creates tickets without Valkey, so the shell audits them from their event files.
  const auditCreatedTickets = async () => {
    await setupTickets.drainCreatedEvents(async (e) => {
      // By id (C6): the CLI names a reset's account by username, resolved here; the name stays in detail.
      const userId = e.userId ?? (e.username ? await users.userIdOf(e.username).catch(() => null) : null);
      await audit.record({
        by: operatorAttribution(), action: IDENTITY_AUDIT_ACTIONS.ticketCreated,
        ...(userId ? { target: `user:${userId}` } : {}),
        detail: { purpose: e.purpose, createdAt: e.at, ...(e.username ? { username: e.username } : {}) },
      });
    });
  };
  const setupTickets: FileSetupTickets = new FileSetupTickets({ dir: defaultSetupTicketDir(), beforeClaim: auditCreatedTickets });
  const svc: AuthServices = {
    version: AUTH_SERVICES_VERSION, grants, apiKeys: new ApiKeyStore(redis), audit, authorizer,
    clientSessions,
    users, identity, loginSessions, setupTickets,
    approvals: new ValkeyApprovalStore({ redis }),
    securityPolicy: new SecurityPolicyStore({
      identityKeyFile: defaultIdentityKeyFile(),
      redis,
      onTampered: () => {
        console.warn('[auth] the security options failed their integrity check; the defaults apply');
        void audit.record({ by: { kind: 'system' }, action: SECURITY_AUDIT_ACTIONS.policyTampered, outcome: 'failed' }).catch(() => undefined);
      },
    }),
    capabilityRegistry: new CapabilityRegistryStore({
      identityKeyFile: defaultIdentityKeyFile(),
      redis,
      onTampered: () => {
        console.warn('[auth] the added capability definitions failed their integrity check; they are not used');
        void audit.record({ by: { kind: 'system' }, action: 'capability.registry-tampered', outcome: 'failed' }).catch(() => undefined);
      },
    }),
  };
  g[GLOBAL_KEY] = svc;
  // D87 B1: a revoked login session (logout, sign out others, reset, disable) ends its shell screens.
  // The event carries no ids, so the screens whose login session is gone are found by lookup.
  OsEventBus.on('auth:sessionsRevoked', () => {
    if ((globalThis as G)[GLOBAL_KEY] !== svc) return; // a replaced singleton's handler stays quiet
    void clientSessions.endRevoked(async (sid) => (await redis().exists(loginSessionKey(sid))) > 0)
      .catch((err) => console.warn(`[auth] ending revoked screens failed: ${(err as Error).message}`));
  });
  void auditCreatedTickets().catch((err) => console.warn(`[auth] ticket audit failed: ${(err as Error).message}`));
  // I.2 / stream I: v1 → v2 owner record, the username index, the accounts' Linux identities (once, idempotent).
  void migrateIdentityRecords(svc);
  // Phase 6 rename: grants of notifications.desktopModal → notifications.systemModal (once, idempotent).
  void grants.migrateLegacy().then(async (moved) => {
    for (const m of moved) {
      const short = (p: string) => p.replace(/^notifications\./, '');
      console.log(`[auth] migrated grant ${short(m.from)} → ${short(m.to)} for ${m.subject.kind}:${m.subject.id}`);
      await audit.record({ by: { kind: 'system' }, action: 'grant.migrated', detail: {
        subject: `${m.subject.kind}:${m.subject.id}`, from: m.from, to: m.to,
        message: `migrated grant ${short(m.from)} → ${short(m.to)}`,
      } }).catch(() => undefined);
    }
  }).catch((err) => console.warn(`[auth] grant migration failed: ${(err as Error).message}`));
  return svc;
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
