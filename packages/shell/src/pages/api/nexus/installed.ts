import type { APIRoute } from 'astro';
import { getNexusManager, getAppManager } from '@aura/core';
import { jsonResponse } from '../../../lib/appResponse.js';

/**
 * Lists every installed app the AppRegistry knows about, merged with its
 * Nexus install record. The `scope` field indicates which tier the app
 * came from (system / global / user).
 */
export const GET: APIRoute = () => {
  const mgr   = getAppManager();
  const nexus = getNexusManager();
  const installed = mgr.getManifests().map((manifest) => {
    const record = nexus.records.get(manifest.id);
    // ScopedManifest carries scopeId set at registry load time.
    const scopeId = (manifest as { scopeId?: string }).scopeId ?? 'system';
    return {
      manifest,
      record: record ?? {
        id:          manifest.id,
        version:     manifest.version,
        source:      'local' as const,
        ref:         mgr.getAppsDir() + '/' + manifest.id,
        digest:      '',
        channel:     null,
        installedAt: '',
        updatedAt:   '',
        scope:       scopeId,
      },
      isNexusInstalled: !!record,
      scope: record?.scope ?? scopeId,
    };
  });
  return jsonResponse(installed);
};
