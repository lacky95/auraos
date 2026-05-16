import type { APIRoute } from 'astro';
import { getAppManager, OsEventBus } from '@aura/core';
import type { AppActivity } from '@aura/core';
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
    // Inspect the activity FIRST so we can choose between the new in-place
    // pop and the legacy close-and-refocus chain.
    type HistoryEntry = { path: string; title?: string };
    type ExtActivity = AppActivity & { history?: HistoryEntry[]; breadcrumb?: 'os' | 'off' };
    const activity = mgr.getActivity?.(activityId) as ExtActivity | undefined;
    if (activity && activity.history && activity.history.length > 0) {
      // History pop path. Always do it here directly so the behavior is
      // identical whether AppManager.goBack is stale or fresh. The popped
      // entry carries BOTH path + title so the breadcrumb trail and chrome
      // title stay coherent after the pop.
      const previous = activity.history[activity.history.length - 1]!;
      activity.history.pop();
      activity.path = previous.path;
      activity.title = previous.title;
      activity.lastTransitionAt = new Date();
      OsEventBus.emit('activity:navigated', {
        activityId:       activity.activityId,
        parentInstanceId: activity.parentInstanceId,
        appId:            activity.appId,
        path:             previous.path,
        history:          [...activity.history],
        breadcrumb:       activity.breadcrumb ?? 'os',
        fromHistory:      true,
        ...(activity.title !== undefined ? { title: activity.title } : {}),
      } as never);
      return jsonResponse({ ok: true, popped: activityId, kind: 'history' });
    }

    // No history → fall through to legacy goBack (close + refocus parent).
    await mgr.goBack(activityId);
    return jsonResponse({ ok: true, popped: activityId, kind: 'close' });
  } catch (err) {
    return errorResponse(String(err), 500);
  }
};
