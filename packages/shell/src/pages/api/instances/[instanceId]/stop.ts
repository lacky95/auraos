import type { APIRoute } from 'astro';
import { getAppManager } from '@aura/core';
import { buildInstanceDTO, jsonResponse, errorResponse } from '../../../../lib/appResponse.js';

export const POST: APIRoute = async ({ params }) => {
  const instanceId = params['instanceId'];
  if (!instanceId) return errorResponse('Missing instance id', 400);
  try {
    await getAppManager().stop(instanceId);
    return jsonResponse({ stopped: instanceId, ...(await buildInstanceDTO(instanceId)) });
  } catch (err) {
    return errorResponse(String(err), 500);
  }
};
