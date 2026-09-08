import type { APIRoute } from 'astro';
import { errorResponse, inputLocal } from '../../../session-service';

/** Type text and/or send keys into one local session. Body: `{ text?, keys?, paste? }`. */
export const POST: APIRoute = async ({ request }) => {
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return Response.json({ error: 'bad-request', message: 'id required' }, { status: 400 });
  try {
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    if (!body) return Response.json({ error: 'bad-request', message: 'JSON body required' }, { status: 400 });
    const keys = body['keys'];
    if (keys !== undefined && !(Array.isArray(keys) && keys.every((k) => typeof k === 'string'))) {
      return Response.json({ error: 'bad-request', message: 'keys must be an array of strings' }, { status: 400 });
    }
    return Response.json(await inputLocal(id, {
      text:  typeof body['text'] === 'string' ? body['text'] : undefined,
      keys:  keys as string[] | undefined,
      paste: body['paste'] === true,
    }));
  } catch (err) { return errorResponse(err); }
};
