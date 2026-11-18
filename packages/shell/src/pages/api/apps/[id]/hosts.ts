import type { APIRoute } from 'astro';
import { getAppManager } from '@aura/core';
import { errorResponse, jsonResponse } from '../../../../lib/appResponse.js';
import { listAppHosts } from '../../../../lib/appHosts.js';

/** GET /api/apps/<id>/hosts → { hosts }: this app's hosts, URLs built from the caller's host. */
export const GET: APIRoute = ({ params, request }) => {
  const appId = params['id'];
  if (!appId) return errorResponse('Missing app id', 400);
  if (!getAppManager().getManifest(appId)) return errorResponse(`App not found: ${appId}`, 404);
  return jsonResponse({ hosts: listAppHosts(request, appId) });
};
