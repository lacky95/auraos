export { ContextStore, normaliseInject } from './ContextStore.js';
export type { ContextEntry, ContextKind, InjectTarget } from './ContextStore.js';
export { VolumeStore } from './VolumeStore.js';
export type { VolumeEntry, VolumeMode } from './VolumeStore.js';
export { seal, open, resolveMasterKey } from './seal.js';
export {
  CredentialVault, CREDENTIAL_NAME_RE, CREDENTIAL_HANDLE_RE, CREDENTIAL_HANDLE_PREFIX, MAX_CREDENTIAL_BYTES,
  credentialNamespace, isCredentialHandle, isCredentialName, SETUP_SECRET_PREFIX, setupSecretName,
} from './CredentialVault.js';
export type { CredentialSummary, CredentialVaultOptions, SetupSecretBinding, VaultKv } from './CredentialVault.js';
export { grantedContextEnv, grantedContextValue, liveGrantedContextDeps } from './grantedContext.js';
export type {
  ContextRefusal, ContextSource, GrantedContextDeps, GrantedContextRequest, LiveGrantedContextOptions,
} from './grantedContext.js';
