/**
 * NexusManager — the orchestrator that ties the resolver → fetcher →
 * validator → permission-diff → installer pipeline into a single
 * streaming async iterator. Both the CLI (over SSE) and the shell HTTP
 * API consume the same event sequence.
 *
 * The pause-for-permission flow is modelled as an async generator: the
 * pipeline yields a `permission.needed` event and waits for the next
 * `next()` call before continuing. The caller (CLI or shell route)
 * implements its own approval UI between yields.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AppManifest } from '../types/manifest.js';
import type { OsEventBus as OsEventBusSingleton } from '../ipc/OsEventBus.js';
import type { ScopeDefinition, ScopeId } from '../scopes/types.js';
import { Resolver } from './Resolver.js';

type OsEventBus = typeof OsEventBusSingleton;
import { CatalogAggregator } from './CatalogAggregator.js';
import { Installer } from './Installer.js';
import { validateStagedDir } from './Validator.js';
import { fetchLocal } from './Fetchers/LocalFetcher.js';
import { fetchGit } from './Fetchers/GitFetcher.js';
import { fetchOci } from './Fetchers/OciFetcher.js';
import { publishGit, publishOci } from './Publisher.js';
import { computePermissionDiff, diffRequiresApproval } from './PermissionDiff.js';
import type {
  InstallRecord, NexusProgressEvent, ResolvedRef,
} from './types.js';
import type { RegistryConfig } from './RegistryConfig.js';
import { resolveByName, urlForHost } from './RegistryConfig.js';
import type { SourcesConfig } from './SourcesConfig.js';
import { DEFAULT_SOURCES_CONFIG, loadSourcesConfig, ociRegistryView } from './SourcesConfig.js';

export interface NexusManagerOpts {
  scopes:  ScopeDefinition[];
  /** Root dataDir used for shared staging/index paths (not scoped per-app). */
  rootDataDir: string;
  bus?:    OsEventBus;
  /** Registered sources config from the KV store. Drives the catalog
   *  aggregation, the Resolver's mirror probing, and Publisher's bare-name
   *  `--registry` resolution (via the derived OCI registry view). */
  sourcesConfig?: SourcesConfig;
  /** Called after an app is installed/uninstalled so the AppRegistry can
   *  (re)register it deterministically — the fs-watch on scope dirs is
   *  unreliable. Injected by the singleton (which owns the AppManager ref) to
   *  avoid a NexusManager→AppManager import cycle. */
  onAppChanged?: (appId: string) => void;
}

export class NexusManager {
  /** Aggregated app-store catalog across all registered sources. */
  public readonly catalog:   CatalogAggregator;
  private readonly resolver: Resolver;
  /** One installer per non-system scope. */
  private readonly installers: Map<ScopeId, Installer>;
  private readonly rootDataDir: string;
  private readonly bus?: OsEventBus;
  /** Currently-known sources config. Snapshot from the singleton's load;
   *  live-refreshed when a shell route persists a change. */
  private sourcesConfig: SourcesConfig;
  /** Guards the one-time lazy KV load (singleton starts on defaults). */
  private sourcesLoaded = false;
  /** Deterministic AppRegistry (re)registration hook. */
  private readonly onAppChanged?: (appId: string) => void;
  /** App ids (and raw refs) currently mid-install. Exposed so the store UI can
   *  render/persist an "installing…" state that survives a page reload. */
  private readonly installing = new Set<string>();

  /** True while an install for this id/ref is in flight. */
  isInstalling(id: string): boolean { return this.installing.has(id); }
  /** Snapshot of everything currently installing (ids + refs). */
  getInstallingIds(): string[] { return [...this.installing]; }

  constructor(opts: NexusManagerOpts) {
    this.rootDataDir   = opts.rootDataDir;
    this.bus           = opts.bus;
    this.onAppChanged  = opts.onAppChanged;
    this.sourcesConfig = opts.sourcesConfig ?? cloneDefaultSources();
    this.catalog       = new CatalogAggregator({
      rootDataDir: opts.rootDataDir,
      getSources:  () => this.sourcesConfig,
    });
    this.resolver      = new Resolver({
      catalog:        this.catalog,
      registryConfig: ociRegistryView(this.sourcesConfig),
    });
    this.installers    = new Map();
    for (const scope of opts.scopes) {
      if (scope.immutable) continue;
      this.installers.set(scope.id, new Installer({
        appsDir: scope.appsDir,
        dataDir: scope.dataDir,
        scope:   scope.id,
      }));
    }
  }

  /** Expose the registered sources config. The setter swaps it in for
   *  subsequent catalog reads / fetches / publishes; in-flight installs keep
   *  their original snapshot. */
  getSourcesConfig(): SourcesConfig { return this.sourcesConfig; }
  setSourcesConfig(cfg: SourcesConfig): void {
    this.sourcesConfig = cfg;
    this.sourcesLoaded = true;
    this.resolver.setRegistryConfig(ociRegistryView(cfg));
    this.catalog.invalidate();   // next get() re-aggregates against the new set
  }

  /**
   * One-time lazy load of the persisted sources config from the shell KV
   * store. The singleton is constructed synchronously on DEFAULT_SOURCES_CONFIG
   * (can't await KV in a getter), so shell routes call this before reading the
   * catalog to pick up user-registered sources across a shell restart. No-op
   * after the first call or once a route has mutated the config.
   */
  async ensureSourcesLoaded(osApiBase: string): Promise<void> {
    if (this.sourcesLoaded) return;
    this.sourcesLoaded = true;
    try {
      const cfg = await loadSourcesConfig(osApiBase);
      this.sourcesConfig = cfg;
      this.resolver.setRegistryConfig(ociRegistryView(cfg));
      this.catalog.invalidate();
    } catch { /* keep defaults */ }
  }

  /** Legacy view: the OCI-registry subset of the sources config. Kept for the
   *  `/api/nexus/registries` write-through shim + publish script. */
  getRegistryConfig(): RegistryConfig { return ociRegistryView(this.sourcesConfig); }
  /** Convenience for Publisher / sdk install: resolve a bare-name registry. */
  resolveRegistryName(bareName: string): string | null {
    return resolveByName(ociRegistryView(this.sourcesConfig), bareName);
  }
  /** Recover a registry URL (with scheme) from an OCI host so fetch/resolve
   *  can add `--plain-http` for the local zot. */
  private ociUrlForHost(registry: string): string | undefined {
    const host = registry.split('/')[0] ?? registry;
    return urlForHost(ociRegistryView(this.sourcesConfig), host) ?? undefined;
  }

  /**
   * Read access to install records aggregated across all scopes.
   * Higher-priority scope wins when the same appId appears in multiple scopes.
   */
  get records(): { get(id: string): InstallRecord | null; list(): InstallRecord[] } {
    return {
      get:  (id) => this.getRecord(id),
      list: () => this.listAllRecords(),
    };
  }

  private getRecord(id: string): InstallRecord | null {
    // Check higher-priority scopes first (user before global).
    for (const [, installer] of [...this.installers].reverse()) {
      const r = installer.getRecord(id);
      if (r) return r;
    }
    return null;
  }

  private listAllRecords(): InstallRecord[] {
    const seen = new Set<string>();
    const out: InstallRecord[] = [];
    // Higher-priority scopes win; iterate in reverse to push user-scope first.
    for (const [, installer] of [...this.installers].reverse()) {
      for (const r of installer.listRecords()) {
        if (!seen.has(r.id)) {
          seen.add(r.id);
          out.push(r);
        }
      }
    }
    return out;
  }

  private installerFor(scopeId: ScopeId): Installer {
    const inst = this.installers.get(scopeId);
    if (!inst) throw new Error(`Cannot install into scope '${scopeId}' — it is immutable or unknown`);
    return inst;
  }

  /** Resolve a ref without fetching or installing. */
  async resolveRef(rawRef: string): Promise<ResolvedRef> {
    return this.resolver.resolve(rawRef);
  }

  /** Fetch a resolved ref into a directory without validating or installing. */
  async fetchInto(resolved: ResolvedRef, stagingDir: string): Promise<void> {
    return this.fetch(resolved, stagingDir);
  }

  /** Streaming install pipeline. Defaults to 'global' scope. */
  async *install(opts: {
    ref:         string;
    scope?:      'global' | 'user';
    autoApprove?: boolean;
  }): AsyncGenerator<NexusProgressEvent, InstallRecord, { approve: boolean } | void> {
    const targetScope = opts.scope ?? 'global';
    const installer   = this.installerFor(targetScope);
    const stagingDir  = join(this.rootDataDir, 'nexus', 'staging', `pending-${Date.now()}`);
    mkdirSync(stagingDir, { recursive: true });

    // Track this install so the UI can show/persist an "installing…" state.
    // Keyed by both the raw ref and (once known) the app id so a browse card
    // (ref === id) and a URL/git install both match. Cleared before any
    // suspend/return point (the shell route abandons the generator on the
    // permission-needed and install-done yields, so `finally` alone is unsafe).
    const keys = new Set<string>([opts.ref]);
    const mark   = () => { for (const k of keys) this.installing.add(k); };
    const unmark = () => { for (const k of keys) this.installing.delete(k); };
    mark();

    try {
      yield { type: 'resolve.start', ref: opts.ref };
      const resolved = await this.resolver.resolve(opts.ref);
      yield { type: 'resolve.done', resolved };

      yield { type: 'fetch.start' };
      await this.fetch(resolved, stagingDir);
      yield { type: 'fetch.done', stagingDir };

      const manifest = validateStagedDir(stagingDir);
      keys.add(manifest.id); this.installing.add(manifest.id);
      yield { type: 'validate.done', manifest };

      // Permission diff vs. currently-installed version in any scope.
      const currentRecord = this.getRecord(manifest.id);
      let currentManifest: AppManifest | null = null;
      if (currentRecord) {
        const currentInstaller = this.installerFor(currentRecord.scope ?? targetScope);
        try {
          currentManifest = validateStagedDir(join(currentInstaller.appsDir, manifest.id));
        } catch { /* treat as fresh install */ }
      }
      const diff = computePermissionDiff(currentManifest, manifest);

      if (!opts.autoApprove && diffRequiresApproval(diff)) {
        // Pausing for the user's decision — not actively installing. Clear the
        // flag (the route returns here and abandons this generator).
        unmark();
        const decision = yield { type: 'permission.needed', diff };
        if (!decision || !decision.approve) {
          yield { type: 'permission.denied' };
          throw new Error('Install cancelled by user');
        }
        mark();
        yield { type: 'permission.approved' };
      }

      yield { type: 'install.start' };
      const record = await installer.install(stagingDir, manifest, resolved);
      // Register with the AppRegistry NOW — before yielding install.done. The
      // shell route early-returns on install.done and never resumes this
      // generator, so anything after that yield (incl. the bus emit) never
      // runs. Registering here makes the app visible/launchable immediately.
      this.onAppChanged?.(manifest.id);
      unmark();
      this.bus?.emit('nexus:install.complete', { id: manifest.id, record });
      yield { type: 'install.done', record };
      return record;
    } finally {
      unmark();
      try { rmSync(stagingDir, { recursive: true, force: true }); }
      catch { /* best-effort */ }
    }
  }

  async *update(appId: string, opts: { autoApprove?: boolean } = {}): AsyncGenerator<NexusProgressEvent, InstallRecord | null, { approve: boolean } | void> {
    const current = this.getRecord(appId);
    if (!current) {
      yield { type: 'error', code: 'not-installed',
              message: `'${appId}' is not installed; nothing to update` };
      return null;
    }
    const scope = (current.scope === 'system' ? 'global' : current.scope) ?? 'global';
    const result = yield* this.install({ ref: current.ref, scope, autoApprove: opts.autoApprove });
    this.bus?.emit('nexus:update.complete', { id: appId, record: result });
    return result;
  }

  async uninstall(appId: string, opts: { purge?: boolean } = {}): Promise<void> {
    const current = this.getRecord(appId);
    if (!current) throw new Error(`'${appId}' is not installed`);
    const scope = (current.scope === 'system' ? undefined : current.scope);
    if (!scope) throw new Error(`Cannot uninstall '${appId}' from system scope`);
    await this.installerFor(scope).uninstall(appId, opts);
    // Deregister (or unmask a lower-scope copy) immediately.
    this.onAppChanged?.(appId);
    this.bus?.emit('nexus:uninstall.complete', { id: appId });
  }

  async *publishGit(opts: {
    appPath:  string;
    repo?:    string;
    branch?:  string;
    tag?:     string;
    channel?: string;
  }): AsyncGenerator<NexusProgressEvent, { ref: string; installCmd: string }, void> {
    yield { type: 'publish.start' };
    const messages: string[] = [];
    const result = await publishGit({
      ...opts,
      dataDir: this.rootDataDir,
      onMessage: (m) => messages.push(m),
    });
    for (const m of messages) yield { type: 'publish.progress', message: m };
    const ref = `${result.repoUrl.replace(/^https?:\/\//, '').replace(/\.git$/, '')}#${result.tag}`;
    yield { type: 'publish.done', ref };
    this.bus?.emit('nexus:publish.complete', { id: result.manifest.id, ref });
    return { ref, installCmd: result.installCmd };
  }

  async *publishOci(opts: {
    appPath:  string;
    registry: string;
    tag:      string;
    channel?: string;
  }): AsyncGenerator<NexusProgressEvent, { ref: string }, void> {
    yield { type: 'publish.start' };
    const messages: string[] = [];
    const result = await publishOci({
      ...opts,
      dataDir: this.rootDataDir,
      onMessage: (m) => messages.push(m),
      // Let authors write `--registry local` (a source name) instead of the
      // full zot URL; Publisher derives host + `--plain-http` + repo path.
      registryResolver: (name) => this.resolveRegistryName(name),
    });
    for (const m of messages) yield { type: 'publish.progress', message: m };
    yield { type: 'publish.done', ref: result.ref };
    this.bus?.emit('nexus:publish.complete', { ref: result.ref });
    return result;
  }

  private async fetch(resolved: ResolvedRef, stagingDir: string): Promise<void> {
    switch (resolved.source) {
      case 'local':
        return fetchLocal(resolved.address, stagingDir);
      case 'oci': {
        const [registry, tag] = splitOnLastColon(resolved.address);
        return fetchOci({ registry, tag }, stagingDir, this.ociUrlForHost(registry));
      }
      case 'git':
      case 'index': {
        // Index/git addresses that resolved to an OCI artifact are prefixed
        // with `oci://` by the resolver; everything else is a git URL
        // (optionally with a `#ref` fragment).
        if (resolved.address.startsWith('oci://')) {
          const [registry, tag] = splitOnLastColon(resolved.address.slice('oci://'.length));
          return fetchOci({ registry, tag }, stagingDir, this.ociUrlForHost(registry));
        }
        const fragIdx = resolved.address.indexOf('#');
        const url = fragIdx > 0 ? resolved.address.slice(0, fragIdx) : resolved.address;
        const ref = fragIdx > 0 ? resolved.address.slice(fragIdx + 1) : undefined;
        return fetchGit({ url, ref }, stagingDir);
      }
    }
  }
}

function cloneDefaultSources(): SourcesConfig {
  return JSON.parse(JSON.stringify(DEFAULT_SOURCES_CONFIG)) as SourcesConfig;
}

function splitOnLastColon(addr: string): [string, string] {
  const i = addr.lastIndexOf(':');
  if (i < 0) return [addr, 'latest'];
  return [addr.slice(0, i), addr.slice(i + 1)];
}
