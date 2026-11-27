/** Release and activation mechanisms shared by app and system activations (Phase 7a; Phase 6 adds the builder). */
export * from './lock.js';
export * from './faults.js';
/** The system patch engine (Phase 7b): `core.systemPatches.*`, a namespace (its names are the engine's, not the barrel's). */
export * as systemPatches from './systemPatches.js';
