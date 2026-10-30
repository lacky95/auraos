import type { APIRoute } from 'astro';
import { layoutRegistry, type LayoutStrategyMeta } from '@aura/core';
import { withEtag } from '../../../lib/etag.js';

/**
 * Read-only OS layout-strategy catalogue. Replaces
 * `/api/data/com.aura.settings/layouts` — the inventory is owned by
 * @aura/core's `LayoutStrategyRegistry`. Shell serves it directly so
 * Settings doesn't need to be running.
 *
 * We translate the registry's free-form `icon` hint (glyph) into a Lucide
 * icon name right here, so every consumer (status bar chip, settings
 * Workspaces, settings Layouts) uses the same icon from one place. The
 * translation table is the single source of truth for layout → icon.
 */

/** Glyph → Lucide icon name. Keep in sync with the per-strategy icons in
 *  packages/core/src/layout/LayoutStrategyRegistry.ts (DEFAULT_LAYOUT_STRATEGIES).
 *  If a registry entry already carries a Lucide name (no glyph), it passes
 *  through untouched. */
const GLYPH_TO_LUCIDE: Record<string, string> = {
  '▦': 'layout-grid',       // tiling
  '▣': 'square',            // fullscreen
  '▥': 'layout-template',   // stack / Free Window
  '▤': 'rows-3',            // rows
};

function resolveIcon(meta: LayoutStrategyMeta): string {
  const hint = meta.icon;
  if (!hint) return 'layout-template';
  if (GLYPH_TO_LUCIDE[hint]) return GLYPH_TO_LUCIDE[hint];
  // Already a Lucide name (future-proof: new strategies can skip the glyph).
  return hint;
}

export const GET: APIRoute = ({ request }) => {
  const enriched = layoutRegistry.list().map((m) => ({ ...m, icon: resolveIcon(m) }));
  return withEtag(request, JSON.stringify(enriched), 'application/json');
};
