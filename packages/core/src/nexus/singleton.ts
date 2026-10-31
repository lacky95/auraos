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
import * as Publisher from './Publisher.js';
import * as CatalogAggregatorMod from './CatalogAggregator.js';
import * as Installer from './Installer.js';
import * as Resolver from './Resolver.js';
import * as RegistryAuth from './RegistryAuth.js';
import * as RegistryConfig from './RegistryConfig.js';
import * as RegistryProbe from './RegistryProbe.js';
import * as OciCatalog from './OciCatalog.js';
import * as OciListing from './OciListing.js';
import * as PublishFiles from './PublishFiles.js';
import * as SourcesConfigMod from './SourcesConfig.js';
import * as Validator from './Validator.js';
import * as OciFetcher from './Fetchers/OciFetcher.js';
import * as GitFetcher from './Fetchers/GitFetcher.js';

const GLOBAL_KEY = '__aura_nexus_manager__';
const CODE_KEY = '__aura_nexus_manager_code__';
type GlobalWithNexus = typeof globalThis & { [GLOBAL_KEY]?: NexusManager; [CODE_KEY]?: string };

/**
 * The source of the running Nexus code. The prod shell swaps in a new build
 * in-process (shell-watch) and globalThis outlives the swap: without this the
 * manager built by the OLD code keeps serving publish / install / the catalog
 * — through its OLD imports — until the next restart. So the fingerprint
 * covers the modules the manager works through, not only its class. A split
 * module graph loads the same code twice — same source, so that instance is
 * kept.
 */
const CODE = [
  NexusManager, Publisher, CatalogAggregatorMod, Installer, Resolver, RegistryAuth, RegistryConfig,
  RegistryProbe, OciCatalog, OciListing, PublishFiles, SourcesConfigMod, Validator, OciFetcher, GitFetcher,
].flatMap((m) => (typeof m === 'function' ? [m] : Object.values(m)))
  .filter((v): v is (...a: unknown[]) => unknown => typeof v === 'function')
  .map((f) => f.toString())
  .join('\n');

/** Synchronous singleton accessor. The sources config defaults to
 *  DEFAULT_SOURCES_CONFIG on first construction; AppManager's first-boot
 *  seeder rewrites the KV-persisted version and the live shell route handler
 *  calls `setSourcesConfig` on the singleton when the user mutates it. */
export function getNexusManager(): NexusManager {
  const g = globalThis as GlobalWithNexus;
  const existing = g[GLOBAL_KEY];
  // Built by older code (in-process swap): replace it. The new one loads the
  // persisted sources itself (ensureSourcesLoaded); in-flight work of the old
  // one finishes on the old object.
  if (existing && g[CODE_KEY] === CODE) return existing;
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
  g[GLOBAL_KEY] = instance;
  g[CODE_KEY] = CODE;
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
