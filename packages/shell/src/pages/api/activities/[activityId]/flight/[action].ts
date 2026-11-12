import type { APIRoute } from 'astro';
// Namespace import: the running shell may cache a core build without newer exports.
import * as core from '@aura/core';
import type { FlightRect } from '@aura/core';
import { jsonResponse, errorResponse } from '../../../../../lib/appResponse.js';
import { flightService } from '../../../../../lib/flight/service.js';
import { loadFlightMemory, rememberedFlight } from '../../../../../lib/flight/memory.js';

/**
 * Flight transitions.
 *
 *   POST …/flight/takeoff  body `{ rect? }` — window → flight (needs system.overlay)
 *   POST …/flight/land                     — flight → window (active workspace)
 *   POST …/flight/close    body `{ reason? }` — a USER close. Closes at once,
 *        unless the app turned the veto on (`confirmClose`): then the app gets
 *        `activity:flightClosing` and may keep it within the veto window; a
 *        second close while pending closes at once. (An app closing its own
 *        flight uses the plain POST /api/activities/<id>/close.)
 *   POST …/flight/keep                     — the app vetoes a pending close
 *   POST …/flight/proceed                  — the app lets a pending close go now
 */
export const POST: APIRoute = async ({ params, request }) => {
  const id = decodeURIComponent(params['activityId'] ?? '');
  const action = params['action'];
  const mgr = core.getAppManager();
  const a = mgr.getActivity(id);
  if (!a) return errorResponse(`Activity not found: ${id}`, 404);
  const by = request.headers.get('x-aura-tab') ?? undefined;
  const body = await request.json().catch(() => ({})) as { rect?: FlightRect; reason?: string };

  switch (action) {
    case 'takeoff':
      try {
        // A window takes off as a free flight at its own rect; its tab and
        // drawer come back where the user last had them.
        await loadFlightMemory();
        const last = rememberedFlight(a.appId, a.path);
        const flight = mgr.takeOffActivity(id, {
          ...(body?.rect ? { rect: body.rect } : {}),
          ...(last ? { anchor: last.anchor, edgeSize: last.edgeSize } : {}),
        }, by);
        return jsonResponse({ activityId: id, presentation: 'flight', flight });
      } catch (err) {
        const msg = (err as Error).message;
        return errorResponse(msg, /system\.overlay/.test(msg) ? 403 : /limit/.test(msg) ? 409 : 400);
      }
    case 'land':
      if (a.presentation !== 'flight') return errorResponse(`Activity ${id} is not a flight`, 409);
      mgr.landFlight(id, by);
      return jsonResponse({ activityId: id, presentation: 'window' });
    case 'close': {
      const reason = typeof body?.reason === 'string' ? body.reason.slice(0, 64) : 'user';
      const r = flightService().requestClose(id, reason);
      if (r === 'not-found') return errorResponse(`Activity ${id} is not a flight`, 409);
      return jsonResponse({ activityId: id, result: r });
    }
    case 'keep':
      if (!flightService().keep(id)) return errorResponse(`No close pending for ${id}`, 409);
      return jsonResponse({ activityId: id, kept: true });
    case 'proceed':
      if (!flightService().proceed(id)) return errorResponse(`No close pending for ${id}`, 409);
      return jsonResponse({ activityId: id, closed: true });
    default:
      return errorResponse(`Unknown flight action: ${action}`, 404);
  }
};
