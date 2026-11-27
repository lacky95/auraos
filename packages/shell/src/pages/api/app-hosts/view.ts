import type { APIRoute } from 'astro';
import { liveAppViewDeps, requestAppView } from '../../../lib/appView.ts';
import { json } from '../../../lib/approvals/service.ts';

/**
 * POST /api/app-hosts/view — `apps.view` (D104): a one-time handoff that lets
 * the calling app's SERVER read another app's App Host for the user, after
 * the owner granted it. lib/appView.ts.
 */
export const POST: APIRoute = async (ctx) => {
  let peer: string | undefined;
  try { peer = ctx.clientAddress; } catch { peer = undefined; }
  try {
    return await requestAppView(ctx.request, await liveAppViewDeps(), peer);
  } catch (err) {
    console.warn(`[app-hosts] view handoff failed: ${(err as Error)?.name ?? 'error'}`);
    return json({ error: 'unavailable', message: 'AuraOS could not check this request; try again.' }, 503);
  }
};
