export { ContextStore, normaliseInject } from './ContextStore.js';
export type { ContextEntry, ContextKind, InjectTarget } from './ContextStore.js';
export { VolumeStore } from './VolumeStore.js';
export type { VolumeEntry, VolumeMode } from './VolumeStore.js';
export { seal, open, resolveMasterKey } from './seal.js';
export {
  CredentialVault, CREDENTIAL_NAME_RE, CREDENTIAL_HANDLE_RE, CREDENTIAL_HANDLE_PREFIX, MAX_CREDENTIAL_BYTES,
  credentialNamespace, isCredentialHandle, isCredentialName,
} from './CredentialVault.js';
export type { CredentialSummary, CredentialVaultOptions, VaultKv } from './CredentialVault.js';
