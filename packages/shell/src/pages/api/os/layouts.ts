import type { APIRoute } from 'astro';
import { layoutRegistry } from '@aura/core';

/**
 * Read-only OS layout-strategy catalogue. Replaces
 * `/api/data/com.aura.settings/layouts` — the inventory is owned by
 * @aura/core's `LayoutStrategyRegistry`. Shell serves it directly so
 * Settings doesn't need to be running.
 */
export const GET: APIRoute = () => {
  return new Response(JSON.stringify(layoutRegistry.list()), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
