import type { APIRoute } from 'astro';
import { plannedRestart } from '../../../lib/plannedRestart.js';

/**
 * POST /api/admin/restart { restore?: boolean = true }
 *
 * Planned OS restart: saves the desktop (activities, their app state,
 * workspaces, layouts), restarts the master container and the Aura Shell
 * Daemon, and brings it back on boot — unless `restore: false`. Entry points: `aura restart
 * os [--no-restore]`, the About dialog, Settings → About (lib/plannedRestart.ts).
 *
 * 202 when the restart is under way: this server stops answering shortly
 * after and comes back on its own.
 */
export const POST: APIRoute = async ({ request }) => {
  let body: { restore?: unknown } = {};
  try { body = await request.json() as typeof body; } catch { /* empty body: defaults */ }
  const res = await plannedRestart({ mode: 'restart', restore: body.restore !== false });
  const status = res.ok ? 202 : 409;
  return new Response(JSON.stringify(res), { status, headers: { 'Content-Type': 'application/json' } });
};
