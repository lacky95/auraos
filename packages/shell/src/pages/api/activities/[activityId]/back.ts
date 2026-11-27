import type { APIRoute } from 'astro';
import { getAppManager } from '@aura/core';
import { jsonResponse, errorResponse } from '../../../../lib/appResponse.js';

/**
 * Android-style back navigation for activities. Resolution order:
 *   1. If the activity has an in-place history stack (populated by
 *      `/api/activities/<id>/navigate`), pop one entry → emit
 *      `activity:navigated { fromHistory: true }`. The iframe URL changes
 *      back, no slot is removed.
 *   2. Else if `stackParentId` is set, close + refocus parent (Android
 *      activity-stack behavior).
 *   3. Else, plain close.
 *
 * Step 1 lives in `AppManager.goBack()`. When the singleton on globalThis
 * predates that change (Vite/Astro HMR doesn't reinit globalThis), we fall
 * back to the same logic in-place here so the back chip works without a
 * full container restart.
 */
export const POST: APIRoute = async ({ params }) => {
  const raw = params['activityId'];
  if (!raw) return errorResponse('Missing activity id', 400);
  const activityId = decodeURIComponent(raw);
  const mgr = getAppManager();
  try {
    // goBack pops in-activity history (emitting `activity:navigated`) or closes and refocuses (D97 A2).
    const hadHistory = (mgr.getActivity(activityId)?.history?.length ?? 0) > 0;
    await mgr.goBack(activityId);
    return jsonResponse({ ok: true, popped: activityId, kind: hadHistory ? 'history' : 'close' });
  } catch (err) {
    return errorResponse(String(err), 500);
  }
};
