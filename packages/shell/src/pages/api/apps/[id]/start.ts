import type { APIRoute } from 'astro';
import { getAppManager, operationalBlockOf } from '@aura/core';
import { buildInstanceDTO, jsonResponse, errorResponse, failureResponse } from '../../../../lib/appResponse.js';
import { bumpMru } from '../../../../lib/appMru.js';
import { requestUserId } from '../../../../lib/userContext.js';

export const POST: APIRoute = async ({ params, request, locals }) => {
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
    if (blocked) return errorResponse(409, blocked);
    // D105 Pass B (review rows 24, 32): a coded refusal (409 app-disabled) as is; anything else without the
    // `Error: [ProotRunner]` noise, redacted unless the owner reads it, with where to look.
    return failureResponse({ request, locals }, err, {
      hint: `aura get inst ${appId} shows its instances; aura logs inst <instance id> shows why it failed.`,
    });
  }
};
