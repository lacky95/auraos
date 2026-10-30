import type { APIRoute } from 'astro';
import { createActivityCreateHandler, IntentRejectedError } from '@aura/app-sdk';
import { parseOpenTerminal } from '../../../launch-intent.ts';
import { openHeadlessSession, queueLaunchCommand, runLaunchCommand, sessionIsLive } from '../../../launch-commands.ts';
import { localInstanceId } from '../../../session-service.ts';
import { pickRestoredSession, pickSession } from '../../../window-session.ts';

/**
 * A new terminal window — or, for `background`, none. Only intent launches
 * carry options (launch-intent.ts has the contract); a launcher click or
 * "+ new window" arrives without an intent and gets exactly what it always
 * got: a window whose session is its own activity id.
 */
const handler = createActivityCreateHandler(async ({ activityId, intent }) => {
  if (!intent) return {};
  const instanceId = localInstanceId();
  const parsed = parseOpenTerminal(intent, instanceId);
  if (!parsed.ok) {
    const r = parsed.rejection;
    throw new IntentRejectedError(r.code, r.message, { status: r.status, ...(r.hint ? { hint: r.hint } : {}) });
  }
  const { sessionId: existing, command, background } = parsed.opts;

  if (existing && !(await sessionIsLive(existing))) {
    throw new IntentRejectedError('no-such-session', `No live session "${existing}" on ${instanceId}.`,
      { status: 404, hint: 'Its shell has exited or the id is stale. List sessions first; omit sessionId for a new one.' });
  }

  if (background) {
    // The activity id the OS just allocated is never used for a window — its
    // number is spent — so it is a collision-free name for the new shell.
    const sessionId = activityId;
    try {
      await openHeadlessSession(sessionId);
    } catch (err) {
      throw new IntentRejectedError('session-failed', `Could not start a background session: ${(err as Error).message}`, { status: 409 });
    }
    // Not awaited: the OS gives this hook a few seconds, and an intent whose
    // hook times out would fall back to opening a window.
    if (command) {
      runLaunchCommand(sessionId, command).catch((err) =>
        console.warn(`[terminal] background command for ${sessionId} failed:`, (err as Error).message));
    }
    return { noActivity: true, result: { instanceId, sessionId, background: true, command: command ? 'scheduled' : 'none' } };
  }

  const sessionId = existing ?? activityId;
  // The page server-renders the window's picked session (window-session.ts),
  // so recording the pick is all it takes to open the window on it.
  if (existing) pickSession(activityId, existing);
  if (command) queueLaunchCommand(activityId, sessionId, command);
  return { result: { instanceId, sessionId, background: false, command: command ? 'on-ready' : 'none' } };
});

/**
 * An OS restart recreated this activity (`restore` in the body — read from the
 * raw request so it works with any SDK version): put it back on the session
 * it showed. The page reports that session as the activity's state
 * (PUT /api/activities/<id>/state, `{ sessionId }`); without one the activity
 * showed its own default — its old activity id.
 */
function applyRestore(body: unknown): void {
  const b = body as { activityId?: unknown; intent?: unknown; restore?: { previousActivityId?: unknown; state?: unknown } } | null;
  if (!b || b.intent || !b.restore || typeof b.activityId !== 'string') return;
  const st = b.restore.state as { sessionId?: unknown } | null | undefined;
  const prev = typeof b.restore.previousActivityId === 'string' ? b.restore.previousActivityId : '';
  const want = typeof st?.sessionId === 'string' && st.sessionId ? st.sessionId : prev;
  if (want && want !== b.activityId) pickRestoredSession(b.activityId, want);
}

export const POST: APIRoute = async (ctx) => {
  try { applyRestore(await ctx.request.clone().json()); } catch { /* not JSON: the handler answers */ }
  return handler(ctx);
};
