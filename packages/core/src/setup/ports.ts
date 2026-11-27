/**
 * The setup engine's ports (D108 P3): what the engine asks the rest of the
 * kernel, and what the lifecycle engine (AppManager) asks the engine. Types
 * only, no runtime import: `app-manager` depends on it without a cycle, and
 * the composition root (`system/compose.ts`) wires the live side.
 *
 *   SetupEngineDeps      the engine's collaborators (store, state machine,
 *                        resolver ports, approvals, vault, grants, the
 *                        maintenance start, workloads, audit, events)
 *   HomeEnvironmentPort  the D107-a owner subset (P9, `homeEnvironment.ts`):
 *                        is the Private Home authorized, grant it on an
 *                        approved setup, tear a revoked one down
 *   SetupGate            the start gate AppManager asks at its choke point
 *                        (`spawnContext`, `startIntent`, the supervisor skip)
 *   SetupEngine          the gate plus `SetupServiceContract` (the API, the
 *                        CLI, the wizard and `/api/setup/self` call it)
 */
import type { MaintenanceReason, MaintenanceStarter } from '../app-manager/maintenance.js';
import type { SidecarSetupValues } from '../app-manager/sidecar-spec.js';
import type {
  ApprovalCanceller, ApprovalClaim, ApprovalRecord, ApprovalRequest, ApprovalRequester, ApprovalResult,
} from '../approvals/types.js';
import type { AuditInput } from '../auth/AdminAudit.js';
import type { ChangeAttribution } from '../auth/types.js';
import type { CredentialVault } from '../context/CredentialVault.js';
import type { OperationalBlock } from '../contract/types.js';
import type { SetupConfigStore } from './store.js';
import type { SetupStateMachine } from './state.js';
import type { SetupChangeContract } from './change.js';
import type {
  EffectiveConfig, ResolverPorts, SetupActor, SetupApplyPayload, SetupErrorBody, SetupManifestView, SetupServiceContract, SetupStateEvent,
} from './contracts.js';

/** What of a parsed manifest the engine reads (structural; `AppManifest` satisfies it). */
export type SetupAppManifest = SetupManifestView & { name?: string; version?: string };

/**
 * The non-grantable requests an approved `app.setup.apply` covers (plain
 * permissions and tools a profile adds: no GrantStore record exists for
 * them). Grantable ones (privileged permissions, `context.read:<KEY>`, the
 * Private Home) count only through their grants, so a revoked grant blocks.
 */
export interface ApprovedRequests {
  permissions: readonly string[];
  tools: readonly string[];
}

/** The resolver ports of one resolution (all reads done up front; `ResolverPorts` is synchronous). */
export interface ResolverPortsQuery {
  appId: string;
  installationId: string;
  userId: string;
  manifest: SetupAppManifest;
  approved: ApprovedRequests;
  /**
   * The Private Home is checked against the configuration being resolved (its
   * overlay's sidecar networks and homes), never the base: D107 §8.1. Only
   * the home check reads it; every other port reads `manifest` (a profile's
   * added tools never count as held through it).
   */
  homeView?: SetupAppManifest;
}

/**
 * D107-a owner subset (P9 `setup/homeEnvironment.ts`). The engine calls it
 * and never decides a home itself. Names fixed with P9; the lead connects
 * the live functions at INT (absent: a Private Home is never authorized).
 */
export interface HomeEnvironmentPort {
  /** Does `home.private` (or `home.private.sidecar:<sidecar>`) count for this installation and user? */
  homePrivateAuthorized(q: { appId: string; installationId: string; userId: string; sidecar?: string; manifest?: SetupAppManifest }): Promise<boolean>;
  /**
   * The same decision with its D105 body (P9 `homePrivateAuthorized`): the engine refuses a proposal whose
   * Private Home can't be authorized by any approval (a shared listener, the runtime, a root installation)
   * before asking for one. Absent: only the boolean counts.
   */
  homePrivateDecision?(q: { appId: string; installationId: string; userId: string; sidecar?: string; manifest?: SetupAppManifest }): Promise<{ ok: true } | { ok: false; error: SetupErrorBody }>;
  /** An approved `app.setup.apply` with `adds.homePrivate` / `homePrivateSidecars`: record the grants. */
  grantHomePrivate(g: {
    appId: string; installationId: string; userId: string; homePrivate: boolean; sidecars: readonly string[];
    approvalId: string; by: ChangeAttribution;
  }): Promise<void>;
  /** A revoked Private Home: end the private sessions of the installation (D107; instances are stopped by the engine). */
  privateHomeTeardown(t: { appId: string; installationId: string; userId: string; reason: string; code?: string }): Promise<void>;
}

/** The approval store as the engine uses it (D102; `ValkeyApprovalStore`). */
export interface SetupApprovals {
  create(request: ApprovalRequest): Promise<ApprovalResult>;
  get(id: string): Promise<ApprovalRecord | null>;
  consume(id: string, claim: ApprovalClaim): Promise<ApprovalResult>;
  cancel(id: string, by: ApprovalCanceller): Promise<ApprovalResult>;
  /** The D102 `payloadHash` (approvals/state.ts; handed in: setup never imports approvals at runtime, no module cycle). */
  hash(payload: unknown): string;
}

/** The existing grant path for what an approved setup adds (GrantStore app grants, pinned to the installation). */
export interface SetupGrantWriter {
  /** A privileged permission or a `grant` requirement the payload adds. Throws when it is not grantable. */
  grantPermission(g: { appId: string; installationId: string; permission: string; by: ChangeAttribution }): Promise<void>;
  /** A Context key the payload adds (`context.read:<KEY>`, as an approved install grants it). */
  grantContext(g: { appId: string; installationId: string; key: string; by: ChangeAttribution }): Promise<void>;
  /** Is this permission one the GrantStore holds (privileged)? Plain ones are covered by the approval's digest. */
  grantable(permission: string): boolean;
  /**
   * P8: revoke one `home.private[.sidecar:<n>]` grant of the app in `userId`'s
   * own scope (the user revokes their own Private Home; the admin grants
   * route can't). True when a grant was removed. Absent: refused (503-like).
   */
  revokeHomePrivate?(g: { appId: string; userId: string; permission: string }): Promise<boolean>;
  /** P8: the `home.private[.sidecar:<n>]` permissions the app holds in `userId`'s scope. */
  homePrivateHeld?(g: { appId: string; userId: string }): Promise<string[]>;
}

export interface SetupEngineDeps {
  /** The owner (alpha: the one human user; user-scope values and the vault are theirs). */
  ownerId: string;
  /** The installed app's parsed manifest, or null. */
  manifest(appId: string): SetupAppManifest | null;
  /** The app's current installation (ensured), or null when it has none. */
  installation(appId: string): Promise<{ installationId: string } | null>;
  store: Pick<SetupConfigStore, 'read' | 'update' | 'readApplied' | 'writeApplied'>;
  states: Pick<SetupStateMachine, 'state' | 'begin' | 'transition' | 'progress' | 'markReady' | 'desired'>;
  resolverPorts(q: ResolverPortsQuery): Promise<ResolverPorts>;
  approvals: SetupApprovals;
  /** The D102 requester an actor's approval records (a Terminal actor: exactly that Terminal instance, so the CLI can poll it). */
  requester(actor: SetupActor): ApprovalRequester;
  /** The registry's display name of an app. */
  appName(appId: string): string | null;
  vault: Pick<CredentialVault, 'generate' | 'handleOf' | 'list' | 'resolve' | 'reveal'>;
  grants: SetupGrantWriter;
  /** Does `appId` hold a counting `credential.read:<name>` grant in `userId`'s vault? */
  readGranted(appId: string, userId: string, name: string): Promise<boolean>;
  /** P9; null until connected (a Private Home is then never authorized, never granted). */
  home: HomeEnvironmentPort | null;
  /** The maintenance start (6B.M); null while this release has none (hooks then fail closed). */
  maintenance(): MaintenanceStarter | null;
  /** Stop every workload of the app (its instances and, with them, their sidecars). */
  stopWorkloads(appId: string): Promise<void>;
  audit(entry: AuditInput): Promise<void>;
  /** `app:setup-state` (a kernel event; only the engine emits it). */
  emit(event: SetupStateEvent): void;
  /** The ids of the installed apps (recovery and the blocking re-check). */
  appIds(): string[];
  now?(): Date;
}

/** The start gate's answer for one spawn. */
export type SetupGateDecision =
  | { ok: true; effective: EffectiveConfig | null }
  | { ok: false; block: OperationalBlock };

/**
 * The start gate (D108 §3.1): an app that declares setup or profiles starts
 * only when its state is `ready` and the stored `configDigest` equals the
 * freshly resolved one; the engine's own maintenance start (reason `setup`,
 * state `initializing`) is the one exception. Apps without setup/profiles:
 * `{ ok: true, effective: null }` with nothing read.
 */
export interface SetupGate {
  check(appId: string, manifest: SetupAppManifest, opts: { installationId: string; maintenance?: MaintenanceReason }): Promise<SetupGateDecision>;
  /** The last refusal the gate gave for this app (the supervisor loops skip it; the spawn gate decides). */
  knownBlock(appId: string): OperationalBlock | null;
  /**
   * The manifest a spawn of this app uses: the effective manifest view of
   * `effective` (or of the last gate-validated configuration), else `base`
   * unchanged. Profile overlays (sandbox, requests, service network, limits,
   * readiness, home, env) reach the spawn only through it.
   */
  manifestView<M extends SetupAppManifest>(appId: string, base: M, effective?: EffectiveConfig | null): M;
  /**
   * The home environment of the app's gate-validated effective configuration (null: none known yet).
   * The warm pool reads it: a `private` app is never warmed (a pool member is for nobody).
   */
  effectiveHome?(appId: string): 'app' | 'private' | null;
  /** The sidecar env resolver of a ready app's gate-validated effective configuration (P4), or null. */
  sidecarValues(appId: string): Promise<SidecarSetupValues | null>;
  /** Recovery after a kernel restart (initializing runs) and the blocking subscriptions. Idempotent. */
  start(): void;
  /** Ends the subscriptions (shutdown, tests). */
  stop(): void;
}

export type SetupEngine = SetupGate & SetupServiceContract & SetupChangeContract;

/** The approval payload's privilege lists as the engine builds them (re-exported for tests). */
export type SetupAdds = SetupApplyPayload['adds'];
