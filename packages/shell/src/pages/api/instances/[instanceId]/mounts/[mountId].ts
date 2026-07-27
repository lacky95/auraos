import type { APIRoute } from 'astro';
import { getAppManager } from '@aura/core';
import { jsonResponse, errorResponse } from '../../../../../lib/appResponse.js';

/**
 * Detach one cross-app mount.
 *
 * `mountId` is `<targetAppId>` for a source mount and `<targetAppId>:data` for
 * a data mount, so it must arrive URL-encoded (the colon is legal in a path
 * segment, but callers should encode anyway).
 */
export const DELETE: APIRoute = async ({ params }) => {
  const instanceId = params['instanceId'];
  const mountId    = params['mountId'];
  if (!instanceId) return errorResponse('Missing instance id', 400);
  if (!mountId)    return errorResponse('Missing mount id', 400);

  const mgr = getAppManager();
  const instance = mgr.getInstance(instanceId);
  if (!instance) return errorResponse(`Instance not found: ${instanceId}`, 404);

  // Same `apps.mount` gate as POST. Detaching only ever REMOVES access, so this
  // isn't about privilege escalation — it's that an ungated DELETE lets any
  // caller rip mounts out from under an app that legitimately has them, which
  // is a disruption vector and an inconsistent boundary. Consumer id comes from
  // the instance record, never the request.
  if (!mgr.permissions.hasPermission(instance.appId, 'apps.mount')) {
    return errorResponse(
      `${instance.appId} is not granted 'apps.mount'. Add it to the app's manifest permissions[] to manage cross-app mounts.`,
      403,
    );
  }

  try {
    await mgr.mounts.remove(instanceId, decodeURIComponent(mountId));
    return jsonResponse({ ok: true, removed: mountId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorResponse(message, /not mounted/i.test(message) ? 404 : 500);
  }
};
