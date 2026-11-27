import type { APIRoute } from 'astro';
import { getAppManager } from '@aura/core';
import { jsonResponse, errorResponse, failureResponse } from '../../../../lib/appResponse.js';
import { describeClose } from '../../../../lib/activityClose.js';

/**
 * Close a single activity. Auto-stops parent if it was the last & not a backgroundService.
 * Answers `{ closed, close }`: what the close did (lib/activityClose.ts), from
 * which the desktop asks about a background process left running (D101).
 */
export const POST: APIRoute = async ({ params, request, locals }) => {
  const raw = params['activityId'];
  if (!raw) return errorResponse('Missing activity id', 400);
  // Astro doesn't auto-decode dynamic path segments — activityIds contain '#'
  const activityId = decodeURIComponent(raw);
  try {
    const close = await describeClose(await getAppManager().closeActivity(activityId));
    return jsonResponse({ closed: activityId, close });
  } catch (err) {
    return failureResponse({ request, locals }, err);
  }
};
