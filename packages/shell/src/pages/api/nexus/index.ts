import type { APIRoute } from 'astro';
import { getNexusManager } from '@aura/core';
import { jsonResponse, errorResponse } from '../../../lib/appResponse.js';

/**
 * GET — returns the cached curated index, refreshing if stale (6h TTL).
 * Empty arrays are a valid response (the index repo doesn't exist yet,
 * the network is down, etc.) — URL install still works without it.
 *
 * `?refresh=1` forces a refresh, bypassing the cache.
 */
export const GET: APIRoute = async ({ url }) => {
  const refresh = url.searchParams.get('refresh') === '1';
  const nexus = getNexusManager();
  try {
    const doc = refresh
      ? await nexus.index.refresh()
      : await nexus.index.get();
    return jsonResponse(doc);
  } catch (err) {
    return errorResponse((err as Error).message, 500);
  }
};
