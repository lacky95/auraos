/**
 * NexusManager singleton, stored on globalThis to survive Vite SSR module
 * graph splits — same pattern as AppManager's singleton at
 * `app-manager/AppManager.ts:1486+`. Lazily constructs from the
 * AppManager's already-known appsDir + dataDir on first call, so callers
 * don't have to plumb config separately.
 */
import { NexusManager } from './NexusManager.js';
import { getAppManager } from '../app-manager/AppManager.js';
import { OsEventBus } from '../ipc/OsEventBus.js';

const GLOBAL_KEY = '__aura_nexus_manager__';
type GlobalWithNexus = typeof globalThis & { [GLOBAL_KEY]?: NexusManager };

export function getNexusManager(): NexusManager {
  const existing = (globalThis as GlobalWithNexus)[GLOBAL_KEY];
  if (existing) return existing;
  // Pull dirs from the AppManager — must be initialised by now.
  const mgr = getAppManager();
  const instance = new NexusManager({
    appsDir: mgr.getAppsDir(),
    dataDir: mgr.getDataDir(),
    bus:     OsEventBus,
  });
  (globalThis as GlobalWithNexus)[GLOBAL_KEY] = instance;
  return instance;
}

export function initNexusManager(opts: { appsDir: string; dataDir: string }): NexusManager {
  const existing = (globalThis as GlobalWithNexus)[GLOBAL_KEY];
  if (existing) return existing;
  const instance = new NexusManager({ ...opts, bus: OsEventBus });
  (globalThis as GlobalWithNexus)[GLOBAL_KEY] = instance;
  return instance;
}
