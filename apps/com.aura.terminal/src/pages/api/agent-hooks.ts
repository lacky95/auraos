import type { APIRoute } from 'astro';
import { userFiles } from '../../user-files';
import type { UserFileOp } from '../../user-file-ops';

/**
 * Agent hooks in the shared home (agent-hooks.ts):
 *   GET    → status (script / claude / codex installed, codexConflict)
 *   POST   → install (idempotent, backs up what it changes)
 *   DELETE → remove only our entries
 * Explicit by design: nothing installs these behind the user's back.
 * As the session user (user-files.ts, stream T2): this server can't open the home.
 */
const run = async (op: UserFileOp): Promise<Response> => {
  try { return Response.json(await userFiles(op)); }
  catch (err) { return Response.json({ error: 'hooks-failed', message: (err as Error).message }, { status: 500 }); }
};

export const GET: APIRoute    = () => run('hooks-status');
export const POST: APIRoute   = () => run('hooks-install');
export const DELETE: APIRoute = () => run('hooks-uninstall');
