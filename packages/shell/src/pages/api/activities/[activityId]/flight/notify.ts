import type { APIRoute } from 'astro';
// Namespace import: the running shell may cache a core build without newer exports.
import * as core from '@aura/core';
import type { FlightNotice } from '@aura/core';
import { jsonResponse, errorResponse } from '../../../../../lib/appResponse.js';

/**
 * Ask for attention on a flight's tab — flight-only, separate from the
 * notification API (lib/flight/notice.ts draws it).
 *
 *   POST   body `FlightNotice` `{ level: info|attention|urgent, text?, count?, blink?, ttlMs?, clearOnOpen? }`
 *          — replaces the previous notice; `null` clears
 *   DELETE — clears
 *
 * Every call stamps `notice.at`, so the tab blinks again. Header `x-aura-tab`
 * tags the write like the PATCH route.
 */
export const POST: APIRoute = async ({ params, request }) => {
  const id = decodeURIComponent(params['activityId'] ?? '');
  const body = await request.json().catch(() => undefined) as FlightNotice | null | undefined;
  if (body === undefined || (body !== null && (typeof body !== 'object' || Array.isArray(body)))) return errorResponse('Body must be a FlightNotice object or null', 400);
  return apply(id, body, request);
};

export const DELETE: APIRoute = ({ params, request }) => apply(decodeURIComponent(params['activityId'] ?? ''), null, request);

function apply(id: string, notice: FlightNotice | null, request: Request): Response {
  const mgr = core.getAppManager();
  const a = mgr.getActivity(id);
  if (!a) return errorResponse(`Activity not found: ${id}`, 404);
  if (a.presentation !== 'flight') return errorResponse(`Activity ${id} is not a flight`, 409);
  if (typeof (mgr as { notifyFlight?: unknown }).notifyFlight !== 'function') return errorResponse('This OS build has no flight notices yet (rebuild core)', 501);
  try {
    const flight = mgr.notifyFlight(id, notice, request.headers.get('x-aura-tab') ?? undefined);
    return jsonResponse({ activityId: id, notice: flight?.notice ?? null, flight });
  } catch (err) {
    return errorResponse((err as Error).message, 400);
  }
}
