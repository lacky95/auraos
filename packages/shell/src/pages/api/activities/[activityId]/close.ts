import type { APIRoute } from 'astro';
import { getAppManager } from '@aura/core';
import { jsonResponse, errorResponse } from '../../../../lib/appResponse.js';

/** Close a single activity. Auto-stops parent if it was the last & not a backgroundService. */
export const POST: APIRoute = async ({ params }) => {
  const raw = params['activityId'];
  if (!raw) return errorResponse('Missing activity id', 400);
  // Astro doesn't auto-decode dynamic path segments — activityIds contain '#'
  const activityId = decodeURIComponent(raw);
  try {
    await getAppManager().closeActivity(activityId);
    return jsonResponse({ closed: activityId });
  } catch (err) {
    return errorResponse(String(err), 500);
  }
};
