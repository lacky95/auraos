import type { APIRoute } from 'astro';
import {
  loadSourcesConfig, saveSourcesConfig, refreshNexusSources, ociRegistryView,
  type RegistryConfig, type RegistryEntry, type SourceEntry,
} from '@aura/core';
import { jsonResponse } from '../../../lib/appResponse.js';

/**
 * Legacy multi-registry API — now a WRITE-THROUGH SHIM over the unified
 * sources config (`os/nexus/sources`). Kept so older callers (`aura nexus
 * registries …`, pre-existing scripts) keep working byte-for-byte:
 *
 *   GET  /api/nexus/registries → the `kind:'oci'` subset, as RegistryConfig
 *   PUT  /api/nexus/registries → replace ALL oci sources (git-* sources kept)
 *   POST /api/nexus/registries → add one oci source
 *
 * Everything funnels through the same KV key + singleton refresh as
 * /api/nexus/sources so the two views can never drift.
 */

const OS_API_BASE = process.env['OS_API_BASE'] ?? 'http://localhost:3000';

function isEntry(v: unknown): v is RegistryEntry {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  return typeof e['name']     === 'string'
      && typeof e['url']      === 'string'
      && typeof e['priority'] === 'number'
      && (e['mirror'] === undefined || typeof e['mirror'] === 'boolean');
}

function toOciSource(e: RegistryEntry): SourceEntry {
  return { kind: 'oci', name: e.name, url: e.url, priority: e.priority, mirror: e.mirror ?? false };
}

export const GET: APIRoute = async () => {
  const cfg = await loadSourcesConfig(OS_API_BASE);
  return jsonResponse(ociRegistryView(cfg));
};

export const PUT: APIRoute = async ({ request }) => {
  let body: unknown;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: 'invalid-json' }, 400); }
  const reg = body as RegistryConfig;
  if (!reg || !Array.isArray(reg.registries) || !reg.registries.every(isEntry)) {
    return jsonResponse({ error: 'invalid-config' }, 400);
  }
  const names = new Set<string>();
  for (const e of reg.registries) {
    if (names.has(e.name)) return jsonResponse({ error: 'duplicate-name', detail: e.name }, 400);
    names.add(e.name);
  }
  // Replace all OCI sources; preserve any git-index / git-app sources.
  const cfg = await loadSourcesConfig(OS_API_BASE);
  const kept = cfg.sources.filter((s) => s.kind !== 'oci');
  cfg.sources = [...reg.registries.map(toOciSource), ...kept];
  await saveSourcesConfig(OS_API_BASE, cfg);
  refreshNexusSources(cfg);
  return jsonResponse(ociRegistryView(cfg));
};

export const POST: APIRoute = async ({ request }) => {
  let body: unknown;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: 'invalid-json' }, 400); }
  if (!isEntry(body)) return jsonResponse({ error: 'invalid-entry' }, 400);
  const cfg = await loadSourcesConfig(OS_API_BASE);
  if (cfg.sources.some((s) => s.name === body.name)) {
    return jsonResponse({ error: 'duplicate-name', detail: body.name }, 409);
  }
  cfg.sources.push(toOciSource(body));
  await saveSourcesConfig(OS_API_BASE, cfg);
  refreshNexusSources(cfg);
  return jsonResponse(ociRegistryView(cfg));
};
