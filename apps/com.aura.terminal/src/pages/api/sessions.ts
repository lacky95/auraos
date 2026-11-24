import type { APIRoute } from 'astro';
import { nextSessionId, killSession } from '../../pty-server';
import { errorResponse, listLocal, localInstanceId } from '../../session-service';
import { isLocal, killFor, remoteJson } from '../../session-router';
import { forgetSessionPicks, leavePendingSession, pickSession } from '../../window-session';

/**
 * `?instance=<another terminal instance>`: the same call on that instance,
 * through this container. An App Host page has one origin per instance, and
 * reaches only its own backend (5.16), so the picker's other instances go
 * through here. Without the parameter, or naming this instance, it is local.
 */
const otherInstance = (url: URL): string | null => {
  const id = url.searchParams.get('instance');
  return id && !isLocal(id) ? id : null;
};

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
export const GET: APIRoute = async ({ request }) => {
  try {
    const other = otherInstance(new URL(request.url));
    if (other) return Response.json(await remoteJson(other, '/api/sessions'));
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
  if (!id.startsWith(`${localInstanceId()}#`)) {
    try { return Response.json(await killFor(id)); } catch (err) { return errorResponse(err); }
  }
  const killed = killSession(id);
  forgetSessionPicks(id);
  return Response.json({ id, killed });
};

/**
 * Record which session a window is showing, so a reload reopens it (see
 * window-session.ts). Query params, not a body: the terminal page never
 * depends on a POST/PUT body round-trip (see startNewInstance there).
 */
export const PUT: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const params = url.searchParams;
  const pending = params.get('pending');
  if (pending) {
    // Hand a picked session to the next page of the instance it lives on.
    const other = otherInstance(url);
    try {
      if (other) await remoteJson(other, `/api/sessions?pending=${encodeURIComponent(pending)}`, { method: 'PUT' });
      else leavePendingSession(pending);
      return new Response(null, { status: 204 });
    } catch (err) { return errorResponse(err); }
  }
  const windowId = params.get('window');
  if (!windowId) return new Response(JSON.stringify({ error: 'window required' }), { status: 400 });
  try {
    pickSession(windowId, params.get('session'));
    return new Response(null, { status: 204 });
  } catch (err) { return errorResponse(err); }
};
