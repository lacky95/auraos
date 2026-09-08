import type { APIRoute } from 'astro';
import { errorResponse, intOr, screenLocal } from '../../../session-service';

/** The rendered grid of one local session. The id rides in `?id=` — see the
 *  proxy note in session-router.ts for why it is never a path segment. */
export const GET: APIRoute = async ({ request }) => {
  const p = new URL(request.url).searchParams;
  const id = p.get('id');
  if (!id) return Response.json({ error: 'bad-request', message: 'id required' }, { status: 400 });
  try {
    return Response.json(await screenLocal(id, {
      scrollback: intOr(p.get('scrollback')),
      settleMs:   intOr(p.get('settle_ms')),
      timeoutMs:  intOr(p.get('timeout_ms')),
    }));
  } catch (err) { return errorResponse(err); }
};
