import type { APIRoute } from 'astro';
import { auditOwner, ownerAction } from '../../../lib/approvals/admin.ts';
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
 * Dockerfile — and asks the next boot to build the changed packages. A plain
 * restart builds nothing (os/boot.sh builds only on a build request, or when
 * a package has no build output yet); after a code change use `aura dev
 * rebuild` (Developer Mode) or `mode: 'rebuild'`.
 *
 * The owner's (lib/approvals/admin.ts): the owner in the desktop and the host
 * operator act directly; Settings and the CLI in the System Terminal ask for
 * one click.
 *
 * 202 when the restart is under way: this server stops answering shortly
 * after and comes back on its own.
 */
export const POST: APIRoute = async (ctx) => {
  let body: { restore?: unknown; mode?: unknown } = {};
  try { body = await ctx.request.json() as typeof body; } catch { /* empty body: defaults */ }
  if (body.mode !== undefined && body.mode !== 'restart' && body.mode !== 'rebuild') {
    return new Response(JSON.stringify({ ok: false, error: `mode must be 'restart' or 'rebuild'` }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
  const mode = body.mode === 'rebuild' ? 'rebuild' : 'restart';
  const restore = body.restore !== false;
  const actor = await ownerAction(ctx, {
    action: 'admin.change', level: 'session', payload: { op: 'os.restart', mode, restore },
    title: mode === 'rebuild' ? 'Rebuild the AuraOS image and restart' : 'Restart AuraOS',
    details: [restore ? 'Your desktop is saved and comes back after the restart.' : 'AuraOS comes back with an empty desktop.'],
  });
  if (actor instanceof Response) return actor;
  const res = await plannedRestart({ mode, restore });
  await auditOwner(actor, 'os.restart', { outcome: res.ok ? 'ok' : 'failed', detail: { mode, restore } });
  const status = res.ok ? 202 : 409;
  return new Response(JSON.stringify(res), { status, headers: { 'Content-Type': 'application/json' } });
};
