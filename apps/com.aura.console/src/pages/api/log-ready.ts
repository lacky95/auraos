import type { APIRoute } from 'astro';
import { getLogFilePath, getLogWss } from '../../log-server';

/**
 * GET /api/log-ready: the production server's way into the bundle (the
 * Terminal's /api/pty-ready pattern). server.mjs is not part of the build; it
 * calls this once after listening. It leaves a handle on globalThis, so
 * server.mjs's `/ws` upgrades reach the same log-server module instance as
 * the API routes and the MCP tool (what astro.config.mjs's dev hook does).
 */
(globalThis as Record<symbol, unknown>)[Symbol.for('aura.console.getLogWss')] = getLogWss;

export const GET: APIRoute = () => {
  getLogWss();
  return new Response(JSON.stringify({ ok: true, file: getLogFilePath() }), { headers: { 'Content-Type': 'application/json' } });
};
