import type { APIRoute } from 'astro';
import { uiCommandBroker } from '../../../../lib/uiCommandBroker';
import { jsonResponse, errorResponse } from '../../../../lib/appResponse.js';

/** The claimant's answer: `{ id, ok, result? }` or `{ id, ok: false, error }`. */
export const POST: APIRoute = async ({ request }) => {
  let body: { id?: unknown; ok?: unknown; result?: unknown; error?: unknown };
  try { body = await request.json() as typeof body; }
  catch { return errorResponse('Invalid JSON', 400); }
  if (typeof body.id !== 'string' || typeof body.ok !== 'boolean') return errorResponse('id and ok required', 400);
  const found = uiCommandBroker.resolve(body.id, {
    ok: body.ok, result: body.result, error: typeof body.error === 'string' ? body.error : undefined,
  });
  return found ? jsonResponse({ ok: true }) : jsonResponse({ error: 'unknown-command' }, 404);
};
