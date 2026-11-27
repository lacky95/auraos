import type { APIRoute } from 'astro';
import { errorResponse, intOr, screenLocal, styledLocal } from '../../../session-service';
import { screenFacts } from '../../../screen-summary';

/** The rendered grid of one local session. The id rides in `?id=` — see the
 *  proxy note in session-router.ts for why it is never a path segment. */
export const GET: APIRoute = async ({ request }) => {
  const p = new URL(request.url).searchParams;
  const id = p.get('id');
  if (!id) return Response.json({ error: 'bad-request', message: 'id required' }, { status: 400 });
  try {
    // `?styled=1`: the grid with its escape sequences (TM-16/17), for the MCP on another instance.
    if (p.get('styled') === '1') return Response.json({ id, styled: await styledLocal(id) });
    // `?facts=1`: only `{id, busy, agent}`, never the rows (the shell's
    // /api/terminal/sessions/screen for apps holding terminal.screen.read).
    if (p.get('facts') === '1') {
      const v = await screenLocal(id);
      return Response.json({ id, ...screenFacts({ command: v.command, title: v.title, screen: v.screen }) });
    }
    return Response.json(await screenLocal(id, {
      scrollback: intOr(p.get('scrollback')),
      settleMs:   intOr(p.get('settle_ms')),
      timeoutMs:  intOr(p.get('timeout_ms')),
    }));
  } catch (err) { return errorResponse(err); }
};
