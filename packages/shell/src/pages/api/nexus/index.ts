import type { APIRoute } from 'astro';
import { getNexusManager } from '@aura/core';
import { jsonResponse, errorResponse } from '../../../lib/appResponse.js';

const OS_API_BASE = process.env['OS_API_BASE'] ?? 'http://localhost:3000';

/**
 * GET — the aggregated app-store catalog across every registered source
 * (OCI registries, git-index repos, git-app repos) plus the bundled seed.
 * Each entry carries `install` — its InstallState (core NexusManager
 * .installStates: matched by id AND originId, so an app installed under
 * another id or built here still reads as installed). `installed` /
 * `installedVersion` / `installing` stay for older clients.
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
    const states = nexus.installStates(cat.apps);
    const apps = cat.apps.map((a) => {
      const install = states[a.id]!;
      return {
        ...a,
        install,
        installed: install.status === 'installed',
        installedVersion: install.status === 'installed' ? install.installedVersion ?? null : null,
        installing: install.status === 'installing',
      };
    });
    return jsonResponse({ ...cat, apps });
  } catch (err) {
    return errorResponse((err as Error).message, 500);
  }
};
