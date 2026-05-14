import type { APIRoute } from 'astro';
import { getAppManager } from '@aura/core';
import { jsonResponse, errorResponse } from '../../../../lib/appResponse.js';

/** Open a new activity on an existing instance. Optional `data` is passed to the app's onActivityCreate hook. */
export const POST: APIRoute = async ({ params, request }) => {
  const instanceId = params['instanceId'];
  if (!instanceId) return errorResponse('Missing instance id', 400);
  const data = await request.json().catch(() => undefined) as Record<string, unknown> | undefined;
  try {
    const activity = await getAppManager().openActivity(instanceId, data);
    return jsonResponse({ activityId: activity.activityId, activity });
  } catch (err) {
    return errorResponse(String(err), 500);
  }
};

/** List activities of an instance. */
export const GET: APIRoute = ({ params }) => {
  const instanceId = params['instanceId'];
  if (!instanceId) return errorResponse('Missing instance id', 400);
  return jsonResponse(getAppManager().getActivitiesByInstance(instanceId));
};
