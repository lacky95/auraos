import type { APIRoute } from 'astro';
import { getAppManager } from '@aura/core';
import { jsonResponse, publicInstance, errorResponse } from '../../../../lib/appResponse.js';
import { actingUser } from '../../../../lib/access/decide.ts';
import { SESSION_HOST_APPS } from '../../../../lib/access/identify.ts';
import { requestUserId } from '../../../../lib/userContext.ts';

/**
 * List running instances for an app (no health probe — fast). A session host
 * (the System Terminal, D69): only the caller's own user's instances, so one
 * user's Terminal (its session router, `list_sessions`) never sees another's.
 */
export const GET: APIRoute = async ({ params, request, locals }) => {
  const appId = params['id'];
  if (!appId) return errorResponse('Missing app id', 400);
  const mgr = getAppManager();
  if (!mgr.getManifest(appId)) return errorResponse(`App not found: ${appId}`, 404);
  let instances = mgr.getInstancesByApp(appId);
  if (SESSION_HOST_APPS.has(appId)) {
    const user = locals?.access?.principal ? actingUser(locals.access.principal) : await requestUserId(request);
    instances = instances.filter((inst) => !inst.inPool && !!user && inst.owner === user);
  }
  return jsonResponse(instances.map((inst) => publicInstance(inst)));
};
