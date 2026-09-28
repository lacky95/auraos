import type { APIRoute } from 'astro';
import { createHash } from 'node:crypto';
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
// Content-hash ETag so the browser revalidates instead of blindly caching for
// a day. When the icon set regenerates (e.g. a lucide version bump) the hash
// changes and clients pull the new sprite on their next load — otherwise a
// stale cached copy leaves chrome icons (KILL, etc.) referencing a #lucide-*
// symbol that no longer exists, rendering them blank until the cache expires.
const etag = '"' + createHash('sha1').update(sprite).digest('hex').slice(0, 16) + '"';

export const GET: APIRoute = ({ request }) => {
  // `no-cache` = cache but always revalidate via ETag: a 304 (no body) when
  // unchanged is cheap, and a changed sprite is picked up immediately.
  const headers = {
    'Content-Type':  'image/svg+xml; charset=utf-8',
    'Cache-Control': 'no-cache',
    'ETag': etag,
  };
  if (request.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(sprite, { status: 200, headers });
};
