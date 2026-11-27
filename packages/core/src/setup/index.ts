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

// ── P4 value delivery ───────────────────────────────────────────────────────

// ── P8 configuration and change management ─────────────────────────────────

// ── P9 D107-a owner subset ──────────────────────────────────────────────────
