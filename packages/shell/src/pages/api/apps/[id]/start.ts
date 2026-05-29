import type { APIRoute } from 'astro';
import { getAppManager } from '@aura/core';
import { buildInstanceDTO, jsonResponse, errorResponse } from '../../../../lib/appResponse.js';
import { bumpMru } from '../../../../lib/appMru.js';

export const POST: APIRoute = async ({ params }) => {
  const appId = params['id'];
  if (!appId) return errorResponse('Missing app id', 400);

  const mgr = getAppManager();
  if (!mgr.getManifest(appId)) return errorResponse(`App not found: ${appId}`, 404);

  try {
    const instanceId = await mgr.start(appId);
    const dto = await buildInstanceDTO(instanceId);
    // Record AFTER start succeeds so a failed launch doesn't pollute the
    // dock with a missed app. Fire-and-forget — don't block the response
    // on the KV round-trip.
    void bumpMru(appId);
    return jsonResponse({ instanceId, appId, ...dto });
  } catch (err) {
    return errorResponse(String(err), 500);
  }
};
