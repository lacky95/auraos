import type { APIRoute } from 'astro';
import { getNexusManager } from '@aura/core';
import { jsonResponse } from '../../../lib/appResponse.js';

/** Substring search over the cached index. `?q=…` empty returns everything. */
export const GET: APIRoute = async ({ url }) => {
  const q = url.searchParams.get('q') ?? '';
  const category = url.searchParams.get('category');
  const nexus = getNexusManager();
  let hits = await nexus.index.search(q);
  if (category) {
    hits = hits.filter((e) => (e.categories ?? []).includes(category));
  }
  return jsonResponse({ results: hits });
};
