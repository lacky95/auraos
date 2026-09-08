import type { APIRoute } from 'astro';
import { errorResponse, intOr, openLocal } from '../../../session-service';

/** Create a shell with no window on it; it appears in every picker at once. */
export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const session = await openLocal({ cols: intOr(body['cols']), rows: intOr(body['rows']) });
    return Response.json({ session }, { status: 201 });
  } catch (err) { return errorResponse(err); }
};
