import type { APIRoute } from 'astro';
import { errorResponse, jsonResponse } from '../../../../../lib/appResponse.js';
import { sidecarError, sidecarGate } from '../../../../../lib/instanceAuth.js';

/**
 * One OS-managed sidecar.
 *
 *   GET    (token, sidecars.spawn) → { sidecar: OsSidecar }
 *   DELETE (token, sidecars.spawn) → { ok }   — also removes sidecars it spawned
 *
 * App-managed sidecars (the app's own `docker run`) are not reachable here:
 * the app owns them. A sidecar calling with its own token reaches only the
 * sidecars it spawned, unless the app holds `sidecars.manageAll`.
 */
export const GET: APIRoute = async ({ params, request }) => {
  const gate = sidecarGate(params, request, ['sidecars.spawn']);
  if (gate instanceof Response) return gate;
  const name = params['name'];
  if (!name) return errorResponse('Missing sidecar name', 400);
  try {
    await gate.mgr.osSidecars.authorize(gate.instance.instanceId, name, gate.caller);
    const sidecar = await gate.mgr.osSidecars.get(gate.instance.instanceId, name);
    if (!sidecar) return errorResponse(`no OS sidecar '${name}' in ${gate.instance.instanceId}`, 404);
    return jsonResponse({ sidecar });
  } catch (err) {
    return sidecarError(err);
  }
};

export const DELETE: APIRoute = async ({ params, request }) => {
  const gate = sidecarGate(params, request, ['sidecars.spawn']);
  if (gate instanceof Response) return gate;
  const name = params['name'];
  if (!name) return errorResponse('Missing sidecar name', 400);
  try {
    await gate.mgr.osSidecars.authorize(gate.instance.instanceId, name, gate.caller);
    await gate.mgr.osSidecars.remove(gate.instance.instanceId, name);
    return jsonResponse({ ok: true, removed: name });
  } catch (err) {
    return sidecarError(err);
  }
};
