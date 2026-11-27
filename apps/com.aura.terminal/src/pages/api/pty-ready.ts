import type { APIRoute } from 'astro';
import { getPtyWss } from '../../pty-server';
import { userFiles } from '../../user-files';

/**
 * GET /api/pty-ready — the production server's way into the bundle.
 * server.mjs is not part of the build; it calls this once after listening.
 * This loads the PTY WebSocket server, arms it (keepalive sweep, cwd
 * recorder — what astro.config.mjs's dev hook does at startup) and leaves a
 * handle on globalThis, so server.mjs's `/ws` upgrades reach the same module
 * instance as the API routes.
 */
(globalThis as Record<symbol, unknown>)[Symbol.for('aura.terminal.getPtyWss')] = getPtyWss;

export const GET: APIRoute = () => {
  getPtyWss();
  // Once at boot: an older hook script in the shared home is brought up to date (D89).
  // As the session user (user-files.ts, stream T2); in the background, never holding up the PTY.
  userFiles<boolean>('hooks-refresh').then(
    (done) => { if (done) console.log('[terminal] agent hook script updated'); },
    (err: unknown) => console.warn('[terminal] agent hook script refresh failed:', (err as Error).message),
  );
  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
};
