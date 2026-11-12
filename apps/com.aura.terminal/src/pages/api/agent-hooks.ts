import type { APIRoute } from 'astro';
import { hookStatus, installHooks, uninstallHooks } from '../../agent-hooks';

/**
 * Agent hooks in the shared home (agent-hooks.ts):
 *   GET    → status (script / claude / codex installed, codexConflict)
 *   POST   → install (idempotent, backs up what it changes)
 *   DELETE → remove only our entries
 * Explicit by design: nothing installs these behind the user's back.
 */
const run = (fn: () => unknown): Response => {
  try { return Response.json(fn()); }
  catch (err) { return Response.json({ error: 'hooks-failed', message: (err as Error).message }, { status: 500 }); }
};

export const GET: APIRoute    = () => run(() => hookStatus());
export const POST: APIRoute   = () => run(() => installHooks());
export const DELETE: APIRoute = () => run(() => uninstallHooks());
