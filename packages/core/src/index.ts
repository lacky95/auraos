export * from './types/index.js';
export * from './ipc/OsEventBus.js';
export * from './ipc/topicMatcher.js';
export * from './app-manager/AppManager.js';
export * from './app-manager/appBuild.js';
export * from './app-manager/AppRegistry.js';
export * from './capabilities/tool-allowlist.js';
export * from './app-manager/tool-provision.js';
export * from './app-manager/tool-libs.js';
export * from './app-manager/LifecycleStateMachine.js';
export * from './app-manager/PortAllocator.js';
export * from './app-manager/ProotRunner.js';
export * from './app-manager/lifecycleGate.js';
export * from './app-manager/MountManager.js';
export * from './app-manager/PortManager.js';
export * from './app-manager/InstanceTokens.js';
export * from './app-manager/SidecarManager.js';
export * from './app-manager/DockerApi.js';
export * from './app-manager/ExecBridge.js';
export * from './app-manager/rootTabs.js';
export * from './app-manager/outputLog.js';
export * from './app-manager/BaseImage.js';
export * from './app-manager/sidecar-spec.js';
export * from './app-manager/IntentResolver.js';
export * from './app-manager/AppIdentity.js';
export * from './app-manager/instanceOwner.js';
export * from './app-manager/preview.js';
export * from './permissions/index.js';
export * from './content/index.js';
export * from './interfaces/index.js';
export * from './app-hosts/appHosts.js';
export * from './app-hosts/auraChannel.js';
export { RELAY_CLAIM_HEADER, RELAY_CLAIM_TTL_S, relayKey, verifyRelayClaim, type RelayClaim } from './app-hosts/relayClaim.js';
export type * from './app-hosts/contracts.js';
export type * from './errors/contracts.js';
export { AuraError, auraErrorOf, sourceClosedBody } from './errors/auraError.js';
export * from './app-hosts/AppHostRegistry.js';
export * from './app-hosts/lifecycle.js';
export * from './app-hosts/manifestHostGuard.js';
export * from './app-hosts/services.js';
export * from './theme/index.js';
export * from './layout/LayoutStrategyRegistry.js';
export * from './keymap/index.js';
export * from './nexus/index.js';
export * from './logger.js';
export * from './scopes/index.js';
// AF1: what a scaffold payload may contain, and the unprivileged install of a new app.
export { refusedScaffoldFiles, scaffoldFileMode, SCAFFOLD_INSTALL_ARGS, type ScaffoldFileRefusal, type ScaffoldPayloadFile } from './scopes/scaffoldPayload.js';
export { installAppDepsUnprivileged, unprivilegedInstallEnv, unprivilegedInstallPaths, INSTALL_UID, INSTALL_GID, type InstallStep } from './app-manager/unprivilegedInstall.js';
export * from './context/index.js';
export * from './contract/appContract.js';
export * from './contract/dataDirReport.js';
export * from './contract/sourceScan.js';
export * from './updater/SelfUpdater.js';
export * from './notifications/index.js';
export * from './auth/index.js';
export * from './approvals/index.js';
export * from './security/options.js';
export * from './security/SecurityPolicyStore.js';
export * from './capabilities/index.js';
export * from './system/systemIdentity.js';
export * from './system/systemApps.js';
export * from './users/profileRegistry.js';
export * from './users/userData.js';
export * from './patches/series.js';
export * from './runtimes/types.js';
export * from './runtimes/ari.js';
export * from './runtimes/requirements.js';
export * from './runtimes/registry.js';
export * from './runtimes/settingsSchema.js';
export * from './runtimes/settingsStore.js';
export * from './runtimes/migrateLegacy.js';
export * from './runtimes/container/index.js';
export { containerName, sidecarContainerName as sidecarWorkloadName } from './runtimes/container/names.js';
export * from './runtimes/proot/index.js';
export * from './runtimes/proot/chrootDevices.js';
export { prootOwnerActions, PROOT_SOURCE, PROOT_REF, PROOT_LOCAL_BIN, type ProotActionHost } from './runtimes/proot/actions.js';
export * from './runtimes/hostTools.js';
export * from './runtimes/respawn.js';
export * from './capabilities/apt.js';
export * from './runtimes/builtins/index.js';
export * from './security/SealedPolicyRecord.js';
export * from './homes/types.js';
export * from './homes/HomeResolver.js';
export * from './homes/appHomeAdmin.js';
export * from './identity/types.js';
export * from './identity/LinuxIdentityStore.js';
export * from './identity/passwd.js';
export * from './identity/ownershipReport.js';
export * from './identity/appOwnership.js';
export * from './identity/ownershipApply.js';
export { RUN_AS_MIGRATION_AUDIT_ACTIONS, runAsMigrationBlock, runAsOwnershipPaths, runAsOwnershipPlan } from './identity/runAsOwnership.js';
export type { RunAsOwnershipApply, RunAsOwnershipInput, RunAsOwnershipPlan, RunAsTarget } from './identity/runAsOwnership.js';
export * from './identity/privilegeReview.js';
export * from './identity/appIdentityProvider.js';
export {
  APP_ROOT_EXECUTION_OPTION, EXECUTION_AUDIT_ACTIONS, RootExecutionError, executionApproved, executionBinding, executionConfigOf,
  executionDecision, executionDigest,
} from './identity/execution.js';
export type {
  AppRootExecutionPolicy, ExecutionApproval, ExecutionApprovedVia, ExecutionBinding, ExecutionConfig, ExecutionDecision, ExecutionRequest,
} from './identity/execution.js';
export { renderIdentityFiles, identityFilesSubpath, isNonRootIdentity } from './runtimes/spawn/identityArgs.js';
// Phase 6 L: the release this process serves (Normal layout), and whether a path lies in a release tree (D80).
export { runningRelease, inReleaseTree } from './runtimes/spawn/systemTreeArgs.js';
export * from './homes/importReport.js';
export * from './homes/importMarkers.js';
export * from './homes/plan.js';
// Phase 6 K: the composition root. Loading the barrel hands every factory and collaborator in.
export { bootSystem, getSystem, restartKernel, shutdownSystem, compositionFromEnv, SHUTDOWN_BUDGET_MS, SHUTDOWN_HOOKS_MS } from './system/bootstrap.js';
export { bootStatusFile, readBootStatus, BOOTSTRAP_VERSION } from './system/status.js';
export type * from './system/types.js';
import { composeKernel } from './system/compose.js';
composeKernel();
// Phase 6 Stage 1b (6B.0, D108 A3): the frozen maintenance-start / updateInstance contract (stream M implements it).
export { MAINTENANCE_REASONS } from './app-manager/maintenance.js';
export type * from './app-manager/maintenance.js';
// Phase 6 Stage 1b (6B.0): the frozen release contracts (streams B, L, O, U, S, I; Phase 7), the one
// release path list (twin of os/release/layout.mjs) and the D94 infrastructure contracts (IC-5 fills propagate).
export * from './release/types.js';
export * as releasePaths from './release/paths.js';
// Phase 6 U: the activation reads (lock holder, writes held, the snapshot of a switch).
export {
  RELEASE_LOCK_STALE_MS, systemLockHolder, readWritesHeld, latestSnapshotInto,
  type ReleaseLockHolder, type WritesHeldMarker,
} from './release/activate.js';
export * from './infra/types.js';
export { InfraCredentialError, InfraPropagationError, buildSecrets, infraExecEnv, renderDigest } from './infra/propagate.js';
// D94 IC-5..IC-7: step 0 status, the doctor, the D64 view and refusals, AuraOS's own endpoints (audit #7).
export { infraBootStatus, reloadInfrastructure } from './infra/kernel.js';
export { runInfraDoctor, type InfraCheck, type InfraDoctorReport } from './infra/doctor.js';
export { InfraPublicFallbackError, infraDownloadUrl, readInfraPolicy, refusePublic, type InfraPolicy } from './infra/policy.js';
export { DEFAULT_ENDPOINTS, infraEndpoints } from './infra/endpoints.js';
export { releaseBuildInfra } from './infra/build.js';
export {
  InfraAdminError, applyInfra, infraDiff, removeInfraCredential, setInfraCredential, showInfra, validateInfra,
  type InfraApplyResult, type InfraShow, type InfraSubmission, type InfraValidation,
} from './infra/admin.js';
export type { InfraCredential, InfraCredentialInput } from './infra/credentials.js';
// Phase 6 O: the settings overlay (the owner's grants beside the installed tree), the effective
// capability registry (release + the owner's sealed entries) and the one-shot migration of local edits.
export {
  MANIFEST_OVERLAY_VERSION, ManifestOverlayError, applyManifestOverlay, editManifestOverlay, manifestOverlayPath,
  mergeManifestOverlays, normalizeManifestOverlay, overlayFromDiff, parseManifestOverlay, readManifestOverlay, writeManifestOverlay,
} from './app-manager/manifestOverlay.js';
export type { ManifestOverlay, OverlayEdit, OverlayListOps } from './app-manager/manifestOverlay.js';
export { CAPABILITY_REGISTRY_TARGET, capabilityRegistryMount, effectiveCapabilityRegistry, writeCapabilityRegistryOverlay } from './capabilities/registryOverlay.js';
export type { CapabilityRegistryMount } from './capabilities/registryOverlay.js';
export { OVERLAY_FIELDS, OverlayMigrationError, applyOverlayMigration, migratedDir, overlayMigrationReport } from './release/overlayMigration.js';
export type { OverlayMigrationApp, OverlayMigrationOptions, OverlayMigrationRegistry, OverlayMigrationReport, OverlayMigrationResult } from './release/overlayMigration.js';
