/**
 * NexusManager singleton, stored on globalThis to survive Vite SSR module
 * graph splits. Lazily constructs from AppManager's scope definitions and
 * the persisted multi-registry config.
 */
import { NexusManager } from './NexusManager.js';
import { getAppManager } from '../app-manager/AppManager.js';
import { OsEventBus } from '../ipc/OsEventBus.js';
import type { RegistryConfig } from './RegistryConfig.js';
import { DEFAULT_REGISTRY_CONFIG } from './RegistryConfig.js';

const GLOBAL_KEY = '__aura_nexus_manager__';
type GlobalWithNexus = typeof globalThis & { [GLOBAL_KEY]?: NexusManager };

/** Synchronous singleton accessor. The registry config defaults to
 *  DEFAULT_REGISTRY_CONFIG on first construction; AppManager's first-boot
 *  seeder rewrites the KV-persisted version and the live shell route handler
 *  calls `setRegistryConfig` on the singleton when the user mutates it. */
export function getNexusManager(): NexusManager {
  const existing = (globalThis as GlobalWithNexus)[GLOBAL_KEY];
  if (existing) return existing;
  const mgr = getAppManager();
  const instance = new NexusManager({
    scopes:         mgr.getScopeDefinitions(),
    rootDataDir:    mgr.getDataDir(),
    bus:            OsEventBus,
    registryConfig: DEFAULT_REGISTRY_CONFIG,
  });
  (globalThis as GlobalWithNexus)[GLOBAL_KEY] = instance;
  return instance;
}

/** Replace the singleton's RegistryConfig in-place. Called by the
 *  /api/nexus/registries shell route after a successful PUT/POST/DELETE so
 *  subsequent installs see the new mirrors immediately. Idempotent if no
 *  singleton exists yet (next getNexusManager() will pick up the saved KV
 *  value via AppManager's seeder). */
export function refreshNexusRegistryConfig(cfg: RegistryConfig): void {
  const existing = (globalThis as GlobalWithNexus)[GLOBAL_KEY];
  if (existing) existing.setRegistryConfig(cfg);
}

export function initNexusManager(opts: { appsDir: string; dataDir: string }): NexusManager {
  const existing = (globalThis as GlobalWithNexus)[GLOBAL_KEY];
  if (existing) return existing;
  // Legacy path for tests/tools that bypass AppManager.
  const instance = new NexusManager({
    scopes: [{
      id: 'global', appsDir: opts.appsDir, dataDir: opts.dataDir,
      immutable: false, priority: 1,
    }],
    rootDataDir: opts.dataDir,
    bus: OsEventBus,
  });
  (globalThis as GlobalWithNexus)[GLOBAL_KEY] = instance;
  return instance;
}
