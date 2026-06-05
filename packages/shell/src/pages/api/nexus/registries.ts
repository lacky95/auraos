import type { APIRoute } from 'astro';
import {
  loadRegistryConfig, saveRegistryConfig,
  refreshNexusRegistryConfig,
  type RegistryConfig, type RegistryEntry,
} from '@aura/core';
import { jsonResponse } from '../../../lib/appResponse.js';

/**
 * Nexus multi-registry config — list / replace / add a single entry.
 *
 *   GET    /api/nexus/registries           → current config (KV-backed)
 *   PUT    /api/nexus/registries           → replace whole config
 *   POST   /api/nexus/registries           → add one entry, validate uniqueness
 *
 * Per-entry DELETE lives in ./registries/[name].ts (Astro filesystem
 * routing — the bracket-param file is the only way to express it).
 *
 * Every mutating handler:
 *   1. validates the payload shape;
 *   2. persists to KV via saveRegistryConfig (round-trips through
 *      /api/kv/os/nexus/registries on this same shell);
 *   3. refreshes the NexusManager singleton so subsequent installs see the
 *      new mirrors immediately without a shell restart.
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

export const GET: APIRoute = async () => {
  const cfg = await loadRegistryConfig(OS_API_BASE);
  return jsonResponse(cfg);
};

export const PUT: APIRoute = async ({ request }) => {
  let body: unknown;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: 'invalid-json' }, 400); }
  const cfg = body as RegistryConfig;
  if (!cfg || !Array.isArray(cfg.registries) || !cfg.registries.every(isEntry)) {
    return jsonResponse({ error: 'invalid-config' }, 400);
  }
  const names = new Set<string>();
  for (const e of cfg.registries) {
    if (names.has(e.name)) {
      return jsonResponse({ error: 'duplicate-name', detail: e.name }, 400);
    }
    names.add(e.name);
  }
  await saveRegistryConfig(OS_API_BASE, cfg);
  refreshNexusRegistryConfig(cfg);
  return jsonResponse({ ok: true, config: cfg });
};

export const POST: APIRoute = async ({ request }) => {
  let body: unknown;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: 'invalid-json' }, 400); }
  if (!isEntry(body)) {
    return jsonResponse({ error: 'invalid-entry' }, 400);
  }
  const cfg = await loadRegistryConfig(OS_API_BASE);
  if (cfg.registries.some((e) => e.name === body.name)) {
    return jsonResponse({ error: 'duplicate-name', detail: body.name }, 409);
  }
  cfg.registries.push(body);
  await saveRegistryConfig(OS_API_BASE, cfg);
  refreshNexusRegistryConfig(cfg);
  return jsonResponse({ ok: true, config: cfg });
};
