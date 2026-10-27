import type { APIRoute } from 'astro';
import { getAppManager } from '@aura/core';
import { jsonResponse, errorResponse } from '../../../../lib/appResponse.js';
import { restartWithActivities } from '../../../../lib/appRestart.js';

/**
 * Restart ALL instances of the app into one fresh instance and restore their
 * windows (path, workspace, slot, stack rect) on it. See lib/appRestart.ts.
 */
export const POST: APIRoute = async ({ params }) => {
  const appId = params['id'];
  if (!appId) return errorResponse('Missing app id', 400);
  if (!getAppManager().getManifest(appId)) return errorResponse(`App not found: ${appId}`, 404);
  try {
    return jsonResponse(await restartWithActivities(appId));
  } catch (err) {
    return errorResponse(String(err), 500);
  }
};
