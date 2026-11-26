import type { APIRoute } from 'astro';
import { getAppManager } from '@aura/core';
import { auditOwner, ownerAction } from '../../../lib/approvals/admin.ts';
import { capRefreshRequest } from '../../../lib/approvals/maintenance.ts';

/**
 * Hot-refresh the per-instance tool allowlist for every running instance of
 * `appId`. Called by `aura cap grant` / `aura cap revoke` so live apps pick
 * up the new symlink set in /aura/my-tools without a proot respawn (the bind
 * is at the directory level, so symlink mutations are immediately visible).
 *
 * Returns the list of refreshed instance IDs.
 *
 * The owner's (lib/approvals/maintenance.ts): the owner and the host operator
 * directly, the System Terminal with one click.
 */
export const POST: APIRoute = async (ctx) => {
  let body: unknown;
  try { body = await ctx.request.json(); } catch { body = {}; }
  const r = capRefreshRequest(body);
  if ('invalid' in r) return new Response(JSON.stringify({ error: r.invalid }), { status: 400 });
  const actor = await ownerAction(ctx, r.req);
  if (actor instanceof Response) return actor;
  const { appId } = r;

  try {
    const refreshed = getAppManager().refreshInstanceTools(appId);
    await auditOwner(actor, 'cap.refresh', { target: `app:${appId}`, outcome: 'ok', detail: { refreshed: refreshed.length } });
    return new Response(JSON.stringify({ ok: true, appId, refreshed }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500 });
  }
};
