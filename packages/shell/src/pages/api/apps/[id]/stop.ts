import type { APIRoute } from 'astro';
import { getAppManager } from '@aura/core';
import { buildAppDTO, jsonResponse, errorResponse } from '../../../../lib/appResponse.js';

/** Stops ALL instances of the app. Use /api/instances/[instanceId]/stop for a single instance. */
export const POST: APIRoute = async ({ params }) => {
  const appId = params['id'];
  if (!appId) return errorResponse('Missing app id', 400);
  try {
    await getAppManager().stopAll(appId);
    return jsonResponse(await buildAppDTO(appId));
  } catch (err) {
    return errorResponse(String(err), 500);
  }
};
