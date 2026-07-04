import type { APIRoute } from 'astro';
import { getNexusManager } from '@aura/core';
import { jsonResponse } from '../../../lib/appResponse.js';

/**
 * Lightweight install-state endpoint for the store UI to poll. Returns which
 * apps are mid-install and which are installed (id → version), so a page can
 * render/refresh the per-app INSTALL / INSTALLING… / INSTALLED state — and keep
 * it correct across reloads — without re-fetching the whole aggregated catalog.
 */
export const GET: APIRoute = () => {
  const nexus = getNexusManager();
  const installed: Record<string, string> = {};
  for (const rec of nexus.records.list()) installed[rec.id] = rec.version;
  return jsonResponse({
    installing: nexus.getInstallingIds(),
    installed,
  });
};
