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
export {
  secretKeyFor, sealedLoginValue, passwordForHost, SOURCE_SECRET_PATTERN, saveRegistryLogin, deleteRegistryLogin, loadRegistryCredentials, hasRegistryLogin,
  orasSync, orasTargetHost, authFileContent, isAuthFailure, authFailureReason, OrasAuthError,
  orasPushArtifact, artifactTypeOf, ARTIFACT_TYPE_ANNOTATION,
} from './RegistryAuth.js';
export type { RegistryLogin, SourceAuth } from './RegistryAuth.js';
export { discoverStore, parseStoreDescriptor, wellKnownUrl, StoreDiscoveryError } from './StoreDiscovery.js';
export type { StoreDescriptor } from './StoreDiscovery.js';
export { CatalogAggregator, loadGitIndexDoc } from './CatalogAggregator.js';
export { manifestRequirements } from './CatalogAggregator.js';
export type { Catalog, CatalogEntry, SourceStatus, AppRequirements } from './CatalogAggregator.js';
export {
  buildStoreAnnotations, parseStoreAnnotations,
  APP_REPO_PREFIX, APP_ARTIFACT_TYPE, ANNOTATION_KEYS,
} from './ociMetadata.js';
export type { StoreMetadata } from './ociMetadata.js';
export {
  LISTING_TAG, LISTING_ARTIFACT_TYPE, LISTING_ORDER_ANNOTATION, LISTING_META_ANNOTATION,
  ociAppTarget, isDigest, listingAssetPath, listingScreenshotUrls, readListing, fetchListingBlob,
  writeListing, listingInputs, screenshotInput, manageOciScreenshots, reorderOciScreenshots,
  updateListingMeta, assertPublished, canWriteListing, normaliseListingMeta,
} from './OciListing.js';
export type { Listing, ListingShot, ListingMeta, ListingInput, OciAppTarget, OciScreenshotOpts, OciScreenshotResult } from './OciListing.js';
export {
  loadSourcesConfig, saveSourcesConfig, seedSourcesConfigIfMissing,
  sortedSources, ociSources, findSource, ociRegistryView, isSourceEntry, isSourceAuth,
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
  orasHostFromUrl, orasFlagsForUrl, splitOciUrl,
  DEFAULT_REGISTRY_CONFIG, LOCAL_REGISTRY_DEFAULT_URL, LOCAL_REGISTRY_HOST,
} from './RegistryConfig.js';
export type { RegistryConfig, RegistryEntry } from './RegistryConfig.js';
export { publishFileList, withheldReason, DEFAULT_PUBLISH_IGNORE } from './PublishFiles.js';
export type { PublishFileList, PublishFileOpts } from './PublishFiles.js';
export {
  readOciCatalog, upsertOciCatalog, parseCatalog, catalogRepo,
  CATALOG_REPO, CATALOG_TAG, CATALOG_ARTIFACT_TYPE,
} from './OciCatalog.js';
export type { CatalogApp, CatalogDoc, CatalogTarget } from './OciCatalog.js';
export { checkRegistryLogin, probeRegistryAddress, parseChallenge } from './RegistryProbe.js';
export type { LoginCheck, RegistryAddress } from './RegistryProbe.js';
