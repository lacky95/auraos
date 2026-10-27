import type { APIRoute } from 'astro';
import {
  loadSourcesConfig, saveSourcesConfig, refreshNexusSources,
  ociRegistryView, ociSources,
} from '@aura/core';
// Namespace import: the running shell may cache a core build without newer exports.
import * as core from '@aura/core';
import { jsonResponse } from '../../../../lib/appResponse.js';

const OS_API_BASE = process.env['OS_API_BASE'] ?? 'http://localhost:3000';
const DATA_DIR    = process.env['AURA_DATA_DIR'] ?? '/data';

/** Remove one OCI registry by name (legacy shim over the sources config).
 *  Only touches `kind:'oci'` sources; refuses to remove the last one. */
export const DELETE: APIRoute = async ({ params }) => {
  const name = params['name'];
  if (typeof name !== 'string' || !name) {
    return jsonResponse({ error: 'missing-name' }, 400);
  }
  const cfg = await loadSourcesConfig(OS_API_BASE);
  const target = cfg.sources.find((s) => s.name === name && s.kind === 'oci');
  if (!target) return jsonResponse({ error: 'not-found', detail: name }, 404);
  if (ociSources(cfg).length === 1) {
    return jsonResponse({ error: 'last-oci-source', detail: 'cannot remove the only OCI registry' }, 409);
  }
  cfg.sources = cfg.sources.filter((s) => !(s.name === name && s.kind === 'oci'));
  await saveSourcesConfig(OS_API_BASE, cfg);
  refreshNexusSources(cfg);
  if (target.kind === 'oci' && target.auth) await core.deleteRegistryLogin(DATA_DIR, target.auth);
  return jsonResponse(ociRegistryView(cfg));
};
