/** The App Host module's entry point (D97 A1): routing rules, registry, install lifecycle, gateway contracts. */
export * from './appHosts.js';
export * from './auraChannel.js';
export { RELAY_CLAIM_HEADER, RELAY_CLAIM_TTL_S, relayKey, verifyRelayClaim, type RelayClaim } from './relayClaim.js';
export type * from './contracts.js';
export * from './AppHostRegistry.js';
export * from './lifecycle.js';
export * from './manifestHostGuard.js';
export * from './services.js';
export * from './keys.js';
