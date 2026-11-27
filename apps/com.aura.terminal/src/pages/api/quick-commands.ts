import type { APIRoute } from 'astro';
import { userFiles } from '../../user-files';

/**
 * Quick commands, stored in the user's home (quick-commands-store.ts), read
 * and written as the session user (user-files.ts, stream T2).
 */

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export const GET: APIRoute = async () => {
  try { return json(await userFiles('quick-get')); }
  catch (err) { return json({ error: 'read-failed', message: (err as Error).message }, 500); }
};

export const PUT: APIRoute = async ({ request }) => {
  let body: { commands?: unknown };
  try { body = await request.json() as { commands?: unknown }; }
  catch { return json({ error: 'invalid-json' }, 400); }
  if (!Array.isArray(body?.commands)) {
    return json({ error: 'invalid-commands', message: 'Body must be { commands: [...] }.' }, 400);
  }
  try { return json({ ok: true, ...(await userFiles<{ commands: unknown[] }>('quick-put', { commands: body.commands })) }); }
  catch (err) { return json({ error: 'write-failed', message: (err as Error).message }, 500); }
};
