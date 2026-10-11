import type { APIRoute } from 'astro';
import { runLaunchCommand, takeLaunchCommand } from '../../../launch-commands.ts';
import { errorResponse } from '../../../session-service.ts';

/**
 * The window's terminal is live: run the command its OPEN_TERMINAL intent
 * queued, if any (see launch-commands.ts). Idempotent per window — the first
 * call takes the command, every later one (reconnect, reload, another browser
 * on the same window) finds nothing and answers 204 too.
 *
 * Query params and an empty 204 on success: the page never depends on a
 * POST body round-trip (bodies are stripped/hang in the Capacitor host).
 */
export const POST: APIRoute = async ({ request }) => {
  const windowId = new URL(request.url).searchParams.get('window');
  if (!windowId) return Response.json({ error: 'window required' }, { status: 400 });
  const pending = takeLaunchCommand(windowId);
  if (!pending) return new Response(null, { status: 204 });
  try {
    const { settled } = await runLaunchCommand(pending.sessionId, pending.command);
    console.log(`[terminal] launch command typed into ${pending.sessionId} (prompt ${settled ? 'settled' : 'not settled'})`);
    return new Response(null, { status: 204 });
  } catch (err) {
    console.warn(`[terminal] launch command for ${pending.sessionId} failed:`, (err as Error).message);
    return errorResponse(err);
  }
};
