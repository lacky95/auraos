import type { APIRoute } from 'astro';
import { getAppManager, OsEventBus } from '@aura/core';
import type { AppActivity } from '@aura/core';
import { jsonResponse, errorResponse } from '../../../../lib/appResponse.js';

/**
 * In-place activity navigation — the "replace-current" launch mode.
 *
 * Body: `{ path: string, title?: string, pushHistory?: boolean }`.
 *
 *   • `pushHistory: true` (default) — the OS records the old path so OS
 *     Back returns to it. Use for normal forward nav (Settings tile click,
 *     wizard next step, drill-down).
 *   • `pushHistory: false` — replace the URL without recording history.
 *     Use for redirects or to clear stale steps from the stack.
 *
 * On success emits `activity:navigated`; the shell's pages/index.astro
 * picks it up and updates the iframe `src` + view title in place — no new
 * layout slot is created.
 */
export const POST: APIRoute = async ({ params, request }) => {
  const raw = params['activityId'];
  if (!raw) return errorResponse('Missing activity id', 400);
  const activityId = decodeURIComponent(raw);

  let body: { path?: unknown; title?: unknown; pushHistory?: unknown } = {};
  try {
    const parsed = await request.json().catch(() => null);
    if (parsed && typeof parsed === 'object') body = parsed as typeof body;
  } catch { return errorResponse('Body must be JSON: { path, title?, pushHistory? }', 400); }

  if (typeof body.path !== 'string' || body.path.length === 0) {
    return errorResponse('path is required', 400);
  }
  const opts: { title?: string; pushHistory?: boolean } = {};
  if (typeof body.title === 'string') opts.title = body.title;
  if (typeof body.pushHistory === 'boolean') opts.pushHistory = body.pushHistory;

  const mgr = getAppManager();

  // Prefer the typed AppManager method when present. Falls back to in-place
  // mutation when the singleton on globalThis is older than the @aura/core
  // dist — Vite/Astro HMR doesn't re-init globalThis singletons, so the
  // stale-class case is real until the Node process is fully restarted.
  // Both paths land on the same OsEventBus emit so the SSE-driven shell
  // refresh fires uniformly.
  try {
    if (typeof mgr.navigateActivity === 'function') {
      const ok = mgr.navigateActivity(activityId, body.path, opts);
      if (!ok) return errorResponse(`Activity not found: ${activityId}`, 404);
      return jsonResponse({ ok: true, activityId, path: body.path });
    }

    // Fallback: mutate the activity object directly. `getActivity()` is on
    // every AppManager generation, so this works even on a singleton from
    // before the navigateActivity method existed. The activity object
    // reference is the AppManager's own internal record, so the mutation
    // is visible to subsequent calls.
    type HistoryEntry = { path: string; title?: string };
    type ExtActivity = AppActivity & { history?: HistoryEntry[]; breadcrumb?: 'os' | 'off' };
    const activity = mgr.getActivity?.(activityId) as ExtActivity | undefined;
    if (!activity) return errorResponse(`Activity not found: ${activityId}`, 404);
    const normalizedPath = body.path.startsWith('/') ? body.path : `/${body.path}`;
    const pushHistory = opts.pushHistory !== false;
    if (pushHistory && normalizedPath !== activity.path) {
      const entry: HistoryEntry = { path: activity.path };
      if (activity.title !== undefined) entry.title = activity.title;
      activity.history = [...(activity.history ?? []), entry];
    }
    activity.path = normalizedPath;
    if (typeof opts.title === 'string') activity.title = opts.title;
    activity.lastTransitionAt = new Date();
    OsEventBus.emit('activity:navigated', {
      activityId:       activity.activityId,
      parentInstanceId: activity.parentInstanceId,
      appId:            activity.appId,
      path:             normalizedPath,
      history:          [...(activity.history ?? [])],
      breadcrumb:       activity.breadcrumb ?? 'os',
      fromHistory:      false,
      ...(activity.title !== undefined ? { title: activity.title } : {}),
    } as never);
    return jsonResponse({ ok: true, activityId, path: body.path, viaFallback: true });
  } catch (err) {
    return errorResponse(`navigate failed: ${(err as Error).message}`, 500);
  }
};
