import type { APIRoute } from 'astro';
import { getAppManager } from '@aura/core';
import { errorResponse, jsonResponse } from '../../../../lib/appResponse.js';

/**
 * Where an instance runs, from the kernel (5b, D100 §7): its runtime, the
 * source of that choice and the runtime's features. `aura info` asks this
 * instead of guessing from `/proc`, `/.dockerenv` or the cgroup. The owner or
 * the instance itself (the route manifest).
 */
export const GET: APIRoute = ({ params }) => {
  const instanceId = params['instanceId'];
  if (!instanceId) return errorResponse('Missing instance id', 400);
  const view = getAppManager().runtimeViewOf(instanceId);
  if (!view) return errorResponse(`Instance not found: ${instanceId}`, 404);
  return jsonResponse({ instanceId, ...view });
};
