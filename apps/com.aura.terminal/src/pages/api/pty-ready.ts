import type { APIRoute } from 'astro';
import { getPtyWss } from '../../pty-server';

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
  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
};
