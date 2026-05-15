import type { APIRoute } from 'astro';
import { getAppManager } from '@aura/core';
import { jsonResponse, errorResponse } from '../../../../lib/appResponse.js';

/**
 * Android-style back navigation for activities. Closes the named activity
 * AND, if it was launched on top of another (`stackParentId` set), emits
 * `activity:focus` so the shell re-focuses the parent. With no parent this
 * behaves exactly like /close (plain dismiss, no auto-focus).
 */
export const POST: APIRoute = async ({ params }) => {
  const raw = params['activityId'];
  if (!raw) return errorResponse('Missing activity id', 400);
  const activityId = decodeURIComponent(raw);
  try {
    await getAppManager().goBack(activityId);
    return jsonResponse({ ok: true, popped: activityId });
  } catch (err) {
    return errorResponse(String(err), 500);
  }
};
