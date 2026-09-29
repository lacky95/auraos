import type { APIRoute } from 'astro';
import { IconManager } from '@aura/core';

/**
 * Single-icon endpoint for the Lucide long tail (~2000 icons): any icon not
 * in the curated /api/os/icons.svg sprite is available here as a standalone
 * SVG — usable in <img src>, CSS masks, or fetch-and-inline.
 *
 *   /api/os/icons/rotate-cw.svg
 *
 * Names are Lucide kebab-case ids (https://lucide.dev/icons); unknown names
 * 404. Standalone SVG documents can't see the page's `color`, so <img> usage
 * renders with SVG default stroke — prefer the sprite (or inline) when the
 * icon must follow the theme.
 */
export const GET: APIRoute = ({ params }) => {
  const name = (params.name ?? '').replace(/\.svg$/, '');
  const svg = IconManager.renderIconSvg(name);
  if (!svg) return new Response('Unknown icon', { status: 404 });
  return new Response(svg, {
    status: 200,
    headers: {
      'Content-Type':  'image/svg+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    },
  });
};
