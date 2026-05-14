import type { APIRoute } from 'astro';
import { OsEventBus, ThemeManager } from '@aura/core';
import type { ColorMode } from '@aura/core';

/**
 * Bridge endpoint: Settings POSTs here whenever the user picks a different
 * light or dark theme. The body carries the FULL selection (both slots +
 * colorMode) so the event payload is self-contained — subscribers don't have
 * to round-trip through `/api/data/theme` to figure out what's now active.
 */
const KNOWN_MODES: readonly ColorMode[] = ['light', 'dark', 'auto'];

export const POST: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => ({})) as {
    themeIdDark?:  string;
    themeIdLight?: string;
    colorMode?:    string;
  };

  const themeIdDark  = typeof body.themeIdDark  === 'string' ? body.themeIdDark  : ThemeManager.DEFAULT_THEME_ID_DARK;
  const themeIdLight = typeof body.themeIdLight === 'string' ? body.themeIdLight : ThemeManager.DEFAULT_THEME_ID_LIGHT;
  const colorMode    = (KNOWN_MODES.includes(body.colorMode as ColorMode) ? body.colorMode : ThemeManager.DEFAULT_COLOR_MODE) as ColorMode;

  // Sanity: both ids must resolve. Bad ids fall back silently to defaults —
  // the GET path would do the same, so this stays consistent.
  if (!ThemeManager.getTheme(themeIdDark) || !ThemeManager.getTheme(themeIdLight)) {
    return new Response(JSON.stringify({ error: `Unknown theme id in payload` }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { theme: active, resolvedMode } = ThemeManager.resolveActiveTheme(themeIdLight, themeIdDark, colorMode);

  OsEventBus.emit('theme:changed', {
    themeId:      active.id,        // backwards-compat for old listeners
    themeName:    active.name,
    themeIdDark,
    themeIdLight,
    colorMode,
    resolvedMode,
    activeTone:   active.tone,
    framework:    { id: active.framework.id, version: active.framework.version },
  });

  return new Response(JSON.stringify({ ok: true, themeIdDark, themeIdLight, colorMode, resolvedMode, active: active.id }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
