import type { APIRoute } from 'astro';
import { getNexusManager, getAppManager } from '@aura/core';
import { jsonResponse } from '../../../lib/appResponse.js';

/**
 * Lists every installed app the AppRegistry knows about, merged with its
 * Nexus install record (source, version, channel, install timestamps).
 * Apps without a Nexus record (cloned from the monorepo, scaffolded
 * locally, etc.) get `source: 'local'` and the rest of the record null.
 */
export const GET: APIRoute = () => {
  const mgr   = getAppManager();
  const nexus = getNexusManager();
  const installed = mgr.getManifests().map((manifest) => {
    const record = nexus.records.get(manifest.id);
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
      },
      isNexusInstalled: !!record,
    };
  });
  return jsonResponse(installed);
};
