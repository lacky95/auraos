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
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
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
  IdentityDecision, InstallRecord, NexusProgressEvent, ResolvedRef,
} from './types.js';
import type { RegistryConfig } from './RegistryConfig.js';
import { orasHostFromUrl, resolveByName, urlForHost } from './RegistryConfig.js';
import type { OciSource, SourcesConfig } from './SourcesConfig.js';
import { DEFAULT_APP_REPO_PREFIX, DEFAULT_SOURCES_CONFIG, loadSourcesConfig, ociRegistryView } from './SourcesConfig.js';
import { loadRegistryCredentials } from './RegistryAuth.js';
import { needsProvisioning, provisionApp } from '../app-manager/provisioning.js';
import {
  APP_ID_PATTERN, classifyIdentity, rewriteAppIdentity, scanInstalledIdentities, suggestFreeAppId, tracksSource,
  type InstalledIdentity,
} from '../app-manager/AppIdentity.js';
import { compareVersions } from './version.js';
import type { CatalogEntry } from './CatalogAggregator.js';

/**
 * How a store entry relates to this installation — the one answer the store
 * UI renders its buttons from. Matches by id AND originId (AppIdentity), so an
 * app installed under another id, or built here without a store record, still
 * reads as installed.
 */
export interface InstallState {
  /** available: not here · installed: this app is here (maybe under another id)
   *  · id-taken: a DIFFERENT app owns the id · installing: in flight */
  status: 'available' | 'installed' | 'id-taken' | 'installing';
  /** The local app it maps to (installed / id-taken). */
  localAppId?: string;
  scope?: ScopeId;
  installedVersion?: string;
  /** The version the store offers now (the entry's). */
  availableVersion?: string;
  /** The store has a newer version than the installed one. */
  updateAvailable: boolean;
  /** Installed from exactly this source: an update is a plain update; otherwise
   *  installing from here switches the app's source (asks first). */
  fromThisSource: boolean;
  /** Installed through the store (has an install record) — what uninstall needs. */
  hasRecord: boolean;
  /** Can be uninstalled from the store: a store install outside the system
   *  scope. Apps built or copied here are never deleted from the store. */
  canUninstall: boolean;
  /** The installed app is an independent copy (no updates from a source). */
  detached: boolean;
  /** Proven to be the same app: originIds match, or it was installed from
   *  this source. False when one side has no originId (an older publish) — it
   *  shares the id, but installing from here asks first. */
  verified: boolean;
}

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
  /** Every scope, system included — the identity check looks at all of them. */
  private readonly scopeDefs: ScopeDefinition[];

  /** True while an install for this id/ref is in flight. */
  isInstalling(id: string): boolean { return this.installing.has(id); }
  /** Snapshot of everything currently installing (ids + refs). */
  getInstallingIds(): string[] { return [...this.installing]; }

  constructor(opts: NexusManagerOpts) {
    this.rootDataDir   = opts.rootDataDir;
    this.scopeDefs     = opts.scopes;
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
    this.credentialsReady = loadRegistryCredentials(this.rootDataDir, cfg)
      .catch((err: unknown) => console.warn(`[nexus] loading source logins failed: ${(err as Error).message}`));
  }

  /** Logins of private sources (RegistryAuth.ts) are loaded asynchronously
   *  whenever the sources change; routes await this before using a source. */
  private credentialsReady: Promise<void> = Promise.resolve();
  whenCredentialsReady(): Promise<void> { return this.credentialsReady; }

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
      this.credentialsReady = loadRegistryCredentials(this.rootDataDir, cfg)
        .catch((err: unknown) => console.warn(`[nexus] loading source logins failed: ${(err as Error).message}`));
      await this.credentialsReady;
    } catch { /* keep defaults */ }
  }

  /** Legacy view: the OCI-registry subset of the sources config. Kept for the
   *  `/api/nexus/registries` write-through shim + publish script. */
  getRegistryConfig(): RegistryConfig { return ociRegistryView(this.sourcesConfig); }
  /** Convenience for Publisher / sdk install: resolve a bare-name registry. */
  resolveRegistryName(bareName: string): string | null {
    return resolveByName(ociRegistryView(this.sourcesConfig), bareName);
  }
  private ociSourceByName(name: string): OciSource | undefined {
    return this.sourcesConfig.sources.find((s): s is OciSource => s.kind === 'oci' && s.name === name);
  }
  /** A full-path publish target (`host/<prefix>/<app>`) that lies in a
   *  configured source: that source's prefix, so its catalog is kept too. */
  private catalogPrefixForPath(target: string): string | null {
    if (!target.includes('/')) return null;
    const path = target.replace(/^https?:\/\//, '');
    for (const s of this.sourcesConfig.sources) {
      if (s.kind !== 'oci') continue;
      const prefix = (s.appRepoPrefix ?? DEFAULT_APP_REPO_PREFIX).replace(/\/+$/, '');
      const base = `${orasHostFromUrl(s.url)}/${prefix}/`;
      if (path.startsWith(base) && !path.slice(base.length).includes('/')) return prefix;
    }
    return null;
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

  /**
   * The install state of each catalog entry, keyed by entry id. One scan of
   * the installed apps for the whole list.
   */
  installStates(entries: Array<Pick<CatalogEntry, 'id' | 'originId' | 'sourceName' | 'sources' | 'version'>>): Record<string, InstallState> {
    const installed = this.installedIdentities();
    const out: Record<string, InstallState> = {};
    for (const e of entries) {
      const inc = {
        appId: e.id, originId: e.originId ?? null,
        rawRef: e.sources?.oci?.ref ?? e.sources?.git?.ref ?? e.id,
        ...(e.sourceName ? { sourceName: e.sourceName } : {}),
      };
      const v = classifyIdentity(inc, installed);
      const local = v.kind === 'update' ? v.target : v.kind === 'conflict' ? v.existing : null;
      const localOrigin = local ? local.originId ?? local.record?.originId ?? null : null;
      // Only a KNOWN different originId is another app. Same id with an
      // originId missing on either side is shown as installed, unverified.
      const otherApp = v.kind === 'conflict' && v.conflict === 'id-taken' && !!inc.originId && !!localOrigin;
      const status: InstallState['status'] = !local ? 'available' : otherApp ? 'id-taken' : 'installed';
      const rec = local?.record ?? null;
      const installing = this.isInstalling(e.id) || (!!local && this.isInstalling(local.appId));
      out[e.id] = {
        status: installing ? 'installing' : status,
        ...(local ? { localAppId: local.appId, scope: local.scope } : {}),
        ...(local?.version ? { installedVersion: local.version } : {}),
        ...(e.version ? { availableVersion: e.version } : {}),
        updateAvailable: status === 'installed' && !rec?.detached && compareVersions(e.version, local?.version) > 0,
        fromThisSource: status === 'installed' && tracksSource(rec, inc),
        hasRecord: !!rec,
        canUninstall: !!rec && local?.scope !== 'system',
        detached: !!rec?.detached,
        verified: status === 'installed' && (v.kind === 'update' || (!!inc.originId && inc.originId === localOrigin)),
      };
    }
    return out;
  }

  /** Every installed app with its originId and install record, highest
   *  priority scope first (the copy the OS actually runs comes first). */
  private installedIdentities(): InstalledIdentity[] {
    const out: InstalledIdentity[] = [];
    for (const s of [...this.scopeDefs].sort((a, b) => b.priority - a.priority)) {
      const inst = this.installers.get(s.id);
      for (const a of scanInstalledIdentities(s.appsDir, s.id)) {
        const r = inst?.getRecord(a.appId) ?? null;
        out.push({
          ...a,
          record: r ? {
            ref: r.ref,
            ...(r.sourceName ? { sourceName: r.sourceName } : {}),
            ...(r.remoteId ? { remoteId: r.remoteId } : {}),
            ...(r.originId ? { originId: r.originId } : {}),
            ...(r.detached ? { detached: true } : {}),
          } : null,
        });
      }
    }
    return out;
  }

  /** Give the staged app another local id (and originId), revalidated. */
  private retarget(stagingDir: string, fromId: string, toId: string, originId: 'keep' | 'new' | string, scope: ScopeId): AppManifest {
    const rw = rewriteAppIdentity(stagingDir, {
      fromId, toId, scope, originId, sdkVersion: this.sdkVersion(),
    });
    if (!rw.ok) throw new Error(`could not install as ${toId}: ${rw.message}`);
    return validateStagedDir(stagingDir);
  }

  /** The @aura/app-sdk version of this OS (system scope = <repo>/apps). */
  private sdkVersion(): string {
    const sys = this.scopeDefs.find((s) => s.id === 'system')?.appsDir;
    if (!sys) return '0.0.1';
    try {
      const pkg = JSON.parse(readFileSync(join(resolvePath(sys, '..'), 'packages/app-sdk/package.json'), 'utf-8')) as { version?: unknown };
      return typeof pkg.version === 'string' ? pkg.version : '0.0.1';
    } catch { return '0.0.1'; }
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
    /** Updates: ask this source first (see Resolver.resolve). */
    sourceName?: string;
    /** The user's answer to an earlier `identity.choice` (re-sent install). */
    identity?:   IdentityDecision;
  }): AsyncGenerator<NexusProgressEvent, InstallRecord, { approve: boolean } | void> {
    let targetScope: 'global' | 'user' = opts.scope ?? 'global';
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
      await this.credentialsReady;   // private sources need their logins
      const resolved = await this.resolver.resolve(opts.ref, { sourceName: opts.sourceName });
      yield { type: 'resolve.done', resolved };

      yield { type: 'fetch.start' };
      await this.fetch(resolved, stagingDir);
      yield { type: 'fetch.done', stagingDir };

      let manifest = validateStagedDir(stagingDir);
      keys.add(manifest.id); this.installing.add(manifest.id);
      yield { type: 'validate.done', manifest };

      // ─── Identity: which installed app (if any) is this? ────────────────
      // `id` alone decides nothing: the same id can be an unrelated app, and
      // the same app (originId) can live under another id. Scenarios A, B, D
      // need the user's choice and are never resolved silently (AppIdentity).
      const remoteId = manifest.id;
      const installed = this.installedIdentities();
      const verdict = classifyIdentity(
        { appId: manifest.id, originId: manifest.originId ?? null, rawRef: resolved.rawRef, sourceName: resolved.sourceName },
        installed,
      );
      let link: { remoteId?: string; detached?: boolean } = {};
      const taken = new Set(installed.map((i) => i.appId));
      const suggestedAppId = suggestFreeAppId(remoteId, taken);
      /** install-as / install-copy: the app under a local id of the user's choice. */
      const installUnderLocalId = (decision: IdentityDecision): void => {
        const localId = decision.appId ?? suggestedAppId;
        if (!APP_ID_PATTERN.test(localId)) throw new Error(`invalid app id: ${localId}`);
        if (taken.has(localId)) throw new Error(`${localId} is already installed — choose another id`);
        if (decision.action === 'install-as') {
          // Same artifact under a local name: keeps its originId, updates follow.
          manifest = this.retarget(stagingDir, remoteId, localId, 'keep', targetScope);
          link = { remoteId };
        } else {
          // An independent copy: new id AND new originId, no update link.
          manifest = this.retarget(stagingDir, remoteId, localId, 'new', targetScope);
          link = { detached: true };
        }
      };
      // Asked for without a conflict: "install a fresh copy" of an installed
      // app (the store's Installed ▾ menu), or "install as" for an app that
      // isn't installed yet. A second same-artifact install of an installed
      // app is only possible as an independent copy.
      const explicit = opts.identity && verdict.kind !== 'conflict'
        && (opts.identity.action === 'install-copy' || (opts.identity.action === 'install-as' && verdict.kind === 'fresh'))
        ? opts.identity : null;
      if (explicit) {
        installUnderLocalId(explicit);
        yield { type: 'identity.resolved', action: explicit.action, appId: manifest.id };
      } else if (verdict.kind === 'update') {
        if (verdict.target.scope !== 'system') targetScope = verdict.target.scope;
        if (verdict.target.appId !== manifest.id) {
          manifest = this.retarget(stagingDir, remoteId, verdict.target.appId, 'keep', targetScope);
          link = { remoteId };
        }
      } else if (verdict.kind === 'conflict') {
        const decision = opts.identity;
        if (!decision) {
          unmark();
          yield {
            type: 'identity.choice',
            conflict: {
              kind: verdict.conflict,
              incoming: { appId: remoteId, originId: manifest.originId ?? null, version: manifest.version, name: manifest.name,
                          ref: resolved.rawRef, ...(resolved.sourceName ? { sourceName: resolved.sourceName } : {}) },
              existing: { appId: verdict.existing.appId, originId: verdict.existing.originId, scope: verdict.existing.scope,
                          ...(verdict.existing.record?.sourceName ? { sourceName: verdict.existing.record.sourceName } : {}),
                          ...(verdict.existing.record?.ref ? { ref: verdict.existing.record.ref } : {}) },
              choices: verdict.choices,
              suggestedAppId,
            },
          };
          throw new Error('install needs an identity decision');
        }
        if (!verdict.choices.includes(decision.action)) {
          throw new Error(`'${decision.action}' is not possible here (${verdict.conflict}: ${verdict.choices.join(' | ')})`);
        }
        if (decision.action === 'update-existing') {
          const ex = verdict.existing;
          if (ex.scope === 'system') throw new Error(`${ex.appId} is a system app and cannot be replaced`);
          targetScope = ex.scope;
          if (ex.appId !== manifest.id) {
            manifest = this.retarget(stagingDir, remoteId, ex.appId, 'keep', targetScope);
            link = { remoteId };
          } else if (!manifest.originId && ex.originId) {
            // A source without originIds replacing an app that has one keeps it.
            manifest = this.retarget(stagingDir, remoteId, ex.appId, ex.originId, targetScope);
          }
        } else {
          installUnderLocalId(decision);
        }
        mark();
        yield { type: 'identity.resolved', action: decision.action, appId: manifest.id };
      }
      keys.add(manifest.id); this.installing.add(manifest.id);
      const installer = this.installerFor(targetScope);

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
      const record = await installer.install(stagingDir, manifest, resolved, link);

      // Register with the AppRegistry NOW — before provisioning, and well before
      // yielding install.done. Two reasons, and the order matters:
      //
      //  - the shell route early-returns on install.done and never resumes this
      //    generator, so anything after that yield would never run;
      //  - provisioning below can take minutes, and the UI flips a card to
      //    INSTALLED as soon as the install record exists. Registering after it
      //    left a window where the store said INSTALLED and launching 404'd.
      //    An app that is registered but not yet provisioned is fine — the
      //    entrypoint provisions it and the runner now waits for that.
      this.onAppChanged?.(manifest.id);

      // Install the app's dependencies HERE, not on the launch path.
      //
      // A store app arrives as source. Something has to npm-install its tree
      // and pull its @aura/* packages before astro can start, and the only
      // place that used to happen was inside the entrypoint — where the
      // runner's health deadline was already ticking. A heavy app could not
      // finish in time, so its first launch was killed mid-install and it
      // appeared broken until a second try found a warm node_modules. Doing it
      // at install time is both the honest place for it (this is what
      // "installing" means) and the only one where taking two minutes is fine.
      //
      // Never fatal, and safe to abandon: the files, the record and the
      // registration are already in place, so a throw here — or a client that
      // hangs up mid-install — costs a slow first launch, not a broken app.
      // The entrypoint still provisions as a fallback and the runners wait.
      const appDir = join(installer.appsDir, manifest.id);
      if (needsProvisioning(appDir)) {
        yield { type: 'install.provision', message: 'installing dependencies…' };
        try {
          const prov = await provisionApp(appDir, (line) => {
            this.bus?.emit('nexus:install.progress', { id: manifest.id, line });
          });
          for (const w of prov.warnings) yield { type: 'install.provision', message: w };
          if (prov.ran.length) {
            yield { type: 'install.provision', message: `dependencies ready (${prov.ran.join(', ')})` };
          }
        } catch (err) {
          yield { type: 'install.provision',
                  message: `dependency install failed (${(err as Error).message}) — will retry at first launch` };
        }
      }
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

  async *update(appId: string, opts: { autoApprove?: boolean; identity?: IdentityDecision } = {}): AsyncGenerator<NexusProgressEvent, InstallRecord | null, { approve: boolean } | void> {
    const current = this.getRecord(appId);
    if (!current) {
      yield { type: 'error', code: 'not-installed',
              message: `'${appId}' is not installed; nothing to update` };
      return null;
    }
    if (current.detached) {
      yield { type: 'error', code: 'detached',
              message: `'${appId}' was installed as an independent copy — it has no update source` };
      return null;
    }
    const scope = (current.scope === 'system' ? 'global' : current.scope) ?? 'global';
    const result = yield* this.install({
      ref: current.ref, scope, autoApprove: opts.autoApprove, sourceName: current.sourceName,
      ...(opts.identity ? { identity: opts.identity } : {}),
    });
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
    await this.credentialsReady;   // a private target needs its login
    const messages: string[] = [];
    const result = await publishOci({
      ...opts,
      dataDir: this.rootDataDir,
      onMessage: (m) => messages.push(m),
      // Let authors write `--registry local` (a source name) instead of the
      // full zot URL; Publisher derives host + `--plain-http` + repo path.
      registryResolver: (name) => this.resolveRegistryName(name),
      appRepoPrefix: this.ociSourceByName(opts.registry)?.appRepoPrefix,
      catalogPrefix: this.catalogPrefixForPath(opts.registry),
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
