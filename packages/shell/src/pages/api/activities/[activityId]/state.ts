import type { APIRoute } from 'astro';
// Namespace import: the running shell may cache a core build without newer exports.
import * as core from '@aura/core';
import { jsonResponse, errorResponse } from '../../../../lib/appResponse.js';

/**
 * App-defined state of one activity (`AppActivity.savedState`) — what the app
 * needs to bring this activity back after an OS restart (Terminal: which
 * session it shows). Kept in the desktop session snapshot
 * (lib/desktopSession.ts) and handed back in `onActivityCreate` as
 * `restore.state`.
 *
 *   GET → { activityId, state }
 *   PUT { state } → store it (JSON, ≤ 64 KB); `state: null` clears it.
 *
 * SDK: `osClient.activity.saveState(state)` / `.savedState()`.
 */
const MAX = 64 * 1024;

function idOf(raw: string | undefined): string | null {
  return raw ? decodeURIComponent(raw) : null;
}

export const GET: APIRoute = async ({ params }) => {
  const activityId = idOf(params['activityId']);
  if (!activityId) return errorResponse('Missing activity id', 400);
  const a = core.getAppManager().getActivity(activityId) as (core.AppActivity & { savedState?: unknown }) | undefined;
  if (!a) return errorResponse(`Activity not found: ${activityId}`, 404);
  return jsonResponse({ activityId, state: a.savedState ?? null });
};

export const PUT: APIRoute = async ({ params, request }) => {
  const activityId = idOf(params['activityId']);
  if (!activityId) return errorResponse('Missing activity id', 400);
  const text = await request.text();
  if (text.length > MAX + 64) return errorResponse(`state is larger than ${MAX / 1024} KB`, 413);
  let body: { state?: unknown };
  try { body = JSON.parse(text || '{}') as { state?: unknown }; }
  catch { return errorResponse('Body must be JSON: { state }', 400); }
  if (!body || typeof body !== 'object' || !('state' in body)) return errorResponse('Body must be JSON: { state }', 400);

  const mgr = core.getAppManager() as ReturnType<typeof core.getAppManager> & {
    setActivityState?: (id: string, state: unknown) => void;
  };
  try {
    if (typeof mgr.setActivityState === 'function') {
      mgr.setActivityState(activityId, body.state);
    } else {
      // Singleton from before setActivityState existed (no restart yet).
      const a = mgr.getActivity(activityId) as (core.AppActivity & { savedState?: unknown }) | undefined;
      if (!a) return errorResponse(`Activity not found: ${activityId}`, 404);
      if (body.state === null || body.state === undefined) delete a.savedState;
      else a.savedState = JSON.parse(JSON.stringify(body.state));
      core.OsEventBus.emit('activity:stateSaved', { activityId, parentInstanceId: a.parentInstanceId, appId: a.appId });
    }
  } catch (err) {
    const msg = (err as Error).message;
    return errorResponse(msg, /not found/i.test(msg) ? 404 : 400);
  }
  return jsonResponse({ ok: true, activityId });
};
