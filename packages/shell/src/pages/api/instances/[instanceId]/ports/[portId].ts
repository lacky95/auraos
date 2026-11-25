import type { APIRoute } from 'astro';
import { getAppManager } from '@aura/core';
import { jsonResponse, errorResponse } from '../../../../../lib/appResponse.js';

/**
 * Remove one port expose. `portId` is `into-<port>` or `host-<addr>-<port>`.
 * Same `apps.port` rule as POST (routeManifest.ts), on the instance's app.
 */
export const DELETE: APIRoute = ({ params }) => {
  const instanceId = params['instanceId'];
  const portId     = params['portId'];
  if (!instanceId) return errorResponse('Missing instance id', 400);
  if (!portId)     return errorResponse('Missing port id', 400);

  const mgr = getAppManager();
  const instance = mgr.getInstance(instanceId);
  if (!instance) return errorResponse(`Instance not found: ${instanceId}`, 404);

  try {
    mgr.portExpose.remove(instanceId, decodeURIComponent(portId));
    return jsonResponse({ ok: true, removed: portId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse(message, /not exposed/i.test(message) ? 404 : 500);
  }
};
