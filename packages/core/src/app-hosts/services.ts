/**
 * The App Host singletons on globalThis (like the auth services), on the
 * central Valkey. Importing this never connects: `defaultRedis()` runs on the
 * first registry call.
 */
import { defaultRedis } from '@aura/kv-store';
import { GrantStore } from '../auth/GrantStore.js';
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
  // Grants follow the installation (lifecycle.ts). GrantStore holds no state
  // of its own: one over the same Valkey is the auth services' store.
  const grants = new GrantStore(() => defaultRedis());
  svc.lifecycle = new AppHostLifecycle(svc.registry, guard, {
    revokeAppGrants: async (appId, scope) => {
      const dropped = await grants.revokeAppScope(appId, scope);
      if (dropped.length) console.log(`[app-hosts] revoked ${dropped.length} grant(s) of ${appId} (${scope}): ${dropped.map((g) => g.permission).join(', ')}`);
    },
  });
  g[GLOBAL_KEY] = svc;
  return svc;
}
