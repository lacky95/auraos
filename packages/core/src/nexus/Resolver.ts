/**
 * Nexus ref resolver. Turns a `<ref>` string the user typed into a
 * concrete `ResolvedRef` ready for fetch + validate + install.
 *
 * Recognised shapes (matched in order):
 *
 *   ./path  |  /abs/path                      → local
 *   oci://<reg>/<repo>[@sha256:…|:<tag>]      → oci (digest if @, tag if :)
 *   <reg>/<repo>:<tag>                        → oci (heuristic: contains '/')
 *   github.com/<user>/<repo>[#<ref>]          → git
 *   git@<host>:<user>/<repo>.git[#<ref>]      → git (ssh form)
 *   https?://…                                → git (assumed)
 *   <reverse.domain.id>[@<channel>]           → index
 *
 * The index path goes through IndexClient.lookup() and picks the
 * `sources.git` (v1 default) or `sources.oci` source from the entry.
 */
import type { CatalogAggregator } from './CatalogAggregator.js';
import { resolveGitCommit } from './Fetchers/GitFetcher.js';
import { resolveOciDigest } from './Fetchers/OciFetcher.js';
import type { RegistryConfig } from './RegistryConfig.js';
import { pickMirror, urlForHost } from './RegistryConfig.js';
import type { ResolvedRef } from './types.js';

export interface ResolverOpts {
  /** Aggregated catalog used to resolve bare reverse-domain ids. */
  catalog: CatalogAggregator;
  /** v1 picks git over oci when an index entry has both. Override to 'oci' to
   *  prefer OCI once it's fully wired. */
  preferredSource?: 'git' | 'oci';
  /** Optional multi-registry config. Used to (a) probe a `mirror: true` entry
   *  first for OCI digests and (b) recover the scheme of a configured host so
   *  plain-HTTP registries get `--plain-http`. */
  registryConfig?: RegistryConfig;
}

export class Resolver {
  constructor(private opts: ResolverOpts) {}

  /** Swap in a new registry config (called when the sources config changes). */
  setRegistryConfig(cfg: RegistryConfig): void {
    this.opts.registryConfig = cfg;
  }

  /** Recover a configured registry URL (with scheme) for an OCI host, so
   *  digest resolution can add `--plain-http` for the local zot. */
  private urlForOciHost(registry: string): string | undefined {
    const cfg = this.opts.registryConfig;
    if (!cfg) return undefined;
    const host = registry.split('/')[0] ?? registry;
    return urlForHost(cfg, host) ?? undefined;
  }

  async resolve(rawRef: string): Promise<ResolvedRef> {
    const ref = rawRef.trim();
    if (!ref) throw new Error('[NexusResolver] empty ref');

    if (ref.startsWith('./') || ref.startsWith('/') || ref.startsWith('../')) {
      return this.resolveLocal(ref);
    }
    if (ref.startsWith('oci://')) {
      return this.resolveOci(ref.slice('oci://'.length), rawRef);
    }
    if (ref.startsWith('git@') || /^https?:\/\//.test(ref)) {
      return this.resolveGit(ref, rawRef);
    }
    if (ref.startsWith('github.com/') || /^[\w.-]+\.(com|io|dev|org|net)\//.test(ref)) {
      // Looks like a git host but no scheme — prepend https://.
      return this.resolveGit(`https://${ref.split('#')[0]}`, rawRef, refFragment(ref));
    }
    // Tagged OCI ref (e.g. ghcr.io/foo/bar:1.2.3) — has `/` and `:` and looks
    // registryish. Heuristic: contains a colon AND a slash AND no '#' fragment.
    if (ref.includes('/') && ref.includes(':') && !ref.includes('#')) {
      return this.resolveOci(ref, rawRef);
    }
    // Otherwise treat as a bare reverse-domain id, optionally with @channel.
    if (/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+(@[a-zA-Z0-9._-]+)?$/.test(ref)) {
      return this.resolveIndex(ref, rawRef);
    }
    throw new Error(`[NexusResolver] could not parse ref: '${rawRef}'`);
  }

  private async resolveLocal(path: string): Promise<ResolvedRef> {
    return {
      source:  'local',
      rawRef:  path,
      address: path,
      digest:  '',
      manifestPreview: null,
    };
  }

  private async resolveGit(url: string, rawRef: string, fragmentRef?: string): Promise<ResolvedRef> {
    const ref = fragmentRef ?? refFragment(rawRef) ?? undefined;
    const digest = resolveGitCommit({ url, ref }) ?? '';
    return {
      source:  'git',
      rawRef,
      address: url + (ref ? `#${ref}` : ''),
      digest,
      manifestPreview: null,
    };
  }

  private async resolveOci(refBody: string, rawRef: string): Promise<ResolvedRef> {
    // refBody examples: ghcr.io/user/foo:1.2.3, ghcr.io/user/foo@sha256:…
    let registry = refBody;
    let tag = 'latest';
    const atIdx = refBody.lastIndexOf('@');
    const colonIdx = refBody.lastIndexOf(':');
    if (atIdx > refBody.indexOf('/')) {
      registry = refBody.slice(0, atIdx);
      tag = refBody.slice(atIdx + 1);  // already a digest
    } else if (colonIdx > refBody.lastIndexOf('/')) {
      registry = refBody.slice(0, colonIdx);
      tag = refBody.slice(colonIdx + 1);
    }
    // Multi-registry: when a mirror is configured, try resolving the digest
    // against it first. The mirror is expected to host the same repo path
    // (e.g. `user/foo`) at a different host (e.g. local zot). Falls through
    // to the canonical registry on miss so non-mirrored refs still work.
    const mirror = this.opts.registryConfig ? pickMirror(this.opts.registryConfig) : null;
    const hostUrl = this.urlForOciHost(registry);
    let digest = '';
    if (tag.startsWith('sha256:')) {
      digest = tag;
    } else if (mirror) {
      digest = resolveOciDigest({ registry, tag }, mirror.url)
            ?? resolveOciDigest({ registry, tag }, hostUrl)
            ?? '';
    } else {
      digest = resolveOciDigest({ registry, tag }, hostUrl) ?? '';
    }
    return {
      source:  'oci',
      rawRef,
      address: `${registry}:${tag}`,
      digest,
      manifestPreview: null,
    };
  }

  private async resolveIndex(bareRef: string, rawRef: string): Promise<ResolvedRef> {
    const [id, channel = 'stable'] = bareRef.split('@');
    const entry = await this.opts.catalog.lookup(id!);
    if (!entry) {
      throw new Error(`[NexusResolver] '${id}' not found in any registered source`);
    }
    const channelInfo = entry.channels?.[channel];

    // Prefer the entry's NATIVE distribution: an OCI-sourced catalog entry
    // only carries `sources.oci`, a git-app/git-index entry carries
    // `sources.git`. When an entry declares both (a curated index can), honour
    // `preferredSource` (default git). The loop picks the first available.
    const nativelyOci = !!entry.sources.oci && !entry.sources.git;
    const prefer = nativelyOci ? 'oci' : (this.opts.preferredSource ?? 'git');
    const order: Array<'git' | 'oci'> = prefer === 'git' ? ['git', 'oci'] : ['oci', 'git'];

    for (const src of order) {
      if (src === 'git' && entry.sources.git) {
        // Catalog entries store the git ref host-relative (`github.com/u/r`);
        // full URLs already carry a scheme.
        const gitRef = entry.sources.git.ref;
        const url = /^https?:\/\//.test(gitRef) || gitRef.startsWith('git@')
          ? gitRef : `https://${gitRef}`;
        const ref = channelInfo?.['git-tag']
                 ?? entry.sources.git['default-branch']
                 ?? undefined;
        const digest = resolveGitCommit({ url, ref }) ?? '';
        return {
          source:  'index',
          rawRef,
          address: url + (ref ? `#${ref}` : ''),
          digest,
          channel,
          manifestPreview: null,
        };
      }
      if (src === 'oci' && entry.sources.oci) {
        const tag = channelInfo?.['oci-tag'] ?? 'latest';
        const registry = entry.sources.oci.ref;
        const hostUrl = this.urlForOciHost(registry);
        const digest = resolveOciDigest({ registry, tag }, hostUrl) ?? '';
        return {
          source:  'index',
          rawRef,
          // `oci://` prefix flags the fetch dispatcher to pull via oras (a bare
          // `host:port/repo:tag` string is ambiguous vs. a git URL).
          address: `oci://${registry}:${tag}`,
          digest,
          channel,
          manifestPreview: null,
        };
      }
    }
    throw new Error(`[NexusResolver] catalog entry for '${id}' has no usable source`);
  }
}

function refFragment(ref: string): string | undefined {
  const idx = ref.indexOf('#');
  return idx >= 0 ? ref.slice(idx + 1) : undefined;
}
