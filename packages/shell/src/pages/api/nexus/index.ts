import type { APIRoute } from 'astro';
import { getNexusManager } from '@aura/core';
import { jsonResponse, errorResponse } from '../../../lib/appResponse.js';

const OS_API_BASE = process.env['OS_API_BASE'] ?? 'http://localhost:3000';

/**
 * GET — the aggregated app-store catalog across every registered source
 * (OCI registries, git-index repos, git-app repos) plus the bundled seed.
 * Each entry is decorated with `installedVersion` (+ `installed`) from the
 * local install records so the store can render an INSTALLED state.
 *
 * Empty `apps` is valid (no sources registered, all offline, etc.) — ref
 * install still works without any catalog.
 *
 * `?refresh=1` forces every source to re-fetch, bypassing the per-source cache.
 */
export const GET: APIRoute = async ({ url }) => {
  const refresh = url.searchParams.get('refresh') === '1';
  const nexus = getNexusManager();
  try {
    await nexus.ensureSourcesLoaded(OS_API_BASE);
    const cat = refresh ? await nexus.catalog.refresh() : await nexus.catalog.get();
    const apps = cat.apps.map((a) => {
      const rec = nexus.records.get(a.id);
      return { ...a, installed: !!rec, installedVersion: rec?.version ?? null };
    });
    return jsonResponse({ ...cat, apps });
  } catch (err) {
    return errorResponse((err as Error).message, 500);
  }
};
