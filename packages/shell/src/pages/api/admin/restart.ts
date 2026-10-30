import type { APIRoute } from 'astro';
import { plannedRestart } from '../../../lib/plannedRestart.js';

/**
 * POST /api/admin/restart { restore?: boolean = true, mode?: 'restart' | 'rebuild' = 'restart' }
 *
 * Planned OS restart: saves the desktop (activities, their app state,
 * workspaces, layouts), restarts the master container and the Aura Shell
 * Daemon, and brings it back on boot — unless `restore: false`. Entry points: `aura restart
 * os [--no-restore] [--rebuild]`, the About dialog, Settings → About
 * (lib/plannedRestart.ts). `mode: 'rebuild'` rebuilds the AuraOS image from
 * the current checkout first (SelfUpdater) — e.g. after changing the
 * Dockerfile. A plain restart already rebuilds every package on boot
 * (os/boot.sh), which is all a production-mode shell needs after a code
 * change.
 *
 * 202 when the restart is under way: this server stops answering shortly
 * after and comes back on its own.
 */
export const POST: APIRoute = async ({ request }) => {
  let body: { restore?: unknown; mode?: unknown } = {};
  try { body = await request.json() as typeof body; } catch { /* empty body: defaults */ }
  if (body.mode !== undefined && body.mode !== 'restart' && body.mode !== 'rebuild') {
    return new Response(JSON.stringify({ ok: false, error: `mode must be 'restart' or 'rebuild'` }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
  const res = await plannedRestart({ mode: body.mode === 'rebuild' ? 'rebuild' : 'restart', restore: body.restore !== false });
  const status = res.ok ? 202 : 409;
  return new Response(JSON.stringify(res), { status, headers: { 'Content-Type': 'application/json' } });
};
