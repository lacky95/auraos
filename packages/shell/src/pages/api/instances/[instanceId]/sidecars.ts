import type { APIRoute } from 'astro';
import { getAppManager } from '@aura/core';
import { jsonResponse, errorResponse } from '../../../../lib/appResponse.js';

/**
 * Inspect data for one instance: its own sandbox plus every sidecar attached
 * to it (backend-neutral — see `SidecarInfo`), each with live resource usage.
 *
 *   GET → { instanceId, instance: { usage }, sidecars: [...SidecarInfo, usage], totalMemBytes }
 *
 * Usage is measured on demand (a backend call per request), so poll this only
 * while an inspect view is open.
 */
export const GET: APIRoute = async ({ params }) => {
  const instanceId = params['instanceId'];
  if (!instanceId) return errorResponse('Missing instance id', 400);

  const mgr = getAppManager();
  if (!mgr.getInstance(instanceId)) return errorResponse(`Instance not found: ${instanceId}`, 404);

  try {
    const { instance, sidecars } = await mgr.getInstanceUsage(instanceId);
    const mems = [instance?.memBytes, ...sidecars.map((s) => s.usage?.memBytes)];
    const totalMemBytes = mems.every((m) => m == null)
      ? null
      : mems.reduce<number>((sum, m) => sum + (m ?? 0), 0);
    return jsonResponse({ instanceId, instance: { usage: instance }, sidecars, totalMemBytes });
  } catch (err) {
    return errorResponse(`Could not read usage for ${instanceId}: ${(err as Error).message}`, 502);
  }
};
