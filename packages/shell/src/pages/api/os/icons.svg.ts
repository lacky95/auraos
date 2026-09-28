import type { APIRoute } from 'astro';
import { IconManager } from '@aura/core';

/**
 * The OS icon sprite — Lucide, curated set (see CURATED_ICONS in @aura/core).
 * Themed apps use it with zero dependencies:
 *
 *   <svg class="aura-icon"><use href="/api/os/icons.svg#lucide-settings"/></svg>
 *
 * Icons stroke `currentColor`, so they follow the theme via the element's
 * `color`. The long tail is served per-icon at /api/os/icons/<name>.svg.
 * Content only changes with the bundled lucide version, so it may be cached.
 */
const sprite = IconManager.renderSprite();

export const GET: APIRoute = () =>
  new Response(sprite, {
    status: 200,
    headers: {
      'Content-Type':  'image/svg+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    },
  });
