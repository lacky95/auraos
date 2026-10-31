import type { APIRoute } from 'astro';
import {
  loadSourcesConfig, saveSourcesConfig, refreshNexusSources, ociSources, loadGitIndexDoc,
  type SourceEntry,
} from '@aura/core';
// Namespace import: the running shell may cache a core build without newer exports.
import * as core from '@aura/core';
import { jsonResponse } from '../../../../lib/appResponse.js';
import { managedMarker } from '../../../../lib/nexusSeeds.js';
import { probeGitApp } from '../../../../lib/nexusGitApp.js';

const OS_API_BASE = process.env['OS_API_BASE'] ?? 'http://localhost:3000';
const DATA_DIR    = process.env['AURA_DATA_DIR'] ?? '/data';

/**
 * One source by name (its alias).
 *
 *   PATCH  { name?, url?, priority?, mirror?, appRepoPrefix?, ref?, repo? }
 *          → edit it. `name` renames the alias (publish targets such as a
 *            manifest's `publish.registry` that use the old alias must follow).
 *            A changed git url is validated like on add. An oci source with a
 *            login keeps its registry host (the login is bound to it).
 *   DELETE → remove it. Refuses the last OCI source (publish/install would have
 *            nowhere to go). A private source's sealed login is deleted with it.
 *
 * A source a seed marks `managed` (lib/nexusSeeds.ts) is locked: 409.
 */
export const PATCH: APIRoute = async ({ params, request }) => {
  const name = params['name'];
  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; }
  catch { return jsonResponse({ error: 'invalid-json' }, 400); }
  if (!body || typeof body !== 'object') return jsonResponse({ error: 'invalid-body' }, 400);

  const cfg = await loadSourcesConfig(OS_API_BASE);
  const idx = cfg.sources.findIndex((s) => s.name === name);
  if (idx < 0) return jsonResponse({ error: 'not-found', detail: name }, 404);
  const cur = cfg.sources[idx]!;
  const managed = managedMarker(cur);
  if (managed) return jsonResponse({ error: 'managed-source', detail: `${cur.name} is managed by ${managed.origin} — change it there` }, 409);

  const next = { ...cur } as SourceEntry & Record<string, unknown>;
  const bad = (detail: string) => jsonResponse({ error: 'invalid-field', detail }, 400);

  if (body['name'] !== undefined) {
    const n = typeof body['name'] === 'string' ? body['name'].trim() : '';
    if (!n) return bad('name must be a non-empty string');
    if (n !== cur.name && cfg.sources.some((s) => s.name === n)) return jsonResponse({ error: 'duplicate-name', detail: n }, 409);
    next.name = n;
  }
  if (body['priority'] !== undefined) {
    if (typeof body['priority'] !== 'number' || !Number.isFinite(body['priority'])) return bad('priority must be a number');
    next.priority = body['priority'];
  }
  if (body['url'] !== undefined) {
    const u = typeof body['url'] === 'string' ? body['url'].trim() : '';
    if (!u) return bad('url must be a non-empty string');
    next.url = u;
  }
  if (cur.kind === 'oci') {
    if (body['mirror'] !== undefined) {
      if (typeof body['mirror'] !== 'boolean') return bad('mirror must be true or false');
      next['mirror'] = body['mirror'];
    }
    if (body['appRepoPrefix'] !== undefined) {
      const p = typeof body['appRepoPrefix'] === 'string' ? body['appRepoPrefix'].trim() : '';
      if (p) next['appRepoPrefix'] = p; else delete next['appRepoPrefix'];
    }
    // A URL path is the app prefix (same rule as on add).
    if (body['url'] !== undefined) {
      const { url, prefix } = core.splitOciUrl(next.url);
      next.url = url;
      if (prefix && body['appRepoPrefix'] === undefined) next['appRepoPrefix'] = prefix;
    }
    if (cur.auth && next.url !== cur.url && core.orasHostFromUrl(next.url) !== core.orasHostFromUrl(cur.url)) {
      return jsonResponse({ error: 'login-bound-to-host', detail: 'this registry has a login for its current host — remove the login before moving it to another host' }, 409);
    }
  } else {
    if (body['ref'] !== undefined) {
      const r = typeof body['ref'] === 'string' ? body['ref'].trim() : '';
      if (r) next['ref'] = r; else delete next['ref'];
    }
    if (cur.kind === 'git-index' && body['repo'] !== undefined) {
      const r = typeof body['repo'] === 'string' ? body['repo'].trim() : '';
      if (r) next['repo'] = r; else delete next['repo'];
    }
    const repoMoved = next.url !== cur.url || next['ref'] !== (cur as { ref?: string }).ref;
    if (repoMoved) {
      try {
        if (next.kind === 'git-index') await loadGitIndexDoc(next);
        else if (next.kind === 'git-app') next['appMeta'] = probeGitApp(next.url, next['ref'] as string | undefined);
      } catch (err) {
        return jsonResponse({ error: 'source-validation-failed', kind: next.kind, detail: (err as Error).message }, 422);
      }
    }
  }
  // A renamed seed source is no longer the seed's alias: the user owns it.
  if (next.name !== cur.name) delete next['seed'];

  cfg.sources[idx] = next;
  await saveSourcesConfig(OS_API_BASE, cfg);
  refreshNexusSources(cfg);
  return jsonResponse({ ok: true, source: next, config: cfg });
};

export const DELETE: APIRoute = async ({ params }) => {
  const name = params['name'];
  if (typeof name !== 'string' || !name) {
    return jsonResponse({ error: 'missing-name' }, 400);
  }
  const cfg = await loadSourcesConfig(OS_API_BASE);
  const target = cfg.sources.find((s) => s.name === name);
  if (!target) return jsonResponse({ error: 'not-found', detail: name }, 404);
  const managed = managedMarker(target);
  if (managed) return jsonResponse({ error: 'managed-source', detail: `${name} is managed by ${managed.origin} — remove it there` }, 409);
  if (target.kind === 'oci' && ociSources(cfg).length === 1) {
    return jsonResponse({ error: 'last-oci-source', detail: 'cannot remove the only OCI registry' }, 409);
  }
  cfg.sources = cfg.sources.filter((s) => s.name !== name);
  await saveSourcesConfig(OS_API_BASE, cfg);
  refreshNexusSources(cfg);
  if (target.kind === 'oci' && target.auth) await core.deleteRegistryLogin(DATA_DIR, target.auth);
  return jsonResponse({ ok: true, config: cfg });
};
