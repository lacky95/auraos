/**
 * NexusManager — the orchestrator that ties the resolver → fetcher →
 * validator → permission-diff → installer pipeline into a single
 * streaming async iterator. Both the CLI (over SSE) and the shell HTTP
 * API consume the same event sequence.
 *
 * Every install and update passes the install gate (D31): the caller's
 * `approval` must vouch for the exact `InstallBinding`, which the shell does
 * by consuming an owner approval of it. Otherwise the pipeline yields
 * `permission.needed` and waits for the next `next()` call; only an
 * in-process caller can answer that with `{ approve: true }`.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import type { AppManifest } from '../types/manifest.js';
import type { OsEventBus as OsEventBusSingleton } from '../ipc/OsEventBus.js';
import type { ScopeDefinition, ScopeId } from '../scopes/types.js';
import { Resolver } from './Resolver.js';

type OsEventBus = typeof OsEventBusSingleton;
import { CatalogAggregator } from './CatalogAggregator.js';
import { Installer, removeContained } from './Installer.js';
import { NexusValidationError, validateStagedDir } from './Validator.js';
import { operationalBlock, OperationalBlockError } from '../contract/types.js';
import { hostConflicts, isProtectedHostName, type HostClaim } from '../app-hosts/appHosts.js';
import type { AppHostLifecycle, AppIdentityFacts, AppRestoreCheck } from '../app-hosts/lifecycle.js';
import { fetchLocal } from './Fetchers/LocalFetcher.js';
import { fetchGit } from './Fetchers/GitFetcher.js';
import { fetchOci } from './Fetchers/OciFetcher.js';
import { publishGit, publishOci } from './Publisher.js';
import { isDevCheckout, SYSTEM_APP_LATER, SYSTEM_APP_LATER_MESSAGE } from './AppSource.js';
import { computePermissionDiff, installExposure } from './PermissionDiff.js';
import { executionBinding, type ExecutionBinding } from '../identity/execution.js';
import type {
  IdentityDecision, InstallBinding, InstallRecord, NexusProgressEvent, PermissionDiff, ResolvedRef,
} from './types.js';
import type { RegistryConfig } from './RegistryConfig.js';
import { orasHostFromUrl, resolveByName, urlForHost } from './RegistryConfig.js';
import type { OciSource, SourcesConfig } from './SourcesConfig.js';
import { DEFAULT_APP_REPO_PREFIX, DEFAULT_SOURCES_CONFIG, loadSourcesConfig, ociRegistryView } from './SourcesConfig.js';
import { loadRegistryCredentials } from './RegistryAuth.js';
import { needsProvisioning } from '../app-manager/provisioning.js';
import {
  APP_ID_PATTERN, classifyIdentity, rewriteAppIdentity, scanInstalledIdentities, suggestFreeAppId, tracksSource,
  type InstalledIdentity,
} from '../app-manager/AppIdentity.js';
import { compareVersions } from './version.js';
import type { CatalogEntry } from './CatalogAggregator.js';

/** A built-in system app cannot be deleted (D1): disable it, or fork it into user scope. */
export class SystemAppRemovalError extends Error {
  readonly code = 'system-app';
  constructor(readonly appId: string) {
    super(`${appId} is a built-in system app: it cannot be deleted, and its data stays. Disable it instead (aura disable app ${appId}).`);
    this.name = 'SystemAppRemovalError';
  }
}

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
  /**
   * Installs an app's dependencies in the throwaway builder (P5-3,
   * `AppManager.provisionApp`). Injected by the singleton; without it the
   * install leaves provisioning to the first start.
   */
  provision?: (appId: string, onLine: (line: string) => void) => Promise<{ ok: boolean; ran: boolean; output: string }>;
  /** App Host records follow the install lifecycle. Injected by the singleton. */
  hostLifecycle?: AppHostLifecycle;
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
  private readonly provision?: NexusManagerOpts['provision'];
  private readonly hostLifecycle?: AppHostLifecycle;
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
    this.provision     = opts.provision;
    this.hostLifecycle = opts.hostLifecycle;
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
  async ensureSourcesLoaded(): Promise<void> {
    if (this.sourcesLoaded) return;
    this.sourcesLoaded = true;
    try {
      const cfg = await loadSourcesConfig();
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
  /** Every installed app's host names, read straight from the manifests on disk. */
  private installedHostClaims(): HostClaim[] {
    const out: HostClaim[] = [];
    for (const s of this.scopeDefs) {
      let dirs: string[];
      try { dirs = readdirSync(s.appsDir); } catch { continue; }
      for (const d of dirs) {
        try {
          const m = JSON.parse(readFileSync(join(s.appsDir, d, 'app.manifest.json'), 'utf8')) as { id?: unknown; hosts?: unknown };
          if (typeof m.id !== 'string' || !Array.isArray(m.hosts)) continue;
          const hosts = m.hosts.filter((h): h is { name: string } => !!h && typeof (h as { name?: unknown }).name === 'string');
          if (hosts.length) out.push({ appId: m.id, hosts });
        } catch { /* not an app dir, or an unreadable manifest */ }
      }
    }
    return out;
  }

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

  /** Whether the system scope ships an app with this id. */
  private isSystemAppId(appId: string): boolean {
    const sys = this.scopeDefs.find((s) => s.id === 'system')?.appsDir;
    return !!sys && existsSync(join(sys, appId, 'app.manifest.json'));
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
    /**
     * The install gate: true once an approval of exactly this binding was
     * consumed (shell `lib/approvals`). Absent or false: `permission.needed`.
     */
    approval?:   (binding: InstallBinding, diff: PermissionDiff) => Promise<boolean>;
    /** Set by `update()`, so the approval names what is happening. */
    action?:     InstallBinding['action'];
    /** Updates: ask this source first (see Resolver.resolve). */
    sourceName?: string;
    /** The user's answer to an earlier `identity.choice` (re-sent install). */
    identity?:   IdentityDecision;
    /** Replace the app even when it is a dev checkout (`aura dev checkout`).
     *  The old dir, `.git` included, still goes to nexus/trash. */
    replaceCheckout?: boolean;
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
      // A prepared tree comes from a patch workspace, which is a git work
      // tree: its history is the patch repo's, not the release's, and a
      // `.git` would make the installed app a dev checkout.
      if (opts.action === 'app.patch.activate') rmSync(join(stagingDir, '.git'), { recursive: true, force: true });
      yield { type: 'fetch.done', stagingDir };

      let manifest = validateStagedDir(stagingDir);
      // App host names are global: `{name}--{host}` must route to ONE app.
      keys.add(manifest.id); this.installing.add(manifest.id);
      yield { type: 'validate.done', manifest };
      // The start gate (D48, D108 A1): an app this AuraOS would never start (a newer Aura contract,
      // setup/profiles before the setup engine) is refused before anyone is asked (install, update, patch activation).
      const blocked = operationalBlock(manifest);
      if (blocked) {
        unmark();
        yield { type: 'error', code: blocked.error, message: blocked.message, body: blocked };
        throw new OperationalBlockError(blocked);
      }

      // ─── Identity: which installed app (if any) is this? ────────────────
      // `id` alone decides nothing: the same id can be an unrelated app, and
      // the same app (originId) can live under another id. Scenarios A, B, D
      // need the user's choice and are never resolved silently (AppIdentity).
      const remoteId = manifest.id;
      const installed = this.installedIdentities();
      const verdict = opts.action === 'app.patch.activate'
        ? patchTarget(manifest, installed)
        : classifyIdentity(
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
      // "Install as" for an app that IS installed would otherwise fall through
      // to the update below: the opposite of what was asked. Say so instead.
      if (!explicit && opts.identity?.action === 'install-as' && verdict.kind === 'update') {
        throw new Error(`${remoteId} is already installed as ${verdict.target.appId} — "install as" only installs an app that is not installed yet; install an independent copy instead (install-copy, \`--copy\`)`);
      }
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
      // A built-in app is never patched by a same-id copy in another scope
      // (Q6, D68): a patched tree of one is refused before anyone is asked. A
      // store or local copy that already has the id is a normal app.
      if (opts.action === 'app.patch.activate' && this.isSystemAppId(manifest.id)
        && !existsSync(join(this.installerFor(targetScope).appsDir, manifest.id))) {
        throw new Error(`${SYSTEM_APP_LATER}: ${SYSTEM_APP_LATER_MESSAGE}`);
      }
      keys.add(manifest.id); this.installing.add(manifest.id);
      // After the identity step, which may have given the app another local id.
      // Under another id it is a copy of the artifact: the source's host names
      // aren't its to claim, so it installs without the ones it can't have.
      if (manifest.id !== remoteId) manifest = await this.withoutRefusedHosts(stagingDir, manifest);
      else await this.assertHostsAllowed(manifest);
      const installer = this.installerFor(targetScope);
      // A dev checkout holds work that is not in any release.
      const replacesCheckout = isDevCheckout(join(installer.appsDir, manifest.id));
      if (!opts.replaceCheckout && replacesCheckout) {
        throw new Error(`${manifest.id} is a dev checkout (it has .git) — installing would replace your working tree. Commit/push your work, then pass force to replace it.`);
      }

      // Retained data and App Hosts: compare with the saved installation BEFORE
      // the install can carry anything over (5.13).
      const hostFacts: AppIdentityFacts = {
        appId: manifest.id, originId: manifest.originId ?? null, scope: targetScope,
        source: { kind: resolved.source, ref: resolved.rawRef, ...(resolved.digest ? { digest: resolved.digest } : {}) },
      };
      const restore: AppRestoreCheck = this.hostLifecycle
        ? await this.hostLifecycle.checkRestore(hostFacts, installer.hasRetainedData(manifest.id))
        : { kind: 'none' };
      if (restore.kind === 'confirm' && opts.identity?.action !== 'update-existing') {
        unmark();
        yield {
          type: 'identity.choice',
          conflict: {
            kind: 'switch-source',
            incoming: { appId: remoteId, originId: manifest.originId ?? null, version: manifest.version, name: manifest.name,
                        ref: resolved.rawRef, ...(resolved.sourceName ? { sourceName: resolved.sourceName } : {}) },
            existing: { appId: manifest.id, originId: restore.installation?.originId ?? null, scope: targetScope,
                        ...(restore.installation ? { ref: restore.installation.source.ref } : {}) },
            choices: ['update-existing', 'install-copy'],
            suggestedAppId,
          },
        };
        throw new Error('install needs an identity decision');
      }

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
      const priorInstallation = await this.hostLifecycle?.installationOf(manifest.id, targetScope).catch(() => null) ?? null;
      const binding: InstallBinding = {
        action: opts.action ?? 'nexus.install',
        appId: manifest.id, name: manifest.name, version: manifest.version,
        source: resolved.source, address: resolved.address,
        digest: resolved.digest || treeDigest(stagingDir),
        scope: targetScope, identity: opts.identity ?? null,
        tools: [...new Set(manifest.tools)].sort(), permissions: [...new Set(manifest.permissions)].sort(),
        context: [...new Set(manifest.context ?? [])].sort(),
        replaceCheckout: replacesCheckout,
        // A root request (identity/execution.ts) is bound by its digest; `renew` compares with the installation's approval.
        execution: executionBinding(manifest, priorInstallation),
        exposure: installExposure(manifest),
      };

      // Installing code is always the owner's decision (D31), not only when
      // the diff grows. Only a consumed approval of this binding grants a root
      // request it carries; an in-process `{ approve: true }` installs the app
      // without it (the app then does not start until the owner approves root).
      let executionApproved: ExecutionBinding | null = null;
      if (opts.approval && await opts.approval(binding, diff)) {
        executionApproved = binding.execution;
      } else {
        // Pausing for the user's decision — not actively installing. Clear the
        // flag (the route returns here and abandons this generator).
        unmark();
        const decision = yield { type: 'permission.needed', diff, binding };
        if (!decision || !decision.approve) {
          yield { type: 'permission.denied' };
          throw new Error('Install cancelled by user');
        }
        mark();
        yield { type: 'permission.approved' };
      }

      yield { type: 'install.start' };
      let record: InstallRecord;
      this.hostLifecycle?.beginInstall(manifest.id, targetScope);
      try {
        if (restore.kind === 'deny') {
          installer.setAsideRetainedData(manifest.id, restore.installation.installationId);
        } else if (restore.kind === 'restore' || (restore.kind === 'confirm' && restore.installation)) {
          installer.restoreRetainedData(manifest.id, restore.installation!.installationId);
        }
        record = await installer.install(stagingDir, manifest, resolved, link, { keepProvenance: opts.action === 'app.patch.activate' });
        // A patch activation keeps the release's provenance on the record: the
        // installation's source is that record's, as every later sync reads it.
        const landed: AppIdentityFacts = opts.action === 'app.patch.activate'
          ? { ...hostFacts, source: { kind: record.source, ref: record.ref, ...(record.digest ? { digest: record.digest } : {}) } }
          : hostFacts;
        // Before the registry reload below, so its host guard accepts this manifest.
        try {
          await this.hostLifecycle?.completeInstall(landed, restore, manifest.hosts.map((h) => h.name));
        } catch (err) {
          console.warn(`[nexus] app host update for ${manifest.id} failed: ${(err as Error).message}`);
        }
        // The approved root request, on the installation, before the app can start (fail closed if it can't be).
        if (executionApproved) {
          try {
            // A new record with no data from before may start as root at once; an app that ran as its
            // app identity keeps data that uid owns: its flip goes through the run-as migration.
            const restored = restore.kind === 'restore' || (restore.kind === 'confirm' && !!restore.installation);
            await this.hostLifecycle?.approveExecution(manifest.id, targetScope, {
              runAs: 'root', digest: executionApproved.digest, approvedAt: Date.now(), via: binding.action,
            }, { newRecord: !priorInstallation && !restored });
          } catch (err) {
            console.warn(`[nexus] ${manifest.id}: its root approval could not be recorded (${(err as Error).message}); it does not start until you approve it again (aura admin apps run-as ${manifest.id} root: a dry run, then --apply <digest>)`);
          }
        }
      } finally {
        this.hostLifecycle?.endInstall(manifest.id, targetScope);
      }

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
      if (this.provision && needsProvisioning(appDir, manifest.runtime)) {
        yield { type: 'install.provision', message: 'installing dependencies (in the builder)…' };
        try {
          const prov = await this.provision(manifest.id, (line) => {
            this.bus?.emit('nexus:install.progress', { id: manifest.id, line });
          });
          yield { type: 'install.provision', message: prov.ok
            ? 'dependencies ready'
            : `dependency install failed — will retry at first launch: ${prov.output.trim().split('\n').slice(-3).join(' | ')}` };
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

  async *update(appId: string, opts: {
    approval?: (binding: InstallBinding, diff: PermissionDiff) => Promise<boolean>;
    identity?: IdentityDecision;
    replaceCheckout?: boolean;
  } = {}): AsyncGenerator<NexusProgressEvent, InstallRecord | null, { approve: boolean } | void> {
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
    if (!opts.replaceCheckout && isDevCheckout(join(this.installerFor(scope).appsDir, appId))) {
      yield { type: 'error', code: 'dev-checkout',
              message: `'${appId}' is a dev checkout (it has .git) — update it with git, or force the update to replace it` };
      return null;
    }
    const result = yield* this.install({
      ref: current.ref, scope, action: 'nexus.update', sourceName: current.sourceName,
      ...(opts.approval ? { approval: opts.approval } : {}),
      ...(opts.identity ? { identity: opts.identity } : {}),
      ...(opts.replaceCheckout ? { replaceCheckout: true } : {}),
    });
    this.bus?.emit('nexus:update.complete', { id: appId, record: result });
    return result;
  }

  /**
   * The owner's source-mode choice for an installed app (`aura dev open`),
   * on its install record in the scope it is installed in.
   */
  setSourceMode(appId: string, mode: 'closed' | 'open'): InstallRecord {
    const current = this.getRecord(appId);
    if (!current || !current.scope || current.scope === 'system') throw new Error(`'${appId}' has no install record`);
    return this.installerFor(current.scope).setSourceMode(appId, mode);
  }

  /**
   * Rollback trees of an app in a scope (the Installer's trash): the one the
   * install of `record` moved aside, and the newest one there is.
   */
  rollbackTrees(appId: string, scope: 'global' | 'user', record?: InstallRecord): { previous: string | null; newest: string | null } {
    const installer = this.installerFor(scope);
    return { previous: record ? installer.previousTree(record) : null, newest: installer.newestTrash(appId) };
  }

  async uninstall(appId: string, opts: { purge?: boolean } = {}): Promise<void> {
    const current = this.getRecord(appId);
    if (!current) throw new Error(`'${appId}' is not installed`);
    const scope = (current.scope === 'system' ? undefined : current.scope);
    if (!scope) throw new Error(`Cannot uninstall '${appId}' from system scope`);
    // Routes go first: if this fails, no data has moved or been deleted.
    if (opts.purge) await this.hostLifecycle?.retireApp(appId, scope);
    else await this.hostLifecycle?.reserveApp(appId, scope);
    await this.installerFor(scope).uninstall(appId, opts);
    // Deregister (or unmask a lower-scope copy) immediately.
    this.onAppChanged?.(appId);
    this.bus?.emit('nexus:uninstall.complete', { id: appId });
  }

  /**
   * Delete an app from one scope, store-installed or not: "Delete app data"
   * (its data lives in its dir in a mutable scope). A built-in system app is
   * never deleted this way (D1): its code is the AuraOS repo's and its data
   * stays; disable it instead. Returns whether a directory was removed.
   */
  async removeFromScope(appId: string, scopeId: ScopeId): Promise<{ removed: boolean; dest: string }> {
    if (!APP_ID_PATTERN.test(appId)) throw new Error(`invalid app id: ${appId}`);
    const def = this.scopeDefs.find((s) => s.id === scopeId);
    if (!def) throw new Error(`unknown scope: ${scopeId}`);
    if (def.immutable) throw new SystemAppRemovalError(appId);
    const dest = join(def.appsDir, appId);
    const removed = existsSync(dest);
    await this.hostLifecycle?.retireApp(appId, scopeId);
    await this.installerFor(scopeId).uninstall(appId, { purge: true });
    this.onAppChanged?.(appId);
    return { removed, dest };
  }

  /**
   * Make room in a mutable scope for a local copy that replaces whatever is
   * under `appId` (`aura dev clone --force`, `aura dev new --force`): the
   * grants given to that id there are revoked first (new code earns them
   * again), data a keep-data uninstall left is set aside for its
   * installation, the old tree goes to trash and its install record is
   * dropped (Installer `setAsideForOverwrite`). The caller stopped its
   * instances, and registers the new copy (`reloadScopedApp` + `syncAppHost`).
   */
  async setAsideForOverwrite(appId: string, scopeId: ScopeId): Promise<{ trash: string | null; retained: boolean }> {
    const installer = this.installerFor(scopeId);
    await this.hostLifecycle?.revokeGrants(appId, scopeId);
    const bound = await this.hostLifecycle?.boundInstallation(appId, scopeId);
    return installer.setAsideForOverwrite(appId, bound?.state === 'reserved' ? bound.installationId : null);
  }

  /**
   * App host names are global: `{name}--{host}` must route to ONE app. Rejects
   * a name another app holds, an allocated or retired App Host label, and an OS
   * or system-app name unless this same app id already declares it.
   */
  private async assertHostsAllowed(manifest: AppManifest): Promise<void> {
    const problems = [...(await this.hostProblems(manifest)).values()].flat();
    if (problems.length) throw new NexusValidationError(problems);
  }

  /** Why each refused host name of `manifest` is refused. */
  private async hostProblems(manifest: AppManifest): Promise<Map<string, string[]>> {
    const problems = new Map<string, string[]>();
    if (manifest.hosts.length === 0) return problems;
    const add = (name: string, problem: string) => problems.set(name, [...(problems.get(name) ?? []), problem]);
    const claims = this.installedHostClaims();
    for (const c of hostConflicts({ appId: manifest.id, hosts: manifest.hosts }, claims)) {
      add(c.name, `hosts: '${c.name}' is already the app host of ${c.heldBy}`);
    }
    const own = new Set(claims.filter((c) => c.appId === manifest.id).flatMap((c) => c.hosts.map((h) => h.name)));
    for (const { name } of manifest.hosts) {
      if (this.hostLifecycle) {
        for (const p of await this.hostLifecycle.manifestHostProblems(manifest.id, [name], own)) add(name, p);
      } else if (isProtectedHostName(name) && !own.has(name)) {
        add(name, `hosts: '${name}' is reserved for the OS`);
      }
    }
    return problems;
  }

  /**
   * Write the staged manifest without the hosts this app may not claim. They
   * leave the manifest rather than being filtered at load, so a copy can't
   * pick a name up later when its holder is uninstalled.
   */
  private async withoutRefusedHosts(stagingDir: string, manifest: AppManifest): Promise<AppManifest> {
    const refused = await this.hostProblems(manifest);
    if (refused.size === 0) return manifest;
    for (const [name, why] of refused) console.warn(`[Nexus] ${manifest.id}: leaving out host '${name}': ${why.join('; ')}`);
    const path = join(stagingDir, 'app.manifest.json');
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as { hosts?: Array<{ name: string }> };
    raw.hosts = (raw.hosts ?? []).filter((h) => !refused.has(h.name));
    writeFileSync(path, JSON.stringify(raw, null, 2) + '\n');
    return validateStagedDir(stagingDir);
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

/**
 * A prepared tree (Track P) is a new build of the installed app under its
 * own id, never another app and never a source switch: it lands on the
 * copy that runs now. A built-in app's is refused (Q6, D68).
 */
function patchTarget(manifest: AppManifest, installed: InstalledIdentity[]): { kind: 'update'; target: InstalledIdentity } {
  const target = installed.find((i) => i.appId === manifest.id);
  if (!target) throw new Error(`${manifest.id} is not installed — a patch activates over an installed app`);
  const have = target.originId ?? target.record?.originId ?? null;
  if (have && manifest.originId && have !== manifest.originId) {
    throw new Error(`refusing to activate: the prepared tree is a different app than the installed ${manifest.id} (originId ${manifest.originId}, installed ${have})`);
  }
  return { kind: 'update', target };
}

function cloneDefaultSources(): SourcesConfig {
  return JSON.parse(JSON.stringify(DEFAULT_SOURCES_CONFIG)) as SourcesConfig;
}

function splitOnLastColon(addr: string): [string, string] {
  const i = addr.lastIndexOf(':');
  if (i < 0) return [addr, 'latest'];
  return [addr.slice(0, i), addr.slice(i + 1)];
}

/**
 * A digest of a staged tree, for a source that has none of its own (a local
 * path): every file's path and bytes, in a fixed order, `.git` and
 * `node_modules` left out. Approving one tree does not approve another.
 */
export function treeDigest(dir: string): string {
  const h = createHash('sha256');
  const walk = (rel: string): void => {
    const entries = readdirSync(join(dir, rel), { withFileTypes: true })
      .filter((e) => e.name !== '.git' && e.name !== 'node_modules')
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path);
      else if (e.isFile()) {
        const bytes = readFileSync(join(dir, path));
        h.update(`${path}\0${bytes.length}\0`).update(bytes);
      } else if (e.isSymbolicLink()) h.update(`${path}\0link\0`);
    }
  };
  walk('');
  return `tree:sha256:${h.digest('hex')}`;
}
