import type { APIRoute } from 'astro';
import {
  loadRegistryConfig, saveRegistryConfig, refreshNexusRegistryConfig,
} from '@aura/core';
import { jsonResponse } from '../../../../lib/appResponse.js';

/** Remove one registry by name. 404 when the name doesn't exist. */
export const DELETE: APIRoute = async ({ params }) => {
  const name = params['name'];
  if (typeof name !== 'string' || !name) {
    return jsonResponse({ error: 'missing-name' }, 400);
  }
  const OS_API_BASE = process.env['OS_API_BASE'] ?? 'http://localhost:3000';
  const cfg = await loadRegistryConfig(OS_API_BASE);
  const before = cfg.registries.length;
  cfg.registries = cfg.registries.filter((e) => e.name !== name);
  if (cfg.registries.length === before) {
    return jsonResponse({ error: 'not-found', detail: name }, 404);
  }
  await saveRegistryConfig(OS_API_BASE, cfg);
  refreshNexusRegistryConfig(cfg);
  return jsonResponse({ ok: true, config: cfg });
};
