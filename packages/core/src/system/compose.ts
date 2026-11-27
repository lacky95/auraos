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
import { getAppHostServices, installAppHostServicesFactory, type AppHostServices } from '../app-hosts/services.js';
import { createAppHostRegistry } from '../app-hosts/AppHostRegistry.js';
import { AppHostLifecycle } from '../app-hosts/lifecycle.js';
import { ManifestHostGuard } from '../app-hosts/manifestHostGuard.js';
import { installNotificationDeps, type NotificationAuthorizer } from '../notifications/NotificationService.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AppManager } from '../app-manager/AppManager.js';
import type { MaintenanceStarter } from '../app-manager/maintenance.js';
import { toolchainMirrorBin } from '../app-manager/tool-provision.js';
import { payloadHash } from '../approvals/state.js';
import {
  appGrantCounts, canonicalPermission, contextReadPermission, credentialReadPermission, isPrivilegedPermission, userScope,
} from '../auth/GrantStore.js';
import { DEFAULT_OWNER_ID } from '../auth/identityContracts.js';
import { OS_SCOPE } from '../auth/types.js';
import { toolBinaryName, toolsGrant } from '../capabilities/tool-allowlist.js';
import { CredentialVault } from '../context/CredentialVault.js';
import { securityPolicyValue } from '../security/options.js';
import type { ApprovalRequester } from '../approvals/types.js';
import type { ResolverPorts, SetupActor } from '../setup/contracts.js';
import type { HomeEnvironmentPort, ResolverPortsQuery, SetupEngine } from '../setup/ports.js';
import { SetupService } from '../setup/service.js';
import {
  grantHomePrivate, homePrivateAuthorized, loadHomePrivateFacts, privateHomeSpawnPort, privateHomeTeardown,
  type HomePrivateFactsDeps, type HomePrivateFactsInput, type PrivateHomeSpawnPort, type PrivateHomeTeardownInput,
} from '../setup/homeEnvironment.js';
import { APP_PRIVATE_HOME_OPTION, HOME_PRIVATE_PERMISSION, declaresSetup, type EffectiveConfig } from '../setup/contracts.js';
import { SetupStateMachine } from '../setup/state.js';
import { SetupConfigStore, tamperAuditInput, vaultHandleRevoker } from '../setup/store.js';
import { localSystemId } from './systemIdentity.js';

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
    // D108: a ready setup's approved permissions count (AppManager `effectiveManifest`).
    declared: (appId) => { try { return getAppManager().effectiveManifest(appId)?.permissions; } catch { return registry()?.getById(appId)?.permissions; } },
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
    // D108: delete-app-data drops the installation's setup records and revokes their vault handles.
    forgetSetup: (installationId, userId) => setupStore().forgetInstallation(installationId, userId),
  });
  return svc;
}

// ── the setup engine (D108 P3) ─────────────────────────────────────────────

let sharedSetupStore: SetupConfigStore | null = null;
/** The desired-configuration store (P2): sealed `app:config:*`, tamper audited, handles revoked through the vault. */
function setupStore(): SetupConfigStore {
  if (sharedSetupStore) return sharedSetupStore;
  const redis = () => defaultRedis();
  sharedSetupStore = new SetupConfigStore({
    identityKeyFile: defaultIdentityKeyFile(),
    redis,
    onTampered: (ref) => {
      console.warn(`[setup] a desired-configuration record of installation ${ref.installationId} failed its integrity check; the app needs setup again`);
      void new AdminAudit(redis).record(tamperAuditInput(ref)).catch(() => undefined);
    },
    revokeHandle: vaultHandleRevoker(new CredentialVault()),
  });
  return sharedSetupStore;
}

/** The approval requester of a setup actor: exactly what `approvalRequester()` records for that principal, so it can poll its request. */
function setupRequester(mgr: AppManager, actor: SetupActor): ApprovalRequester {
  let system: { systemId?: string } = {};
  try { system = { systemId: localSystemId() }; } catch { /* no system identity: none on the principal either */ }
  if (actor.kind === 'terminal') {
    const inst = mgr.getInstance(actor.instanceId);
    let lifetime: string | null = null;
    try { lifetime = mgr.tokens.lifetimeId(actor.instanceId); } catch { lifetime = null; }
    return {
      kind: 'instance', appId: inst?.appId ?? 'com.aura.terminal', instanceId: actor.instanceId, userId: actor.userId,
      ...(lifetime ? { lifetime } : {}), ...system,
    };
  }
  // The owner (desktop) asks as themselves; the host operator's request is the owner's to decide.
  return { kind: 'user', userId: actor.kind === 'user' ? actor.userId : DEFAULT_OWNER_ID, ...system };
}

/** The resolver ports of one resolution: every read done up front (ResolverPorts are synchronous). */
async function setupResolverPorts(mgr: AppManager, home: HomeEnvironmentPort | null, q: ResolverPortsQuery): Promise<ResolverPorts> {
  const auth = getAuthServices();
  const binding = await mgr.appGrantBinding(q.appId);
  const held = new Set((await auth.grants.listFor({ kind: 'app', id: q.appId }))
    .filter((g) => g.scope.kind === OS_SCOPE.kind && appGrantCounts(g, binding)).map((g) => g.permission));
  let record = null;
  try { record = await mgr.runtimeSettings.get(); } catch { record = null; }
  let policy: Awaited<ReturnType<typeof auth.securityPolicy.get>> | null = null;
  try { policy = await auth.securityPolicy.get(); } catch { policy = null; }
  // The Private Home (P9): the app's and each sidecar's grant, for this installation and user.
  const homeAuth = new Map<string, boolean>();
  if (home) {
    const view = q.homeView ?? q.manifest;
    const q0 = { appId: q.appId, installationId: q.installationId, userId: q.userId, manifest: view };
    homeAuth.set('', await home.homePrivateAuthorized(q0).catch(() => false));
    for (const s of view.services) homeAuth.set(s.name, await home.homePrivateAuthorized({ ...q0, sidecar: s.name }).catch(() => false));
  }
  const mirror = toolchainMirrorBin(process.env['AURA_DATA_DIR'] ?? '/data');
  return {
    runtimeFeatures(id) {
      try {
        if (!mgr.runtimes.get(id) || (record && !mgr.runtimes.isEnabled(id, record))) return null;
        return Object.fromEntries(mgr.runtimes.featuresOf(id, record).map((f) => [f.id, f.support]));
      } catch { return null; }
    },
    defaultRuntime: () => record?.default ?? 'container',
    isAuthorized(req) {
      switch (req.kind) {
        case 'permission': return q.approved.permissions.includes(req.permission) || (isPrivilegedPermission(req.permission) && held.has(canonicalPermission(req.permission)));
        case 'tool': return q.approved.tools.includes(req.tool) || toolsGrant(q.manifest.tools, req.tool);
        case 'context': return held.has(contextReadPermission(req.key));
        case 'grant': return held.has(canonicalPermission(req.grant)) || q.approved.permissions.includes(req.grant);
        case 'home-private': return homeAuth.get('') === true;
        case 'home-private-sidecar': return homeAuth.get(req.sidecar) === true;
        default: return false;
      }
    },
    capability(name) {
      let installed = false;
      try { installed = existsSync(join(mirror, toolBinaryName(name))); } catch { installed = false; }
      return { installed, granted: toolsGrant(q.manifest.tools, name) || q.approved.tools.includes(name) };
    },
    policy(id) {
      if (!policy) return null;
      try { const v = securityPolicyValue(policy, id); return typeof v === 'string' || typeof v === 'boolean' ? v : null; } catch { return null; }
    },
  };
}

// ── D107-a (D108 P9): the Private Home over the kernel ──────────────────────

/** What P9's facts loader reads, over the live kernel. */
function homeFactsDeps(mgr: AppManager): HomePrivateFactsDeps {
  const auth = getAuthServices();
  return {
    grants: auth.grants,
    binding: (appId) => mgr.appGrantBinding(appId),
    policy: async () => {
      try { const v = securityPolicyValue(await auth.securityPolicy.get(), APP_PRIVATE_HOME_OPTION); return typeof v === 'string' || typeof v === 'boolean' ? v : null; }
      catch { return null; }
    },
    runtime: async (appId) => {
      const m = mgr.registry.getById(appId);
      if (!m) return null;
      try {
        const r = await mgr.resolveRuntime(appId, m);
        return { id: r.runtime, capabilities: r.capabilities, ...(r.module.featureOverrides ? { featureOverrides: r.module.featureOverrides(r.settings) } : {}) };
      } catch { return null; }
    },
    installation: async (appId) => {
      const i = await mgr.installationRunAs(appId).catch(() => null);
      return i ? { ...(i.runAs === 'app' || i.runAs === 'root' ? { runAs: i.runAs } : {}), ...(i.execution ? { execution: i.execution } : {}) } : null;
    },
  };
}

/**
 * P3's `HomeEnvironmentPort` over P9's functions (the one adapter): the
 * engine asks simple questions, P9 decides with its deps bound here. The
 * home check reads the configuration being resolved (`manifest`, the
 * engine's home view), never only the base.
 */
export function homeEnvironmentPort(mgr: AppManager): HomeEnvironmentPort {
  const auth = () => getAuthServices();
  return {
    async homePrivateAuthorized({ appId, installationId, userId, sidecar, manifest }) {
      const m = manifest ?? mgr.registry.getById(appId);
      if (!m) return false;
      const facts = await loadHomePrivateFacts(homeFactsDeps(mgr), {
        appId, installationId, userId, manifest: m as HomePrivateFactsInput['manifest'], ...(sidecar ? { sidecars: [sidecar] } : {}),
      });
      return homePrivateAuthorized(facts, sidecar ? { kind: 'home-private-sidecar', sidecar, userId } : { kind: 'home-private', userId }).ok;
    },
    async grantHomePrivate({ appId, installationId, userId, homePrivate, sidecars, approvalId, by }) {
      if (!homePrivate && sidecars.length === 0) return;
      await grantHomePrivate(
        { grants: auth().grants, binding: (id) => mgr.appGrantBinding(id), audit: (e) => auth().audit.record(e), ownerId: DEFAULT_OWNER_ID },
        { appId, installationId, userId, sidecars: [...sidecars], decidedBy: by, approvalId },
      );
    },
    async privateHomeTeardown({ appId, installationId, userId, code }) {
      const cause: PrivateHomeTeardownInput['cause'] = code === 'policy-refused' ? { kind: 'policy' }
        : code === 'requirement-unsupported' ? { kind: 'feature', feature: 'storage.privateHome' }
        : { kind: 'grant', permission: HOME_PRIVATE_PERMISSION };
      await privateHomeTeardown({
        instances: (id) => mgr.getInstancesByApp(id),
        stop: (instanceId) => mgr.stop(instanceId, { reason: 'user' }),
        sessions: () => mgr.openSessions(),
        endSession: (sessionId) => mgr.endSession(sessionId),
        audit: (e) => auth().audit.record(e),
      }, { appId, installationId, userId, cause, actor: { kind: 'system' } });
    },
  };
}

/**
 * AppManager `opts.privateHome` (P9's spawn port): the gate-validated
 * effective configuration of an app with setup/profiles (null for every
 * other app: no lookup, `app` as before) and the facts for its re-check at
 * each start. `mgr` is late-bound: the port is handed in before the
 * manager exists.
 */
export function privateHomeForSpawn(mgr: () => AppManager): PrivateHomeSpawnPort {
  const effective = async (appId: string): Promise<EffectiveConfig | null> => {
    const m = mgr();
    const base = m.registry.getById(appId);
    if (!base || !declaresSetup(base) || !m.setup) return null;
    const inst = await m.installationRunAs(appId).catch(() => null);
    if (!inst) return null;
    const d = await m.setup.check(appId, base, { installationId: inst.installationId }).catch(() => null);
    return d?.ok ? d.effective : null;
  };
  return privateHomeSpawnPort({
    effective: (appId) => effective(appId),
    facts: async (appId, installationId, userId, sidecars) => {
      const m = mgr();
      const base = m.registry.getById(appId);
      const eff = await effective(appId);
      // The effective view (overlay networks and sidecar homes), as the gate validated it.
      const view = base && eff && m.setup ? m.setup.manifestView(appId, base, eff) : base;
      return loadHomePrivateFacts(homeFactsDeps(m), {
        appId, installationId, userId, manifest: (view ?? {}) as HomePrivateFactsInput['manifest'], sidecars: [...sidecars],
      });
    },
  });
}

/**
 * The setup engine over an AppManager (AppManager `opts.setup`, from `bootSystem()`): P2's store and
 * state machine, the resolver ports, D102 approvals, the vault, the existing grant paths, the
 * maintenance start (6B.M: used as soon as AppManager implements `startMaintenance`; until then hooks
 * fail closed) and P9's home environment (`home`, connected at INT; null: never a Private Home).
 */
export function createSetupEngine(mgr: AppManager, opts: { home?: HomeEnvironmentPort | null } = {}): SetupEngine {
  const home = opts.home ?? null;
  const auth = () => getAuthServices();
  const vault = new CredentialVault();
  const store = setupStore();
  const appHosts = () => getAppHostServices().registry;
  const states = new SetupStateMachine({
    registry: { getInstallation: (id) => appHosts().getInstallation(id), setSetup: (id, e, n) => appHosts().setSetup(id, e, n) },
    store,
  });
  return new SetupService({
    ownerId: DEFAULT_OWNER_ID,
    manifest: (appId) => mgr.registry.getById(appId) ?? null,
    installation: async (appId) => mgr.installationRunAs(appId),
    store,
    states,
    resolverPorts: (q) => setupResolverPorts(mgr, home, q),
    approvals: {
      create: (r) => auth().approvals.create(r),
      get: (id) => auth().approvals.get(id),
      consume: (id, c) => auth().approvals.consume(id, c),
      cancel: (id, by) => auth().approvals.cancel(id, by),
      hash: payloadHash,
    },
    requester: (actor) => setupRequester(mgr, actor),
    appName: (appId) => mgr.registry.getById(appId)?.name ?? null,
    vault,
    grants: {
      grantPermission: async ({ appId, installationId, permission, by }) => {
        const appScope = mgr.registry.getScopeId(appId);
        await auth().grants.grant({ kind: 'app', id: appId }, permission, { by, installationId, ...(appScope ? { appScope } : {}) });
      },
      grantContext: async ({ appId, installationId, key, by }) => {
        const appScope = mgr.registry.getScopeId(appId);
        await auth().grants.grant({ kind: 'app', id: appId }, contextReadPermission(key), { by, installationId, ...(appScope ? { appScope } : {}) });
      },
      grantable: (p) => isPrivilegedPermission(p),
    },
    readGranted: async (appId, userId, name) =>
      appGrantCounts(await auth().grants.get({ kind: 'app', id: appId }, credentialReadPermission(name), userScope(userId)), await mgr.appGrantBinding(appId)),
    home,
    maintenance: () => {
      const m = mgr as unknown as Partial<MaintenanceStarter>;
      return typeof m.startMaintenance === 'function' ? (mgr as unknown as MaintenanceStarter) : null;
    },
    stopWorkloads: (appId) => mgr.stopAll(appId, { reason: 'user' }),
    audit: async (e) => { await auth().audit.record(e); },
    emit: (e) => { OsEventBus.emit('app:setup-state', e); },
    appIds: () => mgr.registry.getAll().map((m) => m.id),
  });
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
