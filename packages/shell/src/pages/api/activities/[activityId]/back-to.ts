import type { APIRoute } from 'astro';
import { getAppManager, OsEventBus } from '@aura/core';
import type { AppActivity } from '@aura/core';
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

  type HistoryEntry = { path: string; title?: string };
  type ExtActivity = AppActivity & { history?: HistoryEntry[]; breadcrumb?: 'os' | 'off' };
  const mgr = getAppManager();
  try {
    const activity = mgr.getActivity?.(activityId) as ExtActivity | undefined;
    if (!activity) return errorResponse(`Activity not found: ${activityId}`, 404);
    const history = activity.history ?? [];
    // Click-spam tolerance: if the requested index is past the live history
    // (rapid clicks where the DOM still shows yesterday's trail; double-fire
    // from a fast tap), report a no-op-200 instead of 400. The shell's
    // re-render after the previous navigate already moved the user to the
    // right place — returning 400 would surface as a red warning in the
    // console for what is, semantically, "already there".
    if (targetIndex >= history.length) {
      return jsonResponse({ ok: true, activityId, index: targetIndex, noop: 'index-past-history', historyLength: history.length });
    }

    // Target entry stays in history? No — it becomes the current path. The
    // entries AFTER it are discarded; entries BEFORE it remain as the new
    // shorter back stack.
    const target = history[targetIndex]!;
    const newHistory = history.slice(0, targetIndex);
    activity.history = newHistory;
    activity.path = target.path;
    activity.title = target.title;
    activity.lastTransitionAt = new Date();
    OsEventBus.emit('activity:navigated', {
      activityId:       activity.activityId,
      parentInstanceId: activity.parentInstanceId,
      appId:            activity.appId,
      path:             target.path,
      history:          [...newHistory],
      breadcrumb:       activity.breadcrumb ?? 'os',
      fromHistory:      true,
      ...(target.title !== undefined ? { title: target.title } : {}),
    } as never);
    return jsonResponse({ ok: true, activityId, index: targetIndex });
  } catch (err) {
    return errorResponse(`back-to failed: ${(err as Error).message}`, 500);
  }
};
