import type { APIRoute } from 'astro';
import { getAppManager } from '@aura/core';
import { jsonResponse, errorResponse } from '../../../../lib/appResponse.js';

/**
 * Jump to a specific entry in the activity's back stack — the operation
 * fired when the user clicks a middle crumb in the OS-rendered breadcrumb
 * trail. Equivalent to popping `history.length - index - 1` entries off
 * the stack in one round-trip.
 *
 * Body: `{ index: number }` — 0-based position in `activity.history`.
 *   • Negative / out-of-range → 400.
 *   • `index === history.length - 1` → pop one (same as plain `/back`).
 *   • `index === 0` → fully unwind to the root.
 *
 * Emits a single `activity:navigated { fromHistory: true }` so the shell
 * rerenders the slot iframe + chrome in one event regardless of stack depth.
 */
export const POST: APIRoute = async ({ params, request }) => {
  const raw = params['activityId'];
  if (!raw) return errorResponse('Missing activity id', 400);
  const activityId = decodeURIComponent(raw);

  let body: { index?: unknown } = {};
  try {
    const parsed = await request.json().catch(() => null);
    if (parsed && typeof parsed === 'object') body = parsed as typeof body;
  } catch { return errorResponse('Body must be JSON: { index }', 400); }

  if (typeof body.index !== 'number' || !Number.isInteger(body.index) || body.index < 0) {
    return errorResponse('index must be a non-negative integer', 400);
  }
  const targetIndex = body.index;

  // The kernel moves the history and emits `activity:navigated` (D97 A2).
  try {
    const r = getAppManager().navigateBackTo(activityId, targetIndex);
    if (!r) return errorResponse(`Activity not found: ${activityId}`, 404);
    return jsonResponse(r.noop ? { ok: true, activityId, index: targetIndex, noop: r.noop, historyLength: r.historyLength } : { ok: true, activityId, index: targetIndex });
  } catch (err) {
    return errorResponse(`back-to failed: ${(err as Error).message}`, 500);
  }
};
