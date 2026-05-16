import type { APIRoute } from 'astro';
import { getAppManager, OsEventBus } from '@aura/core';
import type { AppActivity } from '@aura/core';
import { jsonResponse, errorResponse } from '../../../../lib/appResponse.js';

/**
 * Toggle the OS-rendered breadcrumb trail for an activity at runtime.
 *
 * Body: `{ mode: 'os' | 'off' }`.
 *   • `'os'`  — Shell shows ← back + clickable trail in the slot chrome.
 *   • `'off'` — No OS-rendered chrome trail. App provides its own header.
 *
 * The default for new activities is `'os'`. Apps that always want their own
 * chrome can return `{ breadcrumb: 'off' }` from `onActivityCreate` (mirrors
 * the `minimizable` pattern); this endpoint covers the runtime-flip case.
 */
export const POST: APIRoute = async ({ params, request }) => {
  const raw = params['activityId'];
  if (!raw) return errorResponse('Missing activity id', 400);
  const activityId = decodeURIComponent(raw);

  let body: { mode?: unknown } = {};
  try {
    const parsed = await request.json().catch(() => null);
    if (parsed && typeof parsed === 'object') body = parsed as typeof body;
  } catch { return errorResponse('Body must be JSON: { mode }', 400); }

  if (body.mode !== 'os' && body.mode !== 'off') {
    return errorResponse("mode must be 'os' or 'off'", 400);
  }
  const mode = body.mode;

  const mgr = getAppManager();
  // Prefer the typed setter when available. Fall back to direct mutation +
  // event emit for the stale-singleton case (same pattern as /navigate and
  // /back endpoints), so this works without a container restart.
  try {
    if (typeof mgr.setActivityBreadcrumb === 'function') {
      const ok = mgr.setActivityBreadcrumb(activityId, mode);
      if (!ok) return errorResponse(`Activity not found: ${activityId}`, 404);
      return jsonResponse({ ok: true, activityId, breadcrumb: mode });
    }
    const activity = mgr.getActivity?.(activityId) as (AppActivity & { breadcrumb?: 'os' | 'off' }) | undefined;
    if (!activity) return errorResponse(`Activity not found: ${activityId}`, 404);
    if (activity.breadcrumb === mode) return jsonResponse({ ok: true, activityId, breadcrumb: mode });
    activity.breadcrumb = mode;
    activity.lastTransitionAt = new Date();
    OsEventBus.emit('activity:breadcrumbChanged', {
      activityId:       activity.activityId,
      parentInstanceId: activity.parentInstanceId,
      appId:            activity.appId,
      breadcrumb:       mode,
    } as never);
    return jsonResponse({ ok: true, activityId, breadcrumb: mode, viaFallback: true });
  } catch (err) {
    return errorResponse(`breadcrumb toggle failed: ${(err as Error).message}`, 500);
  }
};
