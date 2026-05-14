import type { APIRoute } from 'astro';
import { getAppManager, ThemeManager } from '@aura/core';

/**
 * Returns the currently active OS theme as a CSS file.
 *
 *   <link rel="stylesheet" href="/api/os/theme.css">
 *
 * Resolves the active themeId via the Settings content provider when available;
 * falls back to the default theme when Settings is not running.
 */
export const GET: APIRoute = async () => {
  const themeId = await readCurrentThemeId().catch(() => ThemeManager.DEFAULT_THEME_ID);
  const css = ThemeManager.toCssById(themeId);
  return new Response(css, {
    status: 200,
    headers: {
      'Content-Type':  'text/css; charset=utf-8',
      'Cache-Control': 'no-cache',
    },
  });
};

async function readCurrentThemeId(): Promise<string> {
  const mgr = getAppManager();
  const settings = mgr.getInstancesByApp('com.aura.settings')[0];
  if (!settings?.port) return ThemeManager.DEFAULT_THEME_ID;
  const res = await fetch(`http://localhost:${settings.port}/api/data/theme`, {
    signal: AbortSignal.timeout(500),
  });
  if (!res.ok) return ThemeManager.DEFAULT_THEME_ID;
  const body = await res.json() as { themeId?: string };
  return body.themeId ?? ThemeManager.DEFAULT_THEME_ID;
}
