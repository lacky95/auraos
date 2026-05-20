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
import type { IndexClient } from './IndexClient.js';
import { resolveGitCommit } from './Fetchers/GitFetcher.js';
import { resolveOciDigest } from './Fetchers/OciFetcher.js';
import type { ResolvedRef, NexusSource } from './types.js';

export interface ResolverOpts {
  index: IndexClient;
  /** v1 picks git over oci when an index entry has both. Override to 'oci' to
   *  prefer OCI once it's fully wired. */
  preferredSource?: 'git' | 'oci';
}

export class Resolver {
  constructor(private opts: ResolverOpts) {}

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
    const digest = tag.startsWith('sha256:')
      ? tag
      : (resolveOciDigest({ registry, tag }) ?? '');
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
    const entry = await this.opts.index.lookup(id!);
    if (!entry) {
      throw new Error(`[NexusResolver] '${id}' not found in the curated index`);
    }
    const prefer = this.opts.preferredSource ?? 'git';
    const channelInfo = entry.channels?.[channel];

    // Prefer the requested source; fall back to the other if the preferred
    // is missing.
    const order: Array<'git' | 'oci'> = prefer === 'git' ? ['git', 'oci'] : ['oci', 'git'];

    for (const src of order) {
      if (src === 'git' && entry.sources.git) {
        const url = `https://${entry.sources.git.ref}`;
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
        const digest = resolveOciDigest({ registry, tag }) ?? '';
        return {
          source:  'index',
          rawRef,
          address: `${registry}:${tag}`,
          digest,
          channel,
          manifestPreview: null,
        };
      }
    }
    throw new Error(`[NexusResolver] index entry for '${id}' has no usable source`);
  }
}

function refFragment(ref: string): string | undefined {
  const idx = ref.indexOf('#');
  return idx >= 0 ? ref.slice(idx + 1) : undefined;
}
