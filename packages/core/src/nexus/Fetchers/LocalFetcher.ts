/**
 * Local fetcher — handles `aura nexus install <path>` for filesystem paths.
 * Just an `rsync -a` (cp -r fallback) into the staging dir; no network.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, cpSync } from 'node:fs';
import { resolve } from 'node:path';

export async function fetchLocal(sourcePath: string, stagingDir: string): Promise<void> {
  const abs = resolve(sourcePath);
  if (!existsSync(abs)) {
    throw new Error(`[NexusLocalFetcher] source does not exist: ${abs}`);
  }
  mkdirSync(stagingDir, { recursive: true });
  // Prefer rsync (handles symlinks + sparse files + huge trees more
  // gracefully than node's cpSync) but fall back if not present.
  try {
    execFileSync(
      'rsync',
      ['-a', '--exclude=node_modules', '--exclude=.next',
       '--exclude=dist', '--exclude=.astro', '--exclude=.turbo',
       '--exclude=.cache',
       `${abs}/`, `${stagingDir}/`],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
  } catch {
    cpSync(abs, stagingDir, {
      recursive: true,
      filter: (src) => !/(node_modules|\.next|dist|\.astro|\.turbo|\.cache)$/.test(src),
    });
  }
}
