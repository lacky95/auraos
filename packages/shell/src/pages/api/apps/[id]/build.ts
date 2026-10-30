import type { APIRoute } from 'astro';
import { getAppManager } from '@aura/core';
import { jsonResponse, errorResponse } from '../../../../lib/appResponse.js';
import { buildApps } from '../../../../lib/appBuilds.js';

/**
 * POST /api/apps/<id>/build { force?, restart? } — `astro build` the app (in
 * a throwaway container) so it starts from its build; with `restart`, switch
 * its running instances now (windows come back). See lib/appBuilds.ts.
 * Answers when the build is done (can take a minute).
 */
export const POST: APIRoute = async ({ params, request }) => {
  const appId = params['id'];
  if (!appId) return errorResponse('Missing app id', 400);
  if (!getAppManager().getManifest(appId)) return errorResponse(`App not found: ${appId}`, 404);
  let body: { force?: unknown; restart?: unknown } = {};
  try { body = await request.json() as typeof body; } catch { /* empty body: defaults */ }
  try {
    const [res] = await buildApps([appId], { force: body.force === true, restart: body.restart === true });
    return jsonResponse(res, res?.ok ? 200 : 500);
  } catch (err) {
    return errorResponse(String(err), 500);
  }
};
