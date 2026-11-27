import type { APIRoute } from 'astro';
import { getAppManager } from '@aura/core';
import { buildAppDTO, jsonResponse, errorResponse, failureResponse } from '../../../../lib/appResponse.js';

/** Stops ALL instances of the app. Use /api/instances/[instanceId]/stop for a single instance. */
export const POST: APIRoute = async ({ params, request, locals }) => {
  const appId = params['id'];
  if (!appId) return errorResponse('Missing app id', 400);
  try {
    await getAppManager().stopAll(appId);
    return jsonResponse(await buildAppDTO(appId));
  } catch (err) {
    return failureResponse({ request, locals }, err);
  }
};
