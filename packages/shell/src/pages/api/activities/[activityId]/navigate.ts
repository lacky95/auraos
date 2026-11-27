import type { APIRoute } from 'astro';
import { getAppManager } from '@aura/core';
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
 * On success emits `activity:navigated`; the shell's desktop-pages/index.astro
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

  // The kernel changes the activity and emits `activity:navigated` (D97 A2: routes emit no kernel events).
  try {
    const ok = getAppManager().navigateActivity(activityId, body.path, opts);
    if (!ok) return errorResponse(`Activity not found: ${activityId}`, 404);
    return jsonResponse({ ok: true, activityId, path: body.path });
  } catch (err) {
    return errorResponse(`navigate failed: ${(err as Error).message}`, 500);
  }
};
