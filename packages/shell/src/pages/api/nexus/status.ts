import type { APIRoute } from 'astro';
import { getNexusManager } from '@aura/core';
import { jsonResponse } from '../../../lib/appResponse.js';

const OS_API_BASE = process.env['OS_API_BASE'] ?? 'http://localhost:3000';

/**
 * Lightweight install-state endpoint for the store UI to poll, without
 * re-fetching the catalog in the page:
 *
 *   apps:       catalog id → InstallState (core NexusManager.installStates —
 *               matched by id AND originId; from the memoised catalog)
 *   installing: ids/refs mid-install
 *   installed:  install-record id → version (older clients)
 */
export const GET: APIRoute = async () => {
  const nexus = getNexusManager();
  const installed: Record<string, string> = {};
  for (const rec of nexus.records.list()) installed[rec.id] = rec.version;
  let apps: Record<string, unknown> = {};
  try {
    await nexus.ensureSourcesLoaded(OS_API_BASE);
    apps = nexus.installStates((await nexus.catalog.get()).apps);
  } catch { /* catalog unavailable: the per-app states are just missing */ }
  return jsonResponse({
    installing: nexus.getInstallingIds(),
    installed,
    apps,
  });
};
