import type { APIRoute } from 'astro';
import * as core from '@aura/core';
import { jsonResponse } from '../../../lib/appResponse.js';
import { verifiedAppCaller } from '../../../lib/terminalCaller.ts';
import {
  TERMINAL_APP_ID, forgetSession, holdsListGrant, isSystemTerminal, mayUseSession, terminalSessionInstance,
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

/** A running Terminal instance, or null. */
function terminalInstance(instanceId: string | null) {
  if (!instanceId) return null;
  const inst = core.getAppManager().getInstance(instanceId);
  if (!inst || inst.appId !== TERMINAL_APP_ID || inst.port == null) return null;
  if (inst.state === 'error' || inst.state === 'destroyed' || inst.state === 'destroying') return null;
  return inst;
}

async function forward(instanceId: string, path: string, init: RequestInit = {}): Promise<Response> {
  const mgr = core.getAppManager();
  const inst = terminalInstance(instanceId);
  if (!inst) return jsonResponse({ error: 'instance-not-running', message: `${instanceId} is not a running Terminal instance` }, 404);
  const up = mgr.getUpstreamUrl?.(instanceId);
  const url = `http://${up?.host ?? 'localhost'}:${up?.port ?? inst.port}${path}`;
  try {
    const res = await fetch(url, {
      ...init,
      headers: { 'x-aura-app-id': inst.appId, 'x-aura-instance-id': inst.instanceId },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
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
  if (res.ok && caller) await forgetSession(caller.appId, id);
  return res;
};
