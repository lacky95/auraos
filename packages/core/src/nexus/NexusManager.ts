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
import { Resolver } from './Resolver.js';

// `OsEventBus` is exported as a runtime singleton (not a class). Its type
// is `typeof OsEventBus`. Alias here so the field declaration reads clean.
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
  appsDir: string;
  dataDir: string;
  bus?:    OsEventBus;
}

export class NexusManager {
  public readonly index:    IndexClient;
  private readonly resolver: Resolver;
  private readonly installer: Installer;
  private readonly appsDir: string;
  private readonly dataDir: string;
  private readonly bus?: OsEventBus;

  constructor(opts: NexusManagerOpts) {
    this.appsDir = opts.appsDir;
    this.dataDir = opts.dataDir;
    this.bus = opts.bus;
    this.index = new IndexClient({
      cachePath: join(opts.dataDir, 'nexus', 'index.yaml'),
    });
    this.resolver  = new Resolver({ index: this.index });
    this.installer = new Installer({ appsDir: this.appsDir, dataDir: this.dataDir });
  }

  /** Read access to the installer's persisted records — used by API
   *  endpoints that need to list installed apps or look up a single one. */
  get records(): { get(id: string): InstallRecord | null; list(): InstallRecord[] } {
    return {
      get:  (id) => this.installer.getRecord(id),
      list: () => this.installer.listRecords(),
    };
  }

  /** Resolve a ref without fetching or installing. Used by the preview
   *  endpoint and the CLI's `nexus info` command. */
  async resolveRef(rawRef: string): Promise<ResolvedRef> {
    return this.resolver.resolve(rawRef);
  }

  /** Fetch a resolved ref into a directory without validating or installing.
   *  Used by the preview endpoint to compute a permission diff before
   *  committing to the install. */
  async fetchInto(resolved: ResolvedRef, stagingDir: string): Promise<void> {
    return this.fetch(resolved, stagingDir);
  }

  /** Streaming install pipeline. Caller drives it like:
   *
   *      const it = manager.install({ ref: 'github.com/u/r' });
   *      for await (const ev of it) {
   *        if (ev.type === 'permission.needed') {
   *          const ok = await ask(ev.diff);
   *          await it.next({ approve: ok });   // 2-arg next() resumes
   *        }
   *      }
   *
   * For convenience the generator also accepts `autoApprove` up-front. */
  async *install(opts: {
    ref: string;
    autoApprove?: boolean;
  }): AsyncGenerator<NexusProgressEvent, InstallRecord, { approve: boolean } | void> {
    const stagingDir = join(this.dataDir, 'nexus', 'staging', `pending-${Date.now()}`);
    mkdirSync(stagingDir, { recursive: true });

    try {
      // 1. Resolve.
      yield { type: 'resolve.start', ref: opts.ref };
      const resolved = await this.resolver.resolve(opts.ref);
      yield { type: 'resolve.done', resolved };

      // 2. Fetch.
      yield { type: 'fetch.start' };
      await this.fetch(resolved, stagingDir);
      yield { type: 'fetch.done', stagingDir };

      // 3. Validate.
      const manifest = validateStagedDir(stagingDir);
      yield { type: 'validate.done', manifest };

      // 4. Permission diff vs. currently-installed (if any).
      const currentRecord = this.installer.getRecord(manifest.id);
      let currentManifest: AppManifest | null = null;
      if (currentRecord) {
        // Best-effort read of the previously-installed manifest.
        try {
          currentManifest = validateStagedDir(join(this.appsDir, manifest.id));
        } catch { /* corrupt or missing; treat as fresh install */ }
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

      // 5. Install.
      yield { type: 'install.start' };
      const record = await this.installer.install(stagingDir, manifest, resolved);
      yield { type: 'install.done', record };

      this.bus?.emit('nexus:install.complete', { id: manifest.id, record });
      return record;
    } finally {
      try { rmSync(stagingDir, { recursive: true, force: true }); }
      catch { /* best-effort */ }
    }
  }

  /** Update flow — re-resolve the stored ref + channel, install if changed. */
  async *update(appId: string, opts: { autoApprove?: boolean } = {}): AsyncGenerator<NexusProgressEvent, InstallRecord | null, { approve: boolean } | void> {
    const current = this.installer.getRecord(appId);
    if (!current) {
      yield { type: 'error', code: 'not-installed',
              message: `'${appId}' is not installed; nothing to update` };
      return null;
    }
    // Re-run install with the same ref; the install pipeline's permission
    // diff against the currently-installed manifest gates new perms.
    const result = yield* this.install({ ref: current.ref, autoApprove: opts.autoApprove });
    this.bus?.emit('nexus:update.complete', { id: appId, record: result });
    return result;
  }

  /** Uninstall: stop instances (caller's responsibility) and drop the
   *  app directory. We don't reach into AppManager from here to keep the
   *  Nexus module dependency-free; the HTTP route layer stops first. */
  async uninstall(appId: string, opts: { purge?: boolean } = {}): Promise<void> {
    await this.installer.uninstall(appId, opts);
    this.bus?.emit('nexus:uninstall.complete', { id: appId });
  }

  /** Publish — Git path (v1 required). */
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
      dataDir: this.dataDir,
      onMessage: (m) => messages.push(m),
    });
    for (const m of messages) yield { type: 'publish.progress', message: m };
    const ref = `${result.repoUrl.replace(/^https?:\/\//, '').replace(/\.git$/, '')}#${result.tag}`;
    yield { type: 'publish.done', ref };
    this.bus?.emit('nexus:publish.complete', { id: result.manifest.id, ref });
    return { ref, installCmd: result.installCmd };
  }

  /** Publish — OCI path (v1 stretch, requires `oras` on PATH). */
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
      dataDir: this.dataDir,
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
          // Index resolved to OCI source.
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
