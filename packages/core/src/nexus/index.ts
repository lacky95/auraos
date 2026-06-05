/** Public surface of the Nexus distribution layer. */
export * from './types.js';
export { computePermissionDiff, diffRequiresApproval, renderDiffPlainText } from './PermissionDiff.js';
export { validateStagedDir, NexusValidationError } from './Validator.js';
export { Resolver } from './Resolver.js';
export { IndexClient } from './IndexClient.js';
export { Installer } from './Installer.js';
export { NexusManager } from './NexusManager.js';
export { publishGit, publishOci } from './Publisher.js';
export { isOrasAvailable } from './Fetchers/OciFetcher.js';
export { getNexusManager, initNexusManager, refreshNexusRegistryConfig } from './singleton.js';
export {
  loadRegistryConfig, saveRegistryConfig, seedRegistryConfigIfMissing,
  pickMirror, resolveByName, sorted as sortedRegistries,
  orasHostFromUrl, orasFlagsForUrl,
  DEFAULT_REGISTRY_CONFIG, LOCAL_REGISTRY_DEFAULT_URL, LOCAL_REGISTRY_HOST,
} from './RegistryConfig.js';
export type { RegistryConfig, RegistryEntry } from './RegistryConfig.js';
