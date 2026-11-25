import type { APIRoute } from 'astro';
import { getAppManager } from '@aura/core';
import { jsonResponse, errorResponse } from '../../../lib/appResponse.js';
import { actingInstance } from '../../../lib/access/identify.js';

/**
 * DELETE /api/interfaces/<name> — drop a runtime registration.
 *
 * Best-effort: the OS drops every one of an instance's entries when it stops,
 * so an app that never calls this cannot leak. Manifest-declared interfaces
 * are not removable — they are the app's contract, not a runtime detail.
 *
 * There is no appId in the path on purpose: the caller's identity supplies it,
 * so the ordinary way of touching another app's entry does not exist. The
 * identity is verified: an instance token or a gateway claim, never a hint.
 */
export const DELETE: APIRoute = ({ params, locals }) => {
  const mgr = getAppManager();
  const name = params['name'];
  if (!name) return errorResponse('missing interface name', 400);

  // The verified caller (routeManifest.ts: only an app instance, in every mode).
  const instance = locals.access ? actingInstance(locals.access.principal) : null;
  if (!instance) {
    return errorResponse('Could not identify the calling instance: send Authorization: Bearer $AURA_INSTANCE_TOKEN, or call through the App Host gateway.', 401);
  }

  const removed = mgr.interfaces.unregister(instance.instanceId, name);
  return jsonResponse({ ok: true, removed });
};
