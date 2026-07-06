import type { APIRoute } from 'astro';
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadSourcesConfig, saveSourcesConfig, isSourceEntry, refreshNexusSources,
  loadGitIndexDoc, validateStagedDir,
  type SourcesConfig, type SourceEntry, type GitAppMeta,
} from '@aura/core';
import { jsonResponse } from '../../../lib/appResponse.js';

/**
 * Nexus sources config — the catalogs/registries the store aggregates and
 * that `aura nexus app publish` can target.
 *
 *   GET  /api/nexus/sources   → current config (KV-backed, migrated from the
 *                               legacy registries key on first read)
 *   PUT  /api/nexus/sources   → replace the whole config
 *   POST /api/nexus/sources   → add one source, validated by kind
 *
 * Per-source DELETE lives in ./sources/[name].ts.
 *
 * POST content validation is STRICT per kind (the whole point of the source
 * model — the store never guesses what a git URL is):
 *   • git-index → must fetch + parse an index.yaml, else 422
 *   • git-app   → must shallow-clone + carry a valid app.manifest.json at root;
 *                 the manifest snapshot is captured into `appMeta`, else 422
 *   • oci       → accepted as-is (registries may be offline at registration)
 */

const OS_API_BASE = process.env['OS_API_BASE'] ?? 'http://localhost:3000';

export const GET: APIRoute = async () => {
  const cfg = await loadSourcesConfig(OS_API_BASE);
  return jsonResponse(cfg);
};

export const PUT: APIRoute = async ({ request }) => {
  let body: unknown;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: 'invalid-json' }, 400); }
  const cfg = body as SourcesConfig;
  if (!cfg || !Array.isArray(cfg.sources) || !cfg.sources.every(isSourceEntry)) {
    return jsonResponse({ error: 'invalid-config' }, 400);
  }
  const names = new Set<string>();
  for (const s of cfg.sources) {
    if (names.has(s.name)) return jsonResponse({ error: 'duplicate-name', detail: s.name }, 400);
    names.add(s.name);
  }
  const normalised: SourcesConfig = { schema: 1, sources: cfg.sources };
  await saveSourcesConfig(OS_API_BASE, normalised);
  refreshNexusSources(normalised);
  return jsonResponse({ ok: true, config: normalised });
};

export const POST: APIRoute = async ({ request }) => {
  let body: unknown;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: 'invalid-json' }, 400); }
  if (!isSourceEntry(body)) {
    return jsonResponse({ error: 'invalid-entry', detail: 'expected { kind, name, url, priority }' }, 400);
  }
  const entry = body as SourceEntry;

  const cfg = await loadSourcesConfig(OS_API_BASE);
  if (cfg.sources.some((s) => s.name === entry.name)) {
    return jsonResponse({ error: 'duplicate-name', detail: entry.name }, 409);
  }

  // Strict per-kind content validation.
  try {
    if (entry.kind === 'git-index') {
      const doc = await loadGitIndexDoc(entry);
      // A valid index is parseable; empty apps is allowed (author may be
      // seeding). Reject only unparseable/unreachable (loadGitIndexDoc throws).
      void doc;
    } else if (entry.kind === 'git-app') {
      entry.appMeta = probeGitApp(entry.url, entry.ref);
    }
    // oci: accepted without a reachability probe.
  } catch (err) {
    return jsonResponse({ error: 'source-validation-failed', kind: entry.kind, detail: (err as Error).message }, 422);
  }

  cfg.sources.push(entry);
  await saveSourcesConfig(OS_API_BASE, cfg);
  refreshNexusSources(cfg);
  return jsonResponse({ ok: true, config: cfg });
};

/** Shallow-clone a git-app repo and read its root manifest into a snapshot. */
function probeGitApp(url: string, ref?: string): GitAppMeta {
  const tmp = join('/tmp', `aura-gitapp-${Date.now()}`);
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
