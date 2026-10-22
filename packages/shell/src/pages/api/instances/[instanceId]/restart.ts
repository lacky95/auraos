import type { APIRoute } from 'astro';
import { getAppManager } from '@aura/core';
import { jsonResponse, errorResponse } from '../../../../lib/appResponse.js';
import { restartWithActivities } from '../../../../lib/appRestart.js';

/**
 * Restart one instance: stop it, start a fresh instance of its app and
 * restore the instance's windows on it. A multi-instance app gets a new id.
 */
export const POST: APIRoute = async ({ params }) => {
  const instanceId = params['instanceId'];
  if (!instanceId) return errorResponse('Missing instance id', 400);
  const inst = getAppManager().getInstance(instanceId);
  if (!inst) return errorResponse(`Instance not found: ${instanceId}`, 404);
  try {
    return jsonResponse(await restartWithActivities(inst.appId, [instanceId]));
  } catch (err) {
    return errorResponse(String(err), 500);
  }
};
