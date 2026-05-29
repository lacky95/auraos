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
import type { ScopeRegistry } from '../scopes/ScopeRegistry.js';
import { Resolver } from './Resolver.js';

type OsEventBus = typeof OsEventBusSingleton;
import { IndexClient } from './IndexClient.js';
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

export interface NexusManagerOpts {
  scopes:  ScopeDefinition[];
  /** Root dataDir used for shared staging/index paths (not scoped per-app). */
  rootDataDir: string;
  scopeRegistry?: ScopeRegistry;
  bus?:    OsEventBus;
}

export class NexusManager {
  public readonly index:     IndexClient;
  private readonly resolver: Resolver;
  /** One installer per non-system scope. */
  private readonly installers: Map<ScopeId, Installer>;
  private readonly rootDataDir: string;
  private readonly scopeRegistry?: ScopeRegistry;
  private readonly bus?: OsEventBus;

  constructor(opts: NexusManagerOpts) {
    this.rootDataDir    = opts.rootDataDir;
    this.scopeRegistry  = opts.scopeRegistry;
    this.bus            = opts.bus;
    this.index          = new IndexClient({
      cachePath: join(opts.rootDataDir, 'nexus', 'index.yaml'),
    });
    this.resolver       = new Resolver({ index: this.index });
    this.installers     = new Map();
    for (const scope of opts.scopes) {
      if (scope.immutable) continue;
      this.installers.set(scope.id, new Installer({
        appsDir: scope.appsDir,
        dataDir: scope.dataDir,
        scope:   scope.id,
      }));
    }
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

    // Ensure the scope dir is a git repo before the first install.
    if (this.scopeRegistry) {
      await this.scopeRegistry.ensureScopeRepo(targetScope);
    }

    try {
      yield { type: 'resolve.start', ref: opts.ref };
      const resolved = await this.resolver.resolve(opts.ref);
      yield { type: 'resolve.done', resolved };

      yield { type: 'fetch.start' };
      await this.fetch(resolved, stagingDir);
      yield { type: 'fetch.done', stagingDir };

      const manifest = validateStagedDir(stagingDir);
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
        const decision = yield { type: 'permission.needed', diff };
        if (!decision || !decision.approve) {
          yield { type: 'permission.denied' };
          throw new Error('Install cancelled by user');
        }
        yield { type: 'permission.approved' };
      }

      yield { type: 'install.start' };
      const record = await installer.install(stagingDir, manifest, resolved);
      yield { type: 'install.done', record };

      this.bus?.emit('nexus:install.complete', { id: manifest.id, record });
      return record;
    } finally {
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
      case 'git':
      case 'index': {
        if (resolved.address.startsWith('oci://') || resolved.address.startsWith('ghcr.io')
            || /^[\w.-]+:[^/]+$/.test(resolved.address)) {
          const [registry, tag] = splitOnLastColon(resolved.address);
          return fetchOci({ registry, tag }, stagingDir);
        }
        const fragIdx = resolved.address.indexOf('#');
        const url = fragIdx > 0 ? resolved.address.slice(0, fragIdx) : resolved.address;
        const ref = fragIdx > 0 ? resolved.address.slice(fragIdx + 1) : undefined;
        return fetchGit({ url, ref }, stagingDir);
      }
      case 'oci': {
        const [registry, tag] = splitOnLastColon(resolved.address);
        return fetchOci({ registry, tag }, stagingDir);
      }
    }
  }
}

function splitOnLastColon(addr: string): [string, string] {
  const i = addr.lastIndexOf(':');
  if (i < 0) return [addr, 'latest'];
  return [addr.slice(0, i), addr.slice(i + 1)];
}
