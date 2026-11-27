/**
 * @aura/ui/setup — the setup components (D108 decision W2): one library for
 * the shell's setup wizard in the Activity window and Settings → Apps →
 * Configuration. Presentation only: each takes the plain-data views of core
 * setup/contracts.ts as props and reports the owner's actions through
 * callbacks. No fetch, no state machine, no decision; the caller (the
 * engine's API client) owns all three.
 *
 * Every component is `renderX(root, props[, callbacks])`: it replaces
 * `root`'s children, so the caller re-renders with new props. Plain DOM, no
 * framework. Styles: `@aura/ui/styles/setup.css` (theme tokens only).
 */
export { renderSchemaForm, renderFieldViews, whenHolds } from './schemaForm.js';
export type { SchemaField, SettingsSchemaLike, SchemaForm, SchemaFormOptions, SecretFieldOptions } from './schemaForm.js';
export { renderProfileSelector } from './profileSelector.js';
export type { ProfileSelectorProps, ProfileSelectorCallbacks } from './profileSelector.js';
export { renderRuntimeSelector, checkText } from './runtimeSelector.js';
export type { RuntimeCheck, RuntimeChoice, RuntimeSelectorProps, RuntimeSelectorCallbacks } from './runtimeSelector.js';
export { renderHomeSelector, HOME_TEXT, SHARED_SCOPE_UNAVAILABLE } from './homeSelector.js';
export type { HomeSelectorProps, HomeSelectorCallbacks } from './homeSelector.js';
export { renderCapabilityOffers } from './capabilityOffer.js';
export type { CapabilityOffer, CapabilityOfferCallbacks } from './capabilityOffer.js';
export { renderResources } from './resources.js';
export type { ResourcesProps } from './resources.js';
export { renderStorage } from './storage.js';
export type { StorageProps, StorageVolumeView } from './storage.js';
export { renderSecretPicker, buildSecretPicker } from './secretPicker.js';
export type { SecretPicker, SecretPickerProps, VaultHandleOption } from './secretPicker.js';
export { renderDependencies, requirementLabel, requirementStatus } from './dependencies.js';
export type { AppDependencyView, DependenciesProps, RequirementStatus } from './dependencies.js';
export { renderConnectionTest } from './connectionTest.js';
export type { ConnectionTestProps } from './connectionTest.js';
export { renderApprovalSummary, setupApprovalItems, setupApprovalNeedsPassword } from './approvalSummary.js';
export type { ApprovalSummaryProps, SetupApprovalItem } from './approvalSummary.js';
export { renderProgress } from './progress.js';
