/**
 * NexusManager singleton, stored on globalThis to survive Vite SSR module
 * graph splits. Lazily constructs from AppManager's scope definitions.
 */
import { NexusManager } from './NexusManager.js';
import { getAppManager } from '../app-manager/AppManager.js';
import { OsEventBus } from '../ipc/OsEventBus.js';

const GLOBAL_KEY = '__aura_nexus_manager__';
type GlobalWithNexus = typeof globalThis & { [GLOBAL_KEY]?: NexusManager };

export function getNexusManager(): NexusManager {
  const existing = (globalThis as GlobalWithNexus)[GLOBAL_KEY];
  if (existing) return existing;
  const mgr = getAppManager();
  const instance = new NexusManager({
    scopes:        mgr.getScopeDefinitions(),
    rootDataDir:   mgr.getDataDir(),
    scopeRegistry: mgr.getScopeRegistry(),
    bus:           OsEventBus,
  });
  (globalThis as GlobalWithNexus)[GLOBAL_KEY] = instance;
  return instance;
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
