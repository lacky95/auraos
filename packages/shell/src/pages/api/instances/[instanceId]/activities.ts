import type { APIRoute } from 'astro';
import { getAppManager } from '@aura/core';
import { jsonResponse, errorResponse } from '../../../../lib/appResponse.js';

/** Open a new activity on an existing instance. Optional `data` is passed to the app's onActivityCreate hook. */
export const POST: APIRoute = async ({ params, request }) => {
  const instanceId = params['instanceId'];
  if (!instanceId) return errorResponse('Missing instance id', 400);
  // Body shape: `{ data?, stackParent? }`. Tolerate the legacy form where the
  // whole body IS the data bag — only treat top-level `data`/`stackParent`
  // keys specially when both shapes coexist, callers can be on either side
  // during the rollout.
  const body = await request.json().catch(() => undefined) as
    | (Record<string, unknown> & { data?: Record<string, unknown>; stackParent?: string })
    | undefined;
  const stackParent = typeof body?.stackParent === 'string' ? body.stackParent : undefined;
  const data = (body && typeof body.data === 'object' && body.data !== null)
    ? body.data
    : body; // legacy: whole body is the data bag
  try {
    const activity = await getAppManager().openActivity(
      instanceId,
      data,
      stackParent ? { stackParent } : undefined,
    );
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
