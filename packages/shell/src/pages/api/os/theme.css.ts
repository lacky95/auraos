import type { APIRoute } from 'astro';
import { getAppManager, ThemeManager } from '@aura/core';
import type { ColorMode } from '@aura/core';

/**
 * Returns the currently active OS theme as a CSS document. Apps with
 * `themeStrategy: 'inherit'` (the default) get this auto-injected by the
 * proxy; others can pull it themselves:
 *
 *   <link rel="stylesheet" href="/api/os/theme.css">
 *
 * The user picks one light theme and one dark theme; `colorMode` (light/dark/
 * auto) decides which is active. The emitted CSS always exposes both palettes
 * (`--aura-light-color-*` and `--aura-dark-color-*`) plus the active one as
 * `--aura-color-*`. For `colorMode='auto'`, a `@media (prefers-color-scheme: light)`
 * block flips the active palette without JS.
 */
export const GET: APIRoute = async () => {
  const sel = await readSelection().catch(() => ({
    themeIdDark:  ThemeManager.DEFAULT_THEME_ID_DARK,
    themeIdLight: ThemeManager.DEFAULT_THEME_ID_LIGHT,
    colorMode:    ThemeManager.DEFAULT_COLOR_MODE,
  }));
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
  const mgr = getAppManager();
  const settings = mgr.getInstancesByApp('com.aura.settings')[0];
  if (!settings?.port) {
    return {
      themeIdDark:  ThemeManager.DEFAULT_THEME_ID_DARK,
      themeIdLight: ThemeManager.DEFAULT_THEME_ID_LIGHT,
      colorMode:    ThemeManager.DEFAULT_COLOR_MODE,
    };
  }
  const res = await fetch(`http://localhost:${settings.port}/api/data/theme`, {
    signal: AbortSignal.timeout(500),
  });
  if (!res.ok) {
    return {
      themeIdDark:  ThemeManager.DEFAULT_THEME_ID_DARK,
      themeIdLight: ThemeManager.DEFAULT_THEME_ID_LIGHT,
      colorMode:    ThemeManager.DEFAULT_COLOR_MODE,
    };
  }
  const body = await res.json() as { themeIdDark?: string; themeIdLight?: string; colorMode?: ColorMode };
  return {
    themeIdDark:  body.themeIdDark  ?? ThemeManager.DEFAULT_THEME_ID_DARK,
    themeIdLight: body.themeIdLight ?? ThemeManager.DEFAULT_THEME_ID_LIGHT,
    colorMode:    body.colorMode    ?? ThemeManager.DEFAULT_COLOR_MODE,
  };
}
