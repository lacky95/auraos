/**
 * The kernel's composition root, construction half (D97, Phase 6 K): it builds
 * the service singletons and hands collaborators in, so the domain modules
 * import each other only through contracts. `bootSystem()` (system/bootstrap.ts)
 * is the order half. This module is loaded by the barrel (`src/index.ts`), so
 * every `@aura/core` consumer (the shell, the CLI's library calls, tests) gets
 * the same wiring; nothing else imports it.
 */
import { defaultRedis } from '@aura/kv-store';
import { getAppManager } from '../app-manager/AppManager.js';
import { ValkeyApprovalStore } from '../approvals/ValkeyApprovalStore.js';
import { AdminAudit, IDENTITY_AUDIT_ACTIONS, operatorAttribution } from '../auth/AdminAudit.js';
import { ApiKeyStore } from '../auth/ApiKeyStore.js';
import { ClientSessionStore } from '../auth/ClientSessions.js';
import { Authorizer } from '../auth/Authorizer.js';
import { GrantStore } from '../auth/GrantStore.js';
import { defaultIdentityKeyFile } from '../auth/identityKey.js';
import { LoginSessionStore, loginSessionKey } from '../auth/LoginSessionStore.js';
import { defaultSetupTicketDir, FileSetupTickets } from '../auth/setupTickets.js';
import { ValkeyUserStore } from '../auth/ValkeyUserStore.js';
import {
  AUTH_SERVICES_VERSION, getAuthServices, installAuthServicesFactory, isCurrentAuthServices, migrateIdentityRecords, pinAuthServices,
  type AuthServices,
} from '../auth/services.js';
import { LinuxIdentityStore, defaultHighWaterMarkFile } from '../identity/LinuxIdentityStore.js';
import { SECURITY_AUDIT_ACTIONS, SecurityPolicyStore } from '../security/SecurityPolicyStore.js';
import { CapabilityRegistryStore } from '../capabilities/CapabilityRegistryStore.js';
import { OsEventBus } from '../ipc/OsEventBus.js';
import { installAppHostServicesFactory, type AppHostServices } from '../app-hosts/services.js';
import { createAppHostRegistry } from '../app-hosts/AppHostRegistry.js';
import { AppHostLifecycle } from '../app-hosts/lifecycle.js';
import { ManifestHostGuard } from '../app-hosts/manifestHostGuard.js';
import { installNotificationDeps, type NotificationAuthorizer } from '../notifications/NotificationService.js';

function registry() {
  try { return getAppManager().registry; } catch { return null; }
}

/** The identity-and-security services on the central Valkey. */
export function createAuthServices(): AuthServices {
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
  pinAuthServices(svc);
  // D87 B1: a revoked login session (logout, sign out others, reset, disable) ends its shell screens.
  // The event carries no ids, so the screens whose login session is gone are found by lookup.
  OsEventBus.on('auth:sessionsRevoked', () => {
    if (!isCurrentAuthServices(svc)) return; // a replaced singleton's handler stays quiet
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

/** The App Host registry, lifecycle and guard on the central Valkey. Constructing never connects. */
export function createAppHostServices(): AppHostServices {
  const guard = new ManifestHostGuard();
  const svc: AppHostServices = {
    guard,
    manifestHostNames: () => [],
    registry: createAppHostRegistry(() => defaultRedis(), { reservedNames: () => svc.manifestHostNames() }),
    lifecycle: null as unknown as AppHostLifecycle,
  };
  // Grants follow the installation (lifecycle.ts, Hotfix 2 S1). GrantStore holds no state
  // of its own: one over the same Valkey is the auth services' store.
  const grants = new GrantStore(() => defaultRedis());
  svc.lifecycle = new AppHostLifecycle(svc.registry, guard, {
    revokeAppGrants: async (appId, scope) => {
      const dropped = await grants.revokeAppScope(appId, scope);
      if (dropped.length) console.log(`[app-hosts] revoked ${dropped.length} grant(s) of ${appId} (${scope}): ${dropped.map((g) => g.permission).join(', ')}`);
    },
  });
  return svc;
}

/** Window ownership for the notification pop-up limit, from the kernel's activity model. */
export function windowOwner(context: { kind: 'activity' | 'instance'; id: string }): string | null {
  let mgr;
  try { mgr = getAppManager(); } catch { return null; }
  if (context.kind === 'activity') return mgr.getActivity(context.id)?.appId ?? null;
  return mgr.getInstance(context.id)?.appId ?? null;
}

let composed = false;
/** Hand every factory and collaborator in. Idempotent; runs when the barrel loads. */
export function composeKernel(): void {
  if (composed) return;
  composed = true;
  installAuthServicesFactory(createAuthServices);
  installAppHostServicesFactory(createAppHostServices);
  installNotificationDeps({
    authorizer: () => createdAuthorizer(),
    windowOwner,
  });
}

function createdAuthorizer(): NotificationAuthorizer {
  // Resolved lazily through the accessor: the notification service may be built before the auth services.
  return getAuthServices().authorizer as NotificationAuthorizer;
}
