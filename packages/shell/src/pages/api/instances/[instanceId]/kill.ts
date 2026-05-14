import type { APIRoute } from 'astro';
import { getAppManager } from '@aura/core';
import { jsonResponse, errorResponse } from '../../../../lib/appResponse.js';

/** Force-kill an instance (SIGKILL, no lifecycle hooks). */
export const POST: APIRoute = ({ params }) => {
  const instanceId = params['instanceId'];
  if (!instanceId) return errorResponse('Missing instance id', 400);
  try {
    getAppManager().forceKill(instanceId);
    return jsonResponse({ killed: instanceId });
  } catch (err) {
    return errorResponse(String(err), 500);
  }
};
