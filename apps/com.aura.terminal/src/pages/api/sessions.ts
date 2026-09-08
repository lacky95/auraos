import type { APIRoute } from 'astro';
import { nextSessionId, killSession } from '../../pty-server';
import { errorResponse, listLocal } from '../../session-service';

/**
 * The shells this container can show.
 *
 * Sessions are an app-level thing, NOT OS activities: an activity is a window
 * handle and the OS gives each one exactly one window, while a session is a
 * live shell that any window may take over (that is what the terminal's
 * "in use elsewhere" screen has always been for). The picker in the top bar
 * reads this, one request per instance, through the OS proxy — and so does
 * the terminal MCP on another instance (see session-router.ts), which is why
 * each row also carries what tmux knows about the pane.
 */
export const GET: APIRoute = async () => {
  try {
    // Names already spoken for, including ones whose shell is long gone but
    // whose scrollback survives. The picker numbers new sessions above these
    // so a fresh one never opens onto a dead session's output.
    return Response.json(await listLocal());
  } catch (err) { return errorResponse(err); }
};

/** Mint an id for a new shell. Creating the PTY itself is the WS's job — the
 *  session springs into existence when a window connects to the id. */
export const POST: APIRoute = () => {
  const instanceId = process.env['APP_INSTANCE_ID'] ?? 'com.aura.terminal';
  return Response.json({ id: nextSessionId(instanceId) });
};

/** Drop a shell for good: kills the PTY/tmux session and its scrollback. */
export const DELETE: APIRoute = async ({ request }) => {
  const id = new URL(request.url).searchParams.get('id');
  if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400 });
  return Response.json({ id, killed: killSession(id) });
};
