import type { APIRoute } from 'astro';
import { getNexusManager } from '@aura/core';
import { jsonResponse } from '../../../lib/appResponse.js';

const OS_API_BASE = process.env['OS_API_BASE'] ?? 'http://localhost:3000';

/** Substring search over the aggregated catalog. `?q=` empty returns
 *  everything; `?category=` filters by category slug; `?refresh=1` re-fetches. */
export const GET: APIRoute = async ({ url }) => {
  const q = url.searchParams.get('q') ?? '';
  const category = url.searchParams.get('category');
  const refresh = url.searchParams.get('refresh') === '1';
  const nexus = getNexusManager();
  await nexus.ensureSourcesLoaded(OS_API_BASE);
  if (refresh) await nexus.catalog.refresh();
  let hits = await nexus.catalog.search(q);
  if (category) {
    hits = hits.filter((e) => (e.categories ?? []).includes(category));
  }
  return jsonResponse({ results: hits });
};
