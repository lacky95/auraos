import type { APIRoute } from 'astro';
import { getAppManager } from '@aura/core';
import { jsonResponse, errorResponse } from '../../../../lib/appResponse.js';

/** Open a new activity on an existing instance. Optional `data` is passed to the app's onActivityCreate hook. */
export const POST: APIRoute = async ({ params, request }) => {
  const instanceId = params['instanceId'];
  if (!instanceId) return errorResponse('Missing instance id', 400);

  // Pre-flight guard: refuse to open an activity on a service instance BEFORE
  // touching openActivity. The same invariant is enforced at the manifest
  // schema (zod refine: service ⇒ activityMode='none') and again inside
  // AppManager.openActivity. Reproducing it here costs nothing and gives the
  // caller a precise 409 with structured fields instead of the generic 500
  // that bubbling the throw would produce — services-can't-host-activities
  // is an OS rule, not a server fault.
  const mgr = getAppManager();
  const inst = mgr.getInstance(instanceId);
  if (!inst) return errorResponse(`Instance not found: ${instanceId}`, 404);
  const manifest = mgr.getManifest(inst.appId);
  if (!manifest) return errorResponse(`Manifest gone for ${inst.appId}`, 500);
  if (manifest.componentType === 'service') {
    return jsonResponse({
      error: 'service-cannot-open-activity',
      message: `App ${inst.appId} is a service (componentType='service') — services are headless by contract and cannot host activities.`,
      appId: inst.appId,
      instanceId,
      hint: 'If you need a UI, change componentType to "activity" (with activityMode "multi") and re-install the app. backgroundService=true is the right flag for "UI app that survives last-window close".',
    }, 409);
  }

  // Body shape: `{ data?, stackParent? }`. Tolerate the legacy form where the
  // whole body IS the data bag — only treat top-level `data`/`stackParent`
  // keys specially when both shapes coexist, callers can be on either side
  // during the rollout.
  const body = await request.json().catch(() => undefined) as
    | (Record<string, unknown> & { data?: Record<string, unknown>; stackParent?: string })
    | undefined;
  const stackParent = typeof body?.stackParent === 'string' ? body.stackParent : undefined;
  const data = (body && typeof body.data === 'object' && body.data !== null)
    ? body.data
    : body; // legacy: whole body is the data bag
  try {
    const activity = await mgr.openActivity(
      instanceId,
      data,
      stackParent ? { stackParent } : undefined,
    );
    return jsonResponse({ activityId: activity.activityId, activity });
  } catch (err) {
    return errorResponse(String(err), 500);
  }
};

/** List activities of an instance. */
export const GET: APIRoute = ({ params }) => {
  const instanceId = params['instanceId'];
  if (!instanceId) return errorResponse('Missing instance id', 400);
  return jsonResponse(getAppManager().getActivitiesByInstance(instanceId));
};
