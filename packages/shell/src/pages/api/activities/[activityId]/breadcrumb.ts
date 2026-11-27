import type { APIRoute } from 'astro';
import { getAppManager } from '@aura/core';
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

  // The kernel emits `activity:breadcrumbChanged` (D97 A2).
  try {
    const ok = getAppManager().setActivityBreadcrumb(activityId, mode);
    if (!ok) return errorResponse(`Activity not found: ${activityId}`, 404);
    return jsonResponse({ ok: true, activityId, breadcrumb: mode });
  } catch (err) {
    return errorResponse(`breadcrumb toggle failed: ${(err as Error).message}`, 500);
  }
};
