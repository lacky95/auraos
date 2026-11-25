import type { APIRoute } from 'astro';
import * as core from '@aura/core';
import { jsonResponse } from '../../../lib/appResponse.js';
import { verifiedAppCaller } from '../../../lib/terminalCaller.ts';
import {
  fetchTerminal, forgetSessionGrants, holdsListGrant, isSystemTerminal, mayUseSession, terminalSessionInstance,
} from '../../../../server/terminal-embed.mjs';

/**
 * The owner's Terminal sessions, for an app with a grant (D29, 5.16 safeguard 4).
 *
 *   GET    ?instance=<terminal instance>  that instance's `/api/sessions` list.
 *          Needs `terminal.sessions.list` (TerminalX's watcher).
 *   DELETE ?id=<session id>               close a session. Needs that session's
 *          `terminal.embed` grant, so an embedder closes only what it created.
 *
 * Callers prove who they are with the instance token (the SDK's server side)
 * or the App Host gateway. A caller without an app identity is not limited
 * here (server/terminal-embed.mjs). The machine path
 * `/api/proxy/<terminal>/api/sessions` stays open to app containers until the
 * private Terminal ingress (Phase 5).
 */

const TIMEOUT_MS = 10_000;

async function appCaller(request: Request): Promise<{ appId: string } | null | Response> {
  const caller = verifiedAppCaller(request, core.getAppManager());
  if (caller === 'invalid') return jsonResponse({ error: 'caller-invalid' }, 401);
  if (caller && await isSystemTerminal(caller.appId)) return null;
  return caller;
}

async function forward(instanceId: string, path: string, init: RequestInit = {}): Promise<Response> {
  try {
    const res = await fetchTerminal(core.getAppManager(), instanceId, path, init, TIMEOUT_MS);
    if (!res) return jsonResponse({ error: 'instance-not-running', message: `${instanceId} is not a running Terminal instance` }, 404);
    const text = await res.text();
    return new Response(text, {
      status: res.status,
      headers: { 'content-type': res.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' },
    });
  } catch (err) {
    return jsonResponse({ error: 'instance-unreachable', message: `${instanceId}: ${(err as Error).message}` }, 502);
  }
}

export const GET: APIRoute = async ({ request, url }) => {
  const caller = await appCaller(request);
  if (caller instanceof Response) return caller;
  if (caller && !(await holdsListGrant(caller.appId))) {
    return jsonResponse({ error: 'not-granted', message: `${caller.appId} was not granted terminal.sessions.list` }, 403);
  }
  const instanceId = url.searchParams.get('instance');
  if (!instanceId) return jsonResponse({ error: 'instance required' }, 400);
  return forward(instanceId, '/api/sessions');
};

export const DELETE: APIRoute = async ({ request, url }) => {
  const caller = await appCaller(request);
  if (caller instanceof Response) return caller;
  const id = url.searchParams.get('id');
  const instanceId = terminalSessionInstance(id);
  if (!id || !instanceId) return jsonResponse({ error: 'bad-session-id' }, 400);
  if (caller && !(await mayUseSession(caller.appId, id))) {
    return jsonResponse({ error: 'not-granted', message: 'This app was not granted that Terminal session.' }, 403);
  }
  const res = await forward(instanceId, `/api/sessions?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
  // The Terminal reports the end too; dropping the grants here closes the gap.
  if (res.ok) await forgetSessionGrants(id).catch(() => 0);
  return res;
};
