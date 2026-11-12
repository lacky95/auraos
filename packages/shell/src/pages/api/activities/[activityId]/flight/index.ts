import type { APIRoute } from 'astro';
// Namespace import: the running shell may cache a core build without newer exports.
import * as core from '@aura/core';
import type { FlightPatch } from '@aura/core';
import { jsonResponse, errorResponse } from '../../../../../lib/appResponse.js';
import { flightService } from '../../../../../lib/flight/service.js';

/**
 * A free-flight activity's state.
 *
 *   GET   → `{ activityId, appId, title?, presentation, flight }`
 *   PATCH → body `FlightPatch`: `{ rect?, perch?, badge?, actions?, minSize?, title?,
 *           confirmClose? }` (`null` clears; `badge`/`actions` replace).
 *           `confirmClose: true` turns the close veto on (lib/flight/service.ts:
 *           a user Close then waits for the app). Header `x-aura-tab`
 *           tags the write so the shell tab that made it ignores the echo.
 */
export const GET: APIRoute = ({ params }) => {
  const id = decodeURIComponent(params['activityId'] ?? '');
  const a = core.getAppManager().getActivity(id);
  if (!a) return errorResponse(`Activity not found: ${id}`, 404);
  return jsonResponse({
    activityId: a.activityId, appId: a.appId, parentInstanceId: a.parentInstanceId,
    ...(a.title !== undefined ? { title: a.title } : {}),
    presentation: a.presentation ?? 'window',
    ...(a.flight ? { flight: { ...a.flight, confirmClose: flightService().confirmsClose(a.activityId) } } : {}),
  });
};

export const PATCH: APIRoute = async ({ params, request }) => {
  const id = decodeURIComponent(params['activityId'] ?? '');
  const body = await request.json().catch(() => null) as (FlightPatch & { confirmClose?: boolean | null }) | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return errorResponse('Body must be a JSON object (FlightPatch)', 400);
  const mgr = core.getAppManager();
  const a = mgr.getActivity(id);
  if (!a) return errorResponse(`Activity not found: ${id}`, 404);
  if (a.presentation !== 'flight') return errorResponse(`Activity ${id} is not a flight`, 409);
  try {
    const by = request.headers.get('x-aura-tab') ?? undefined;
    const { confirmClose, ...patch } = body;
    if (confirmClose !== undefined) flightService().setConfirmClose(id, confirmClose === true);
    // Only the veto switch: no geometry/tab change to announce.
    const flight = Object.keys(patch).length ? mgr.updateFlight(id, patch, by) : a.flight;
    return jsonResponse({ activityId: id, flight: { ...flight, confirmClose: flightService().confirmsClose(id) } });
  } catch (err) {
    return errorResponse((err as Error).message, 400);
  }
};
