import type { APIRoute } from 'astro';
import { getAppManager } from '@aura/core';
import { jsonResponse, errorResponse } from '../../../../lib/appResponse.js';

/** List running instances for an app (no health probe — fast). */
export const GET: APIRoute = ({ params }) => {
  const appId = params['id'];
  if (!appId) return errorResponse('Missing app id', 400);
  const mgr = getAppManager();
  if (!mgr.getManifest(appId)) return errorResponse(`App not found: ${appId}`, 404);
  return jsonResponse(mgr.getInstancesByApp(appId));
};
