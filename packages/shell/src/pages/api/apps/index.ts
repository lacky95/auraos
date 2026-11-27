import type { APIRoute } from 'astro';
import { contractRefusal, getAppManager } from '@aura/core';
import { jsonResponse, publicInstance } from '../../../lib/appResponse.js';

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
    // D48: built for a newer Aura contract: listed, never started. The refusal message, else null.
    incompatible: contractRefusal(manifest)?.message ?? null,
    // `sidecarCount` comes from the reconciler's cache — no backend call, so
    // this stays cheap. Details + usage: /api/instances/<id>/sidecars.
    instances:  mgr.getInstancesByApp(manifest.id).map((inst) => ({
      ...publicInstance(inst, mgr),
      sidecarCount: mgr.getSidecars(inst.instanceId).length,
      // Where the shell dials the instance (AppManager.getUpstreamUrl): the WS
      // proxy and the App Host router read it here instead of guessing (a
      // System Terminal listens only on its private network, D58). Null when
      // its runner no longer tracks it. The owner and the shell read this list.
      upstreamHost: mgr.getUpstreamUrl(inst.instanceId)?.host ?? null,
    })),
    activities: mgr.getActivitiesByApp(manifest.id),
  }));
  return jsonResponse(apps);
};
