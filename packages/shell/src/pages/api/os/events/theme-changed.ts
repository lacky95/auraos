import type { APIRoute } from 'astro';
import { OsEventBus, ThemeManager } from '@aura/core';

/**
 * Bridge endpoint: apps POST here to broadcast a theme change on the OS event bus.
 * Settings uses this after writing a new themeId to its data file so the shell
 * and all listening iframes can update live.
 *
 * Body: `{ themeId: string }`
 *
 * Permission gating: in MVP we accept any caller. A future version should require
 * `system.theme.broadcast` and check `Referer` like the data proxy.
 */
export const POST: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => ({})) as { themeId?: string };
  const themeId = typeof body.themeId === 'string' ? body.themeId : '';
  const theme   = ThemeManager.getTheme(themeId);
  if (!theme) {
    return new Response(JSON.stringify({ error: `Unknown themeId '${themeId}'` }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  OsEventBus.emit('theme:changed', { themeId: theme.id, themeName: theme.name });
  return new Response(JSON.stringify({ ok: true, themeId: theme.id, themeName: theme.name }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
