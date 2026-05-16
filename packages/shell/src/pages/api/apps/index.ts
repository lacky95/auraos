import type { APIRoute } from 'astro';
import { getAppManager } from '@aura/core';
import { jsonResponse } from '../../../lib/appResponse.js';

/**
 * Returns every installed app with its manifest, running instances and
 * any open activities (flat lists; the UI does the nesting).
 * No health probe — frequent endpoint.
 */
export const GET: APIRoute = () => {
  const mgr = getAppManager();
  const apps = mgr.getManifests().map((manifest) => ({
    manifest,
    // Surface the enable flag alongside the manifest so the shell + CLI can
    // filter (Dock, Launcher, `aura app list`) without a second round-trip
    // to /api/admin/apps/enabled. Default is true for any app missing from
    // the KV state map.
    enabled:    mgr.isEnabled(manifest.id),
    instances:  mgr.getInstancesByApp(manifest.id),
    activities: mgr.getActivitiesByApp(manifest.id),
  }));
  return jsonResponse(apps);
};
