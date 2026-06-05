/**
 * OCI fetcher — scaffold for v1. Per the plan, v1 ships the Git path as the
 * required working surface; OCI install is best-effort.
 *
 * Strategy: shell out to `oras pull` when available (Apache 2, single
 * binary, supports every OCI Distribution v2 registry). When `oras` isn't
 * on PATH, surface a clear "OCI requires `oras`; see docs" error so the
 * user can install it via `aura cap install oras` later.
 *
 * A hand-rolled minimal Distribution v2 client is the v1.5 follow-up —
 * the interface here is shaped so swapping the implementation is a
 * single-file change.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { orasHostFromUrl, orasFlagsForUrl } from '../RegistryConfig.js';

export interface OciRef {
  /** Full registry path, e.g. 'ghcr.io/user/aura-foo'. */
  registry: string;
  /** Tag or digest. Tags resolved to digests by the resolver before this. */
  tag:      string;
}

/**
 * Build the OCI ref string + extra `oras` flags for a given target registry.
 * When `overrideUrl` is provided, swap the host in `ref.registry` for the
 * override's host AND emit `--plain-http` if the URL is http://. The repo
 * path portion of `ref.registry` (everything after the first `/`) is kept
 * intact — mirrors host the same repo names by convention.
 */
function buildRef(ref: OciRef, overrideUrl?: string): { fullRef: string; extraFlags: string[] } {
  if (!overrideUrl) {
    return { fullRef: `${ref.registry}:${ref.tag}`, extraFlags: [] };
  }
  const newHost = orasHostFromUrl(overrideUrl);
  // Strip the original host (everything up to the first '/') so the repo
  // path lands intact at the new host. When ref.registry contains no '/',
  // there's no repo path — just point at the new host.
  const slash = ref.registry.indexOf('/');
  const repoPath = slash > 0 ? ref.registry.slice(slash) : '';
  return {
    fullRef:    `${newHost}${repoPath}:${ref.tag}`,
    extraFlags: orasFlagsForUrl(overrideUrl),
  };
}

/** Return true if the `oras` binary is available on PATH. */
export function isOrasAvailable(): boolean {
  try {
    execFileSync('oras', ['version'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Pull an OCI artifact's layers into the staging dir. Each layer is
 * expected to be a tar.gz of the app source.
 */
export async function fetchOci(ref: OciRef, stagingDir: string, registryUrl?: string): Promise<void> {
  if (!isOrasAvailable()) {
    throw new Error(
      "[NexusOciFetcher] `oras` binary not found on PATH. Install it with " +
      "`aura cap install oras` (or fall back to Git source for this app).",
    );
  }
  mkdirSync(stagingDir, { recursive: true });
  const { fullRef, extraFlags } = buildRef(ref, registryUrl);
  try {
    // `oras pull <ref> -o <dir>` extracts every layer of the artifact
    // into <dir>. For our publish format (one tar.gz layer of the app
    // source) this leaves the manifest + source files in place.
    execFileSync(
      'oras',
      ['pull', fullRef, '-o', stagingDir, ...extraFlags],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 },
    );
  } catch (err) {
    throw new Error(`[NexusOciFetcher] pull failed for ${fullRef}: ${(err as Error).message}`);
  }
}

/**
 * Resolve an OCI tag to a sha256 digest by HEADing the manifest endpoint.
 * Returns null when the registry is unreachable or anonymous auth fails.
 */
export function resolveOciDigest(ref: OciRef, registryUrl?: string): string | null {
  if (!isOrasAvailable()) return null;
  const { fullRef, extraFlags } = buildRef(ref, registryUrl);
  try {
    // `oras resolve <ref>` prints the digest.
    const out = execFileSync(
      'oras',
      ['resolve', fullRef, ...extraFlags],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 },
    ).toString().trim();
    return out.startsWith('sha256:') ? out : null;
  } catch {
    return null;
  }
}

/**
 * Like `resolveOciDigest` but returns the upstream `oras` error in addition
 * to null on failure. Used by the publish script to do a fast "does this tag
 * already exist?" check without throwing.
 */
export function tagExists(ref: OciRef, registryUrl?: string): boolean {
  return resolveOciDigest(ref, registryUrl) !== null;
}
