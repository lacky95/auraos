/**
 * Probe a single-app git repo: shallow-clone it and read its root manifest
 * into the snapshot a `git-app` source carries (`appMeta`) — the catalog
 * lists a git-app from that snapshot without cloning on every aggregation.
 * Used when a source is added (POST /api/nexus/sources) and when one is
 * seeded (lib/nexusSeeds.ts).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { validateStagedDir, type GitAppMeta } from '@aura/core';

export function probeGitApp(url: string, ref?: string): GitAppMeta {
  const tmp = join('/tmp', `aura-gitapp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const args = ['clone', '--depth', '1'];
  if (ref) args.push('--branch', ref);
  args.push(url, tmp);
  try {
    execFileSync('git', args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
    if (!existsSync(join(tmp, 'app.manifest.json'))) {
      throw new Error('no app.manifest.json at repo root — is this a single-app repo?');
    }
    const manifest = validateStagedDir(tmp);
    return {
      id:          manifest.id,
      ...(manifest.originId ? { originId: manifest.originId } : {}),
      name:        manifest.name,
      version:     manifest.version,
      description: manifest.description,
      icon:        manifest.icon,
      category:    manifest.category,
    };
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}
