import type { APIRoute } from 'astro';
import { getAppManager } from '@aura/core';
import { jsonResponse, errorResponse } from '../../../lib/appResponse.js';
import { identifyInstance } from './identify.js';

/**
 * DELETE /api/interfaces/<name> — drop a runtime registration.
 *
 * Best-effort: the OS drops every one of an instance's entries when it stops,
 * so an app that never calls this cannot leak. Manifest-declared interfaces
 * are not removable — they are the app's contract, not a runtime detail.
 *
 * There is no appId in the path on purpose. The caller's identity supplies it,
 * which is what makes writing to another app's entry inexpressible rather than
 * merely forbidden.
 */
export const DELETE: APIRoute = ({ params, request }) => {
  const mgr = getAppManager();
  const name = params['name'];
  if (!name) return errorResponse('missing interface name', 400);

  const instance = identifyInstance(request, mgr);
  if (!instance) {
    return errorResponse(
      'Could not identify the calling instance. Call from an app iframe, or send X-Aura-Instance-Id.',
      401,
    );
  }

  const removed = mgr.interfaces.unregister(instance.instanceId, name);
  return jsonResponse({ ok: true, removed });
};
