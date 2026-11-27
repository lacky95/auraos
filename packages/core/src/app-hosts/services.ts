/**
 * The App Host services: the accessor. The construction lives in the
 * composition root (`system/compose.ts`, D97 Phase 6 K), which hands its
 * factory in; this module imports no other module at runtime. Pinned on
 * globalThis (like the auth services) so every module copy shares one.
 */
import type { AppHostStore } from './AppHostRegistry.js';
import type { AppHostLifecycle } from './lifecycle.js';
import type { ManifestHostGuard } from './manifestHostGuard.js';

export interface AppHostServices {
  registry: AppHostStore;
  lifecycle: AppHostLifecycle;
  guard: ManifestHostGuard;
  /** Set by AppManager: every host name a loaded manifest declares. */
  manifestHostNames: () => Iterable<string>;
}

const GLOBAL_KEY = '__auraAppHostServices';
type G = typeof globalThis & { [GLOBAL_KEY]?: AppHostServices };

let factory: (() => AppHostServices) | null = null;

/** The composition root's constructor (`system/compose.ts`); installed when `@aura/core` loads. */
export function installAppHostServicesFactory(create: () => AppHostServices): void {
  factory = create;
}

export function getAppHostServices(): AppHostServices {
  const g = globalThis as G;
  const cur = g[GLOBAL_KEY];
  if (cur) return cur;
  if (!factory) throw new Error('App Host services: no composition root (import @aura/core, or call installAppHostServicesFactory)');
  return (g[GLOBAL_KEY] = factory());
}
