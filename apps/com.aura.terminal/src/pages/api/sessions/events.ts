import type { APIRoute } from 'astro';
import { agentFor, allAgents, parseEventBody, recordEvent, subscribeAgents } from '../../../agent-state';
import { localInstanceId } from '../../../session-service';

/**
 * Agent events for this instance's sessions (agent-state.ts).
 *
 *   POST  { session, source: 'claude'|'codex', payload }   — from agent-hook.sh
 *   GET                → { instanceId, agents: { <sessionId>: AgentState } }
 *   GET ?stream=1      → SSE: one `agent` event per change, `{ session, agent }`
 *                        (agent null ⇒ the session is gone), after an initial
 *                        `snapshot` event with the full map.
 */

const MAX_BODY = 256 * 1024;
const HEARTBEAT_MS = 25_000;

export const POST: APIRoute = async ({ request }) => {
  const raw = await request.text();
  if (raw.length > MAX_BODY) return Response.json({ error: 'too-large', message: 'body over 256 KiB' }, { status: 413 });
  let parsed;
  try { parsed = parseEventBody(JSON.parse(raw), Date.now()); }
  catch (err) { return Response.json({ error: 'bad-request', message: (err as Error).message }, { status: 400 }); }
  // A session id names its instance; an event for another one was sent to the
  // wrong container (the hook derives the URL from the id, so this is a bug).
  if (!parsed.session.startsWith(`${localInstanceId()}#`)) {
    return Response.json({ error: 'wrong-instance', message: `${parsed.session} does not live on ${localInstanceId()}` }, { status: 409 });
  }
  recordEvent(parsed.session, parsed.event);
  return Response.json({ session: parsed.session, agent: agentFor(parsed.session) });
};

export const GET: APIRoute = ({ request }) => {
  if (new URL(request.url).searchParams.get('stream') !== '1') {
    return Response.json({ instanceId: localInstanceId(), agents: allAgents() });
  }
  const enc = new TextEncoder();
  let cleanup = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) {
      const send = (event: string, data: unknown) => {
        try { ctrl.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); }
        catch { cleanup(); }
      };
      send('snapshot', { instanceId: localInstanceId(), agents: allAgents() });
      const off = subscribeAgents((change) => send('agent', change));
      const beat = setInterval(() => {
        try { ctrl.enqueue(enc.encode(': keepalive\n\n')); } catch { cleanup(); }
      }, HEARTBEAT_MS);
      cleanup = () => { off(); clearInterval(beat); };
      request.signal.addEventListener('abort', () => cleanup());
    },
    cancel() { cleanup(); },
  });
  return new Response(body, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' },
  });
};
