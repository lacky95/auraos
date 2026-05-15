import type { APIRoute } from 'astro';
import { ThemeManager } from '@aura/core';

/**
 * Read-only OS theme catalogue. Replaces `/api/data/com.aura.settings/themes`
 * — the inventory was never app state, just a mirror of @aura/core's
 * `ThemeManager.THEMES`. Serving it from the shell removes the dependency
 * on Settings being up.
 */
export const GET: APIRoute = () => {
  return new Response(JSON.stringify({ themes: ThemeManager.listSummaries() }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
