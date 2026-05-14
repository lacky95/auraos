import type { APIRoute } from 'astro';
import { OsEventBus, ThemeManager } from '@aura/core';
import type { ColorMode } from '@aura/core';

/**
 * Bridge endpoint: Settings POSTs here whenever the user toggles light / dark /
 * auto. Body carries the full current selection (both theme slots + colorMode)
 * so subscribers can repaint without an extra round-trip.
 *
 * `resolvedMode` is computed server-side as `auto → dark` (the SSR fallback).
 * The client re-resolves to `light` automatically via the `@media` block in
 * /api/os/theme.css when `prefers-color-scheme: light` matches.
 */
const KNOWN_MODES: readonly ColorMode[] = ['light', 'dark', 'auto'];

export const POST: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => ({})) as {
    themeIdDark?:  string;
    themeIdLight?: string;
    colorMode?:    string;
  };

  const colorMode = body.colorMode as ColorMode | undefined;
  if (!colorMode || !KNOWN_MODES.includes(colorMode)) {
    return new Response(JSON.stringify({ error: `Unknown colorMode '${body.colorMode}'` }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const themeIdDark  = typeof body.themeIdDark  === 'string' ? body.themeIdDark  : ThemeManager.DEFAULT_THEME_ID_DARK;
  const themeIdLight = typeof body.themeIdLight === 'string' ? body.themeIdLight : ThemeManager.DEFAULT_THEME_ID_LIGHT;

  const { theme: active, resolvedMode } = ThemeManager.resolveActiveTheme(themeIdLight, themeIdDark, colorMode);

  OsEventBus.emit('mode:changed', {
    themeId:      active.id,
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
