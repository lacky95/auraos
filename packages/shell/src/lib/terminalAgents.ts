/**
 * The coding agents in the owner's Terminal sessions, for an app holding
 * `terminal.sessions.list` (TerminalX's watcher, D29). The manifest rule of
 * both routes takes that grant in every mode (`guard: 'rule'`), so these
 * handlers start from a caller that holds it.
 *
 *   GET    /api/terminal/sessions/events?instance=<terminal instance>
 *          SSE: that instance's agent changes (its `/api/sessions/events`:
 *          a `snapshot`, then one `agent` event per change). The sessions
 *          list already carries each session's agent; this is its live feed.
 *          The stream ends when the app loses the grant.
 *   GET    /api/terminal/agent-hooks?instance=<terminal instance>   status
 *   POST   /api/terminal/agent-hooks?instance=…                     install
 *   DELETE /api/terminal/agent-hooks?instance=…                     remove
 *          The hooks live in the owner's home, which every app shares, so an
 *          app installs or removes them only with the owner's approval of
 *          exactly that change (5.10): 202 needs-approval first, then the
 *          same request with `X-Aura-Approval`, consumed once. The owner and
 *          the System Terminal need none.
 *
 * Until the private Terminal ingress (Phase 5) these replace the tokenless
 * `/api/proxy/<terminal>/api/sessions/events` and `/api/agent-hooks` calls,
 * which D28 identifies only from a container: a PRoot app like TerminalX has
 * no network identity.
 */
import type { AgentHooksChange } from './approvals/display.ts';

/** How often a running stream checks that its app still holds the grant. */
export const GRANT_RECHECK_MS = 30_000;

type Caller = { appId: string } | null | 'invalid';

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

function instanceParam(request: Request): string | null {
  return new URL(request.url).searchParams.get('instance') || null;
}

/** Each way a Terminal instance can fail to answer, as the routes under /api/terminal say it. */
async function reach(instanceId: string, open: () => Promise<Response | null>): Promise<Response> {
  try {
    const res = await open();
    if (res) return res;
    return json({ error: 'instance-not-running', message: `${instanceId} is not a running Terminal instance` }, 404);
  } catch (err) {
    return json({ error: 'instance-unreachable', message: `${instanceId}: ${(err as Error).message}` }, 502);
  }
}

// ── agent events ────────────────────────────────────────────────────────────

export interface AgentEventsDeps {
  /** The app the call is held to (lib/terminalCaller.ts `grantedAppCaller`). */
  caller(request: Request): Promise<Caller>;
  holdsListGrant(appId: string): Promise<boolean>;
  /** The instance's own SSE (`/api/sessions/events?stream=1`), ended by `signal`; null when not running. */
  open(instanceId: string, signal: AbortSignal): Promise<Response | null>;
  recheckMs?: number;
}

export function createAgentEventsRoute(deps: AgentEventsDeps): (request: Request) => Promise<Response> {
  return async (request) => {
    const caller = await deps.caller(request);
    if (caller === 'invalid') return json({ error: 'caller-invalid' }, 401);
    const instanceId = instanceParam(request);
    if (!instanceId) return json({ error: 'instance required' }, 400);

    const upstream = new AbortController();
    const stop = () => upstream.abort();
    request.signal.addEventListener('abort', stop, { once: true });
    const res = await reach(instanceId, () => deps.open(instanceId, upstream.signal));
    if (res.status !== 200 || !res.body || !(res.headers.get('content-type') ?? '').startsWith('text/event-stream')) {
      const text = await res.text().catch(() => '');
      request.signal.removeEventListener('abort', stop);
      upstream.abort();
      if (res.status === 200) return json({ error: 'instance-unreachable', message: `${instanceId}: no event stream` }, 502);
      return new Response(text, { status: res.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    }

    let timer: ReturnType<typeof setInterval> | undefined;
    if (caller) {
      timer = setInterval(() => {
        void deps.holdsListGrant(caller.appId).then((held) => { if (!held) stop(); }, stop);
      }, deps.recheckMs ?? GRANT_RECHECK_MS);
    }
    const done = () => { clearInterval(timer); request.signal.removeEventListener('abort', stop); };
    upstream.signal.addEventListener('abort', done, { once: true });
    const reader = res.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        try {
          const chunk = await reader.read();
          if (chunk.done) { done(); ctrl.close(); } else ctrl.enqueue(chunk.value);
        } catch (err) {
          done();
          ctrl.error(err);
        }
      },
      // The client went away: so does the upstream.
      cancel: () => { stop(); },
    });
    return new Response(body, {
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' },
    });
  };
}

// ── agent hooks ─────────────────────────────────────────────────────────────

const HOOK_CHANGES: Readonly<Record<string, AgentHooksChange['op']>> = { POST: 'install', DELETE: 'remove' };

export interface AgentHooksDeps {
  caller(request: Request): Promise<Caller>;
  /** Null when the change may go ahead (its approval used up), else the answer (lib/approvals `approvedOrAsk`). */
  approve(request: Request, change: AgentHooksChange): Promise<Response | null>;
  /** `/api/agent-hooks` on that instance with this method; null when not running. */
  forward(instanceId: string, method: string): Promise<Response | null>;
}

export function createAgentHooksRoute(deps: AgentHooksDeps): (request: Request) => Promise<Response> {
  return async (request) => {
    const caller = await deps.caller(request);
    if (caller === 'invalid') return json({ error: 'caller-invalid' }, 401);
    const instanceId = instanceParam(request);
    if (!instanceId) return json({ error: 'instance required' }, 400);
    const op = HOOK_CHANGES[request.method];
    if (op && caller) {
      const asked = await deps.approve(request, { op });
      if (asked) return asked;
    }
    return reach(instanceId, () => deps.forward(instanceId, request.method));
  };
}
