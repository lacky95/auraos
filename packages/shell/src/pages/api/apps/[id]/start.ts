import type { APIRoute } from 'astro';
import { getAppManager, operationalBlockOf } from '@aura/core';
import { buildInstanceDTO, jsonResponse, errorResponse } from '../../../../lib/appResponse.js';
import { bumpMru } from '../../../../lib/appMru.js';
import { requestUserId } from '../../../../lib/userContext.js';

export const POST: APIRoute = async ({ params, request }) => {
  const appId = params['id'];
  if (!appId) return errorResponse('Missing app id', 400);

  const mgr = getAppManager();
  if (!mgr.getManifest(appId)) return errorResponse(`App not found: ${appId}`, 404);

  try {
    // For the verified caller's user (D46): a new instance or a claimed pool member is theirs.
    const userId = (await requestUserId(request)) ?? undefined;
    const instanceId = await mgr.start(appId, userId ? { userId } : {});
    const dto = await buildInstanceDTO(instanceId);
    // Record AFTER start succeeds so a failed launch doesn't pollute the
    // dock with a missed app. Fire-and-forget — don't block the response
    // on the KV round-trip.
    void bumpMru(appId, userId);
    return jsonResponse({ instanceId, appId, ...dto });
  } catch (err) {
    // The start gate (D48, D108): the app is listed but never started, with its D105 body.
    const blocked = operationalBlockOf(err);
    if (blocked) return jsonResponse(blocked, 409);
    return errorResponse(String(err), 500);
  }
};
