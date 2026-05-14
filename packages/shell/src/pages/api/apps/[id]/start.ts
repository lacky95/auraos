import type { APIRoute } from 'astro';
import { getAppManager } from '@aura/core';
import { buildInstanceDTO, jsonResponse, errorResponse } from '../../../../lib/appResponse.js';

export const POST: APIRoute = async ({ params }) => {
  const appId = params['id'];
  if (!appId) return errorResponse('Missing app id', 400);

  const mgr = getAppManager();
  if (!mgr.getManifest(appId)) return errorResponse(`App not found: ${appId}`, 404);

  try {
    const instanceId = await mgr.start(appId);
    const dto = await buildInstanceDTO(instanceId);
    return jsonResponse({ instanceId, appId, ...dto });
  } catch (err) {
    return errorResponse(String(err), 500);
  }
};
