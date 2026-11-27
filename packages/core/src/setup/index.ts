/**
 * The setup module's public surface (D108; sector System Management, the
 * module Phase 8 reserves as `setup`, A4). Named exports only: the core
 * barrel re-exports this file, never an implementation file (D97).
 *
 * One region per work package, so the package branches merge without
 * touching each other's lines. Add a package's exports in its own region.
 */

// ── P0 contracts ────────────────────────────────────────────────────────────
export * from './contracts.js';

// ── P1 resolver ─────────────────────────────────────────────────────────────
export { resolveEffective, autoSelectableProfile, profileOptions, type ProfileContext } from './resolve.js';
export { effectiveManifestView, mergeFields, tightenField, type ViewConfig } from './merge.js';
export { configDigestOf, grantDigestOf, grantBearingOf, type DigestableConfig } from './digest.js';
export { FEATURE_OF_NEED } from './requirements.js';

// ── P2 store and state ──────────────────────────────────────────────────────
export {
  SetupConfigStore, SetupStoreError, parseDesiredConfig, tamperAuditInput, vaultHandleRevoker,
  type ConfigRecordRef, type DesiredRead, type RevokeSecretHandle, type SetupConfigStoreOptions,
} from './store.js';
export {
  SetupStateMachine, SetupStateError, canTransition, deriveSetupState,
  type DeclaringManifest, type DerivedSetupState, type SetupProgress, type SetupStateErrorCode,
  type SetupStateMachineOptions, type SetupTransitionPatch,
} from './state.js';

// ── P3 engine, gate, hooks ──────────────────────────────────────────────────
export { SetupService, SetupEngineError, MAX_INIT_ATTEMPTS } from './service.js';
export {
  setupApplyPayload, setupApprovalItems, setupApplyDisplay, setupRequesterLabel, askSecretName, askSecretDisplay, missingAuthorizations, approvable,
  type SetupApprovalItem,
} from './approval.js';
export { runSetupHooks, migrateConfig, needsHooks, appWords, SetupHookError, NO_MAINTENANCE_HINT, type RunSetupHooksInput } from './hooks.js';
export { blockingDecision, BlockingWatcher, type BlockingDecision, type BlockingWatcherDeps } from './blocking.js';
export type {
  ApprovedRequests, HomeEnvironmentPort, ResolverPortsQuery, SetupAdds, SetupAppManifest, SetupApprovals, SetupEngine, SetupEngineDeps,
  SetupGate, SetupGateDecision, SetupGrantWriter,
} from './ports.js';

// ── P4 value delivery ───────────────────────────────────────────────────────
export {
  setupConfigView, setupEnvLiteral, sidecarSetupValues, secretReadableWithoutGrant, vaultSecretReader, generateSetupSecrets,
  SetupValueError, type SecretReader, type VaultSecretReaderOptions,
} from './values.js';

// ── P8 configuration and change management ─────────────────────────────────
export {
  grantItems, grantDiff, compatibilityIssues, dataStaysBehind, migrateDesired, takeMigratedValues, fieldScopesOf, appliedRecordKey,
  DATA_STAYS_NOTE, RESTORE_NOTICE,
  type AppliedSnapshot, type DataStaysBehind, type FieldScopes, type GrantDiff, type HomePrivateGrantView, type LastAppliedView,
  type ManifestChangeOutcome, type DesiredMigration, type SetupChangeContract, type SetupChangePlan,
} from './change.js';
export { parseAppliedSnapshot } from './store.js';

// ── P9 D107-a owner subset ──────────────────────────────────────────────────
export {
  grantHomePrivate, homePrivateAuthorized, loadHomePrivateFacts, privateHomeSpawnPort, privateHomeTeardown,
  HomePrivateError, HOME_PRIVATE_AUDIT,
  type HomePrivateDecision, type HomePrivateFacts, type HomePrivateFactsDeps, type HomePrivateFactsInput, type HomePrivateGrantDeps,
  type HomePrivateGrantInput, type HomePrivateGrantResult, type HomePrivateRequest, type HomePrivateService, type PrivateHomeSpawnDeps,
  type PrivateHomeSpawnPort, type PrivateHomeTeardownDeps, type PrivateHomeTeardownInput, type PrivateHomeTeardownResult,
} from './homeEnvironment.js';
