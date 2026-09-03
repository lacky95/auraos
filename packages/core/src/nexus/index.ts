/** Public surface of the Nexus distribution layer. */
export * from './types.js';
export { computePermissionDiff, diffRequiresApproval, renderDiffPlainText } from './PermissionDiff.js';
export { validateStagedDir, NexusValidationError } from './Validator.js';
export { Resolver } from './Resolver.js';
export { IndexClient } from './IndexClient.js';
export * from './StoreEntry.js';
export * from './GitHubClient.js';
export * from './StoreAssets.js';
export * from './StoreSubmitter.js';
export { DEFAULT_INDEX, seedIndex } from './defaultIndex.js';
export { Installer } from './Installer.js';
export { NexusManager } from './NexusManager.js';
export { publishGit, publishOci } from './Publisher.js';
export { isOrasAvailable } from './Fetchers/OciFetcher.js';
export { getNexusManager, initNexusManager, refreshNexusSources } from './singleton.js';
export { CatalogAggregator, loadGitIndexDoc } from './CatalogAggregator.js';
export type { Catalog, CatalogEntry, SourceStatus } from './CatalogAggregator.js';
export {
  buildStoreAnnotations, parseStoreAnnotations,
  APP_REPO_PREFIX, APP_ARTIFACT_TYPE, ANNOTATION_KEYS,
} from './ociMetadata.js';
export type { StoreMetadata } from './ociMetadata.js';
export {
  loadSourcesConfig, saveSourcesConfig, seedSourcesConfigIfMissing,
  sortedSources, ociSources, findSource, ociRegistryView, isSourceEntry,
  DEFAULT_SOURCES_CONFIG, DEFAULT_APP_REPO_PREFIX, OFFICIAL_INDEX_URL,
  OFFICIAL_STORE_REPO,
} from './SourcesConfig.js';
export type {
  SourcesConfig, SourceEntry, SourceKind,
  OciSource, GitIndexSource, GitAppSource, GitAppMeta,
} from './SourcesConfig.js';
export {
  loadRegistryConfig, saveRegistryConfig, seedRegistryConfigIfMissing,
  pickMirror, resolveByName, urlForHost, sorted as sortedRegistries,
  orasHostFromUrl, orasFlagsForUrl,
  DEFAULT_REGISTRY_CONFIG, LOCAL_REGISTRY_DEFAULT_URL, LOCAL_REGISTRY_HOST,
} from './RegistryConfig.js';
export type { RegistryConfig, RegistryEntry } from './RegistryConfig.js';
