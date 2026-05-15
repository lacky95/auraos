import type { APIRoute } from 'astro';
import { ThemeManager } from '@aura/core';
import type { ColorMode } from '@aura/core';
import { defaultKv } from '@aura/kv-store';

/**
 * Returns the currently active OS theme as a CSS document. Apps with
 * `themeStrategy: 'inherit'` (the default) get this auto-injected by the
 * proxy; others can pull it themselves:
 *
 *   <link rel="stylesheet" href="/api/os/theme.css">
 *
 * Reads the active selection from the OS KV (`os/theme`). Falls back to
 * defaults if the key is somehow missing (the bootstrap should have written
 * it, but defence-in-depth keeps the desktop usable on a corrupted RDB).
 */
export const GET: APIRoute = async () => {
  const sel = await readSelection();
  const css = ThemeManager.toCss(sel.themeIdLight, sel.themeIdDark, sel.colorMode);
  return new Response(css, {
    status: 200,
    headers: {
      'Content-Type':  'text/css; charset=utf-8',
      'Cache-Control': 'no-cache',
    },
  });
};

async function readSelection(): Promise<{ themeIdDark: string; themeIdLight: string; colorMode: ColorMode }> {
  const fallback = {
    themeIdDark:  ThemeManager.DEFAULT_THEME_ID_DARK,
    themeIdLight: ThemeManager.DEFAULT_THEME_ID_LIGHT,
    colorMode:    ThemeManager.DEFAULT_COLOR_MODE,
  };
  const kv = defaultKv();
  try {
    const stored = await kv.getValue<{
      themeIdDark?: string; themeIdLight?: string; colorMode?: ColorMode;
    }>('os', 'theme');
    if (!stored) return fallback;
    return {
      themeIdDark:  stored.themeIdDark  ?? fallback.themeIdDark,
      themeIdLight: stored.themeIdLight ?? fallback.themeIdLight,
      colorMode:    stored.colorMode    ?? fallback.colorMode,
    };
  } catch {
    return fallback;
  } finally {
    await kv.close().catch(() => undefined);
  }
}
