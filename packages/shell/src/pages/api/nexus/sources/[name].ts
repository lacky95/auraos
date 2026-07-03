import type { APIRoute } from 'astro';
import {
  loadSourcesConfig, saveSourcesConfig, refreshNexusSources, ociSources,
} from '@aura/core';
import { jsonResponse } from '../../../../lib/appResponse.js';

const OS_API_BASE = process.env['OS_API_BASE'] ?? 'http://localhost:3000';

/** Remove one source by name. 404 when the name doesn't exist. Refuses to
 *  remove the last OCI source (publish/install would have nowhere to go). */
export const DELETE: APIRoute = async ({ params }) => {
  const name = params['name'];
  if (typeof name !== 'string' || !name) {
    return jsonResponse({ error: 'missing-name' }, 400);
  }
  const cfg = await loadSourcesConfig(OS_API_BASE);
  const target = cfg.sources.find((s) => s.name === name);
  if (!target) return jsonResponse({ error: 'not-found', detail: name }, 404);
  if (target.kind === 'oci' && ociSources(cfg).length === 1) {
    return jsonResponse({ error: 'last-oci-source', detail: 'cannot remove the only OCI registry' }, 409);
  }
  cfg.sources = cfg.sources.filter((s) => s.name !== name);
  await saveSourcesConfig(OS_API_BASE, cfg);
  refreshNexusSources(cfg);
  return jsonResponse({ ok: true, config: cfg });
};
