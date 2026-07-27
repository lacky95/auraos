import type { APIRoute } from 'astro';
import { getAppManager } from '@aura/core';
import { jsonResponse, errorResponse } from '../../../../lib/appResponse.js';

/**
 * Cross-app mounts for one instance.
 *
 *   GET  → { capable, reason?, mounts[] }
 *   POST → { targetAppId, mode?: 'ro'|'rw', data?: boolean } → { ok, mount }
 *
 * `capable` reports whether this host can propagate mounts at all, so a client
 * can explain WHY mounting is unavailable instead of just failing.
 */
export const GET: APIRoute = ({ params }) => {
  const instanceId = params['instanceId'];
  if (!instanceId) return errorResponse('Missing instance id', 400);

  const mgr = getAppManager();
  if (!mgr.getInstance(instanceId)) return errorResponse(`Instance not found: ${instanceId}`, 404);

  const cap = mgr.mounts.capable();
  return jsonResponse({ capable: cap.ok, reason: cap.reason, mounts: mgr.mounts.list(instanceId) });
};

export const POST: APIRoute = async ({ params, request }) => {
  const instanceId = params['instanceId'];
  if (!instanceId) return errorResponse('Missing instance id', 400);

  const mgr = getAppManager();
  const instance = mgr.getInstance(instanceId);
  if (!instance) return errorResponse(`Instance not found: ${instanceId}`, 404);

  // ---- Permission gate: the CONSUMER app must declare `apps.mount` ----
  // The consumer id comes from the instance record, never from the request
  // body — the body is fully attacker-controlled, the instance record is not.
  //
  // Honest about the limit: this OS has no request authentication
  // (AURA_AUTH_MODE: none), so nothing stops a caller from putting SOME OTHER
  // instance's id in the URL and borrowing that app's grant. Deriving the
  // appId server-side is defence-in-depth — it stops a mount request from
  // simply declaring who it is — not a hard security boundary. A real
  // boundary needs authenticated callers.
  const consumerAppId = instance.appId;
  if (!mgr.permissions.hasPermission(consumerAppId, 'apps.mount')) {
    return errorResponse(
      `${consumerAppId} is not granted 'apps.mount'. Add it to the app's manifest permissions[] to allow cross-app mounting.`,
      403,
    );
  }

  let body: { targetAppId?: string; mode?: string; data?: boolean };
  try { body = await request.json(); }
  catch { return errorResponse('Body must be JSON', 400); }

  const targetAppId = body.targetAppId;
  if (!targetAppId) return errorResponse('targetAppId is required', 400);
  if (!mgr.getManifest(targetAppId)) return errorResponse(`App not found: ${targetAppId}`, 400);
  if (body.mode && body.mode !== 'ro' && body.mode !== 'rw') {
    return errorResponse(`mode must be 'ro' or 'rw'`, 400);
  }

  // Container-only: a PRoot instance has no /data volume mount to receive
  // propagation. Say so rather than mounting into a path nobody can see.
  if (instance.sandbox && instance.sandbox !== 'container') {
    return errorResponse(
      `${instanceId} runs in a '${instance.sandbox}' sandbox; cross-app mounting requires sandbox: container`,
      409,
    );
  }

  try {
    const mount = await mgr.mounts.add(instanceId, {
      targetAppId,
      mode: body.mode === 'rw' ? 'rw' : 'ro',
      data: body.data === true,
    });
    return jsonResponse({ ok: true, mount });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // "already mounted" / "unavailable" are conflicts, not server faults.
    const conflict = /already mounted|unavailable|refusing/i.test(message);
    return errorResponse(message, conflict ? 409 : 500);
  }
};
