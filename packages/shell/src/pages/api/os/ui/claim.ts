import type { APIRoute } from 'astro';
import { uiCommandBroker } from '../../../../lib/uiCommandBroker';
import { jsonResponse, errorResponse } from '../../../../lib/appResponse.js';

/** A browser tab asking to run a `ui:command`. First claim wins (200); the
 *  rest get 409 and stand down; an expired/unknown id is 404. */
export const POST: APIRoute = async ({ request }) => {
  let body: { id?: unknown };
  try { body = await request.json() as typeof body; }
  catch { return errorResponse('Invalid JSON', 400); }
  if (typeof body.id !== 'string') return errorResponse('id required', 400);
  switch (uiCommandBroker.claim(body.id)) {
    case 'claimed':         return jsonResponse({ ok: true });
    case 'already-claimed': return jsonResponse({ error: 'already-claimed' }, 409);
    default:                return jsonResponse({ error: 'unknown-command' }, 404);
  }
};
