/**
 * Shell-wide auth singletons on globalThis (like AppManager / the
 * notification service), on the central Valkey (`defaultRedis()`).
 *
 * The Authorizer reads app manifests and install scopes from the live
 * AppManager registry, lazily, so this module never forces AppManager init.
 */
import { defaultRedis } from '@aura/kv-store';
import { getAppManager } from '../app-manager/AppManager.js';
import { ValkeyApprovalStore } from '../approvals/ValkeyApprovalStore.js';
import { AdminAudit, IDENTITY_AUDIT_ACTIONS, operatorAttribution } from './AdminAudit.js';
import { AdminAuth } from './AdminAuth.js';
import { defaultAdminKeyFile } from './adminCredential.js';
import { ApiKeyStore } from './ApiKeyStore.js';
import { ClientSessionStore } from './ClientSessions.js';
import { Authorizer } from './Authorizer.js';
import { GrantStore } from './GrantStore.js';
import { defaultIdentityKeyFile } from './identityKey.js';
import type { LoginSessionStore } from './LoginSessionStore.js';
import { defaultSetupTicketDir, FileSetupTickets } from './setupTickets.js';
import { ValkeyUserStore } from './ValkeyUserStore.js';

/** Bump when the shape changes, so a singleton made by an older module copy is replaced. */
export const AUTH_SERVICES_VERSION = 7;

export interface AuthServices {
  version: number;
  grants: GrantStore;
  apiKeys: ApiKeyStore;
  admin: AdminAuth;
  audit: AdminAudit;
  authorizer: Authorizer;
  /** Phase 5: lock state per shell client (tab). Not a credential. */
  clientSessions: ClientSessionStore;
  /** The owner account. */
  users: ValkeyUserStore;
  /** The one session store; the same object as `admin.sessions`. */
  loginSessions: LoginSessionStore;
  /** One-time setup, reset and operator codes. */
  setupTickets: FileSetupTickets;
  /** Owner approvals (5.10). */
  approvals: ValkeyApprovalStore;
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
  const admin = new AdminAuth({
    keyFile: defaultAdminKeyFile(),
    identityKeyFile: defaultIdentityKeyFile(),
    redis,
    onRotated: (purged) => {
      console.log(`[auth] admin credential changed on disk (rotation) — ${purged} admin session(s) revoked`);
      void audit.record({ by: { kind: 'system' }, action: 'credential.rotated', detail: { sessionsRevoked: purged } }).catch(() => undefined);
    },
  });
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
    sessions: admin.sessions,
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
    version: AUTH_SERVICES_VERSION, grants, apiKeys: new ApiKeyStore(redis), admin, audit, authorizer,
    clientSessions: new ClientSessionStore({ redis }),
    users, loginSessions: admin.sessions, setupTickets,
    approvals: new ValkeyApprovalStore({ redis }),
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

/** Tests / soft-restart. */
export function resetAuthServices(): void {
  delete (globalThis as G)[GLOBAL_KEY];
}
