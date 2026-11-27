import type { APIRoute } from 'astro';
import { getAppManager } from '@aura/core';
import { buildInstanceDTO, jsonResponse, errorResponse, failureResponse } from '../../../../lib/appResponse.js';

/**
 * Stop an instance (`onStop` reason `user`). `?ifIdle=1` stops it only while
 * it has no activity: the desktop's "Stop" after the last window closed
 * (D101) must not take down a window the user opened meanwhile (409 `not-idle`).
 */
export const POST: APIRoute = async ({ params, url, request, locals }) => {
  const instanceId = params['instanceId'];
  if (!instanceId) return errorResponse('Missing instance id', 400);
  try {
    const mgr = getAppManager();
    if (url.searchParams.get('ifIdle') === '1' && mgr.getActivitiesByInstance(instanceId).length > 0) {
      return jsonResponse({ error: 'not-idle', instanceId }, 409);
    }
    await mgr.stop(instanceId);
    return jsonResponse({ stopped: instanceId, ...(await buildInstanceDTO(instanceId)) });
  } catch (err) {
    return failureResponse({ request, locals }, err);
  }
};
