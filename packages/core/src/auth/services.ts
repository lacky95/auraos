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
import { LoginSessionStore } from './LoginSessionStore.js';
import { defaultSetupTicketDir, FileSetupTickets } from './setupTickets.js';
import { ValkeyUserStore } from './ValkeyUserStore.js';
import { SECURITY_AUDIT_ACTIONS, SecurityPolicyStore } from '../security/SecurityPolicyStore.js';

/** Bump when the shape changes, so a singleton made by an older module copy is replaced. */
export const AUTH_SERVICES_VERSION = 9;

export interface AuthServices {
  version: number;
  grants: GrantStore;
  apiKeys: ApiKeyStore;
  audit: AdminAudit;
  authorizer: Authorizer;
  /** Phase 5: lock state per shell client (tab). Not a credential. */
  clientSessions: ClientSessionStore;
  /** The owner account. */
  users: ValkeyUserStore;
  /** The one session store: the owner's password sessions. */
  loginSessions: LoginSessionStore;
  /** One-time setup, reset and operator codes. */
  setupTickets: FileSetupTickets;
  /** Owner approvals (5.10). */
  approvals: ValkeyApprovalStore;
  /** The writable security options (D64, security/options.ts). */
  securityPolicy: SecurityPolicyStore;
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
    appScope: (appId) => registry()?.getScopeId(appId),
  });
  const users = new ValkeyUserStore({
    identityKeyFile: defaultIdentityKeyFile(),
    redis,
    onTampered: () => {
      console.warn('[auth] the owner record failed its integrity check');
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
        by: operatorAttribution(), action: IDENTITY_AUDIT_ACTIONS.ownerRecovered, target: `user:${e.username}`,
        outcome: e.sessionsRevoked === null ? 'failed' : 'ok',
        detail: { recordTrusted: e.recordTrusted, usernameSource: e.usernameSource, sessionsRevoked: e.sessionsRevoked },
      });
    },
  });
  // The CLI creates tickets without Valkey, so the shell audits them from their event files.
  const auditCreatedTickets = async () => {
    await setupTickets.drainCreatedEvents(async (e) => {
      await audit.record({
        by: operatorAttribution(), action: IDENTITY_AUDIT_ACTIONS.ticketCreated,
        ...(e.username ? { target: `user:${e.username}` } : {}),
        detail: { purpose: e.purpose, createdAt: e.at },
      });
    });
  };
  const setupTickets: FileSetupTickets = new FileSetupTickets({ dir: defaultSetupTicketDir(), beforeClaim: auditCreatedTickets });
  const svc: AuthServices = {
    version: AUTH_SERVICES_VERSION, grants, apiKeys: new ApiKeyStore(redis), audit, authorizer,
    clientSessions: new ClientSessionStore({ redis }),
    users, loginSessions, setupTickets,
    approvals: new ValkeyApprovalStore({ redis }),
    securityPolicy: new SecurityPolicyStore({
      identityKeyFile: defaultIdentityKeyFile(),
      redis,
      onTampered: () => {
        console.warn('[auth] the security options failed their integrity check; the defaults apply');
        void audit.record({ by: { kind: 'system' }, action: SECURITY_AUDIT_ACTIONS.policyTampered, outcome: 'failed' }).catch(() => undefined);
      },
    }),
  };
  g[GLOBAL_KEY] = svc;
  void auditCreatedTickets().catch((err) => console.warn(`[auth] ticket audit failed: ${(err as Error).message}`));
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

/** Tests / soft-restart. */
export function resetAuthServices(): void {
  delete (globalThis as G)[GLOBAL_KEY];
}
