import type { APIRoute } from 'astro';
import { errorResponse, jsonResponse } from '../../../../../../../lib/appResponse.js';
import { sidecarError, sidecarGate } from '../../../../../../../lib/instanceAuth.js';

/**
 * Detach one of an OS sidecar's OWN mounts (`<targetAppId>` or
 * `<targetAppId>:data`, URL-encoded). Inherited mounts answer 409: they follow
 * the app's set — detach them there, or respawn with mounts.inherit.exclude.
 *
 *   DELETE (token, sidecars.mounts + apps.mount) → { ok, removed }
 */
export const DELETE: APIRoute = async ({ params, request }) => {
  const gate = sidecarGate(params, request, ['sidecars.mounts', 'apps.mount']);
  if (gate instanceof Response) return gate;
  const name = params['name'];
  const mountId = params['mountId'];
  if (!name) return errorResponse('Missing sidecar name', 400);
  if (!mountId) return errorResponse('Missing mount id', 400);
  try {
    await gate.mgr.mounts.remove(`${gate.instance.instanceId}--${name}`, decodeURIComponent(mountId));
    return jsonResponse({ ok: true, removed: mountId });
  } catch (err) {
    return sidecarError(err);
  }
};
