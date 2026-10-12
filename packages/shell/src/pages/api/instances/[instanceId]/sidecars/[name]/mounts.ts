import type { APIRoute } from 'astro';
import { errorResponse, jsonResponse } from '../../../../../../lib/appResponse.js';
import { jsonBody, sidecarError, sidecarGate } from '../../../../../../lib/instanceAuth.js';

/**
 * Cross-app mounts of one OS-managed sidecar — the app manages them itself,
 * at runtime, through the SDK (`osSidecars().mounts(name)`).
 *
 *   GET  (token, sidecars.spawn)                  → { capable, reason?, mounts: AuraMount[] }
 *        own mounts plus those inherited from the app (`origin: 'inherited'`)
 *   POST {targetAppId, mode?: 'ro'|'rw', data?}   → { ok, mount }
 *        (token, sidecars.mounts + apps.mount: a sidecar never sees an app its
 *        app couldn't mount itself)
 *
 * The sidecar must have been spawned with `mounts.own` (or inherit), so it has
 * its own mount root — 409 otherwise.
 */
export const GET: APIRoute = async ({ params, request }) => {
  const gate = sidecarGate(params, request, ['sidecars.spawn']);
  if (gate instanceof Response) return gate;
  const name = params['name'];
  if (!name) return errorResponse('Missing sidecar name', 400);
  try {
    const sc = await gate.mgr.osSidecars.get(gate.instance.instanceId, name);
    if (!sc) return errorResponse(`no OS sidecar '${name}' in ${gate.instance.instanceId}`, 404);
    const cap = gate.mgr.mounts.capable();
    return jsonResponse({ capable: cap.ok, reason: cap.reason, mounts: gate.mgr.mounts.list(`${gate.instance.instanceId}--${name}`) });
  } catch (err) {
    return sidecarError(err);
  }
};

export const POST: APIRoute = async ({ params, request }) => {
  const gate = sidecarGate(params, request, ['sidecars.mounts', 'apps.mount']);
  if (gate instanceof Response) return gate;
  const name = params['name'];
  if (!name) return errorResponse('Missing sidecar name', 400);
  const body = await jsonBody<{ targetAppId?: string; mode?: string; data?: boolean }>(request);
  if (body instanceof Response) return body;
  if (!body.targetAppId) return errorResponse('targetAppId is required', 400);
  if (!gate.mgr.getManifest(body.targetAppId)) return errorResponse(`App not found: ${body.targetAppId}`, 400);
  if (body.mode && body.mode !== 'ro' && body.mode !== 'rw') return errorResponse(`mode must be 'ro' or 'rw'`, 400);
  try {
    const sc = await gate.mgr.osSidecars.get(gate.instance.instanceId, name);
    if (!sc) return errorResponse(`no OS sidecar '${name}' in ${gate.instance.instanceId}`, 404);
    if (!sc.mounts.own) {
      return errorResponse(`${sc.containerName} was spawned without mounts.own — respawn it with { mounts: { own: true } } to give it mounts of its own`, 409);
    }
    const mount = await gate.mgr.mounts.add(`${gate.instance.instanceId}--${name}`, {
      targetAppId: body.targetAppId,
      mode: body.mode === 'rw' ? 'rw' : 'ro',
      data: body.data === true,
    });
    return jsonResponse({ ok: true, mount });
  } catch (err) {
    return sidecarError(err);
  }
};
