/**
 * NexusManager singleton, stored on globalThis to survive Vite SSR module
 * graph splits. Lazily constructs from AppManager's scope definitions and
 * the persisted multi-registry config.
 */
import { NexusManager } from './NexusManager.js';
import { getAppManager } from '../app-manager/AppManager.js';
import { OsEventBus } from '../ipc/OsEventBus.js';
import type { SourcesConfig } from './SourcesConfig.js';
import { DEFAULT_SOURCES_CONFIG } from './SourcesConfig.js';

const GLOBAL_KEY = '__aura_nexus_manager__';
type GlobalWithNexus = typeof globalThis & { [GLOBAL_KEY]?: NexusManager };

/** Synchronous singleton accessor. The sources config defaults to
 *  DEFAULT_SOURCES_CONFIG on first construction; AppManager's first-boot
 *  seeder rewrites the KV-persisted version and the live shell route handler
 *  calls `setSourcesConfig` on the singleton when the user mutates it. */
export function getNexusManager(): NexusManager {
  const existing = (globalThis as GlobalWithNexus)[GLOBAL_KEY];
  if (existing) return existing;
  const mgr = getAppManager();
  const instance = new NexusManager({
    scopes:        mgr.getScopeDefinitions(),
    rootDataDir:   mgr.getDataDir(),
    bus:           OsEventBus,
    sourcesConfig: DEFAULT_SOURCES_CONFIG,
    // Deterministically (re)register scoped apps after install/uninstall —
    // the fs-watch on scope dirs is unreliable (see AppManager.reloadScopedApp).
    onAppChanged:  (id) => { try { getAppManager().reloadScopedApp(id); } catch { /* pre-init */ } },
  });
  (globalThis as GlobalWithNexus)[GLOBAL_KEY] = instance;
  return instance;
}

/** Replace the singleton's sources config in-place. Called by the
 *  /api/nexus/sources (and /registries shim) shell routes after a successful
 *  persist so subsequent catalog reads + installs see the change immediately.
 *  Idempotent if no singleton exists yet. */
export function refreshNexusSources(cfg: SourcesConfig): void {
  const existing = (globalThis as GlobalWithNexus)[GLOBAL_KEY];
  if (existing) existing.setSourcesConfig(cfg);
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
