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

export interface OciRef {
  /** Full registry path, e.g. 'ghcr.io/user/aura-foo'. */
  registry: string;
  /** Tag or digest. Tags resolved to digests by the resolver before this. */
  tag:      string;
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
export async function fetchOci(ref: OciRef, stagingDir: string): Promise<void> {
  if (!isOrasAvailable()) {
    throw new Error(
      "[NexusOciFetcher] `oras` binary not found on PATH. Install it with " +
      "`aura cap install oras` (or fall back to Git source for this app).",
    );
  }
  mkdirSync(stagingDir, { recursive: true });
  try {
    // `oras pull <ref> -o <dir>` extracts every layer of the artifact
    // into <dir>. For our publish format (one tar.gz layer of the app
    // source) this leaves the manifest + source files in place.
    execFileSync(
      'oras',
      ['pull', `${ref.registry}:${ref.tag}`, '-o', stagingDir],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 },
    );
  } catch (err) {
    throw new Error(`[NexusOciFetcher] pull failed for ${ref.registry}:${ref.tag}: ${(err as Error).message}`);
  }
}

/**
 * Resolve an OCI tag to a sha256 digest by HEADing the manifest endpoint.
 * Returns null when the registry is unreachable or anonymous auth fails.
 */
export function resolveOciDigest(ref: OciRef): string | null {
  if (!isOrasAvailable()) return null;
  try {
    // `oras resolve <ref>` prints the digest.
    const out = execFileSync(
      'oras',
      ['resolve', `${ref.registry}:${ref.tag}`],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 },
    ).toString().trim();
    return out.startsWith('sha256:') ? out : null;
  } catch {
    return null;
  }
}
