/**
 * The App Host singletons on globalThis (like the auth services), on the
 * central Valkey. Importing this never connects: `defaultRedis()` runs on the
 * first registry call.
 */
import { defaultRedis } from '@aura/kv-store';
import { createAppHostRegistry, type AppHostStore } from './AppHostRegistry.js';
import { AppHostLifecycle } from './lifecycle.js';
import { ManifestHostGuard } from './manifestHostGuard.js';

export interface AppHostServices {
  registry: AppHostStore;
  lifecycle: AppHostLifecycle;
  guard: ManifestHostGuard;
  /** Set by AppManager: every host name a loaded manifest declares. */
  manifestHostNames: () => Iterable<string>;
}

const GLOBAL_KEY = '__auraAppHostServices';
type G = typeof globalThis & { [GLOBAL_KEY]?: AppHostServices };

export function getAppHostServices(): AppHostServices {
  const g = globalThis as G;
  const cur = g[GLOBAL_KEY];
  if (cur) return cur;
  const guard = new ManifestHostGuard();
  const svc: AppHostServices = {
    guard,
    manifestHostNames: () => [],
    registry: createAppHostRegistry(() => defaultRedis(), { reservedNames: () => svc.manifestHostNames() }),
    lifecycle: null as unknown as AppHostLifecycle,
  };
  svc.lifecycle = new AppHostLifecycle(svc.registry, guard);
  g[GLOBAL_KEY] = svc;
  return svc;
}
