import type { APIRoute } from 'astro';
import { DialogError } from '../../../input-dialog';
import { dialogGetLocal, dialogOpLocal, errorResponse } from '../../../session-service';

/** The session's review-before-insert dialog. GET reads it; POST
 *  `{ op: 'open'|'set'|'insert'|'copy'|'close', text?, paste? }` changes it. */
function dialogError(err: unknown): Response {
  if (err instanceof DialogError) return Response.json({ error: err.code, message: err.message }, { status: err.status });
  return errorResponse(err);
}

export const GET: APIRoute = async ({ request }) => {
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return Response.json({ error: 'bad-request', message: 'id required' }, { status: 400 });
  try { return Response.json(await dialogGetLocal(id)); } catch (err) { return dialogError(err); }
};

export const POST: APIRoute = async ({ request }) => {
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return Response.json({ error: 'bad-request', message: 'id required' }, { status: 400 });
  try {
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const op = body?.['op'];
    if (op !== 'open' && op !== 'set' && op !== 'insert' && op !== 'copy' && op !== 'close') {
      return Response.json({ error: 'bad-request', message: 'op must be open|set|insert|copy|close' }, { status: 400 });
    }
    return Response.json(await dialogOpLocal(id, {
      op,
      text:  typeof body!['text'] === 'string' ? body!['text'] : undefined,
      paste: body!['paste'] === true,
    }));
  } catch (err) { return dialogError(err); }
};
