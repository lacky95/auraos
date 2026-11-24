import type { APIRoute } from 'astro';
import * as core from '@aura/core';
import { shellOwner } from '../../../lib/appHostHandoff.ts';
import { jsonResponse } from '../../../lib/appResponse.js';
import { holdsEmbedGrant, isSystemTerminal, shareSession, TERMINAL_APP_ID, terminalSessionInstance } from '../../../../server/terminal-embed.mjs';

/**
 * The owner shows an existing Terminal session in an app (D25), from the
 * Shell's own dialog (components/shell/TerminalShareDialog.astro). Shell page
 * only: an app's page has another Origin, and an app container has no owner
 * session once login is on. The app must hold `terminal.embed`.
 *
 *   POST {appId, sessionId, check: true}  {eligible}: may the dialog be offered at all
 *   POST {appId, sessionId}               records the session's grant for that app
 * (POST both: a same-origin GET carries no Origin to check.)
 */

async function sessionExists(sessionId: string): Promise<boolean> {
  const instanceId = terminalSessionInstance(sessionId);
  const mgr = core.getAppManager();
  const inst = instanceId ? mgr.getInstance(instanceId) : null;
  if (!inst || inst.appId !== TERMINAL_APP_ID || inst.port == null || !(await isSystemTerminal(inst.appId))) return false;
  const up = mgr.getUpstreamUrl?.(inst.instanceId);
  try {
    const res = await fetch(`http://${up?.host ?? 'localhost'}:${up?.port ?? inst.port}/api/sessions`, {
      headers: { 'x-aura-app-id': inst.appId, 'x-aura-instance-id': inst.instanceId },
      signal: AbortSignal.timeout(5_000),
    });
    const body = await res.json().catch(() => null) as { sessions?: Array<{ id?: unknown }> } | null;
    return !!body?.sessions?.some((s) => s.id === sessionId);
  } catch {
    return false;
  }
}

export const POST: APIRoute = async (ctx) => {
  const owner = await shellOwner(ctx);
  if ('error' in owner) return jsonResponse({ error: owner.error }, owner.status);
  const src = await ctx.request.json().catch(() => null) as Record<string, unknown> | null;
  const appId = src?.['appId'];
  const sessionId = src?.['sessionId'];
  if (typeof appId !== 'string' || !/^[A-Za-z0-9._-]{1,200}$/.test(appId) || typeof sessionId !== 'string' || !terminalSessionInstance(sessionId)) {
    return jsonResponse({ error: 'invalid-request' }, 400);
  }
  if (src?.['check'] === true) {
    const eligible = !(await isSystemTerminal(appId)) && await holdsEmbedGrant(appId) && await sessionExists(sessionId);
    return jsonResponse({ eligible });
  }
  if (!(await sessionExists(sessionId))) return jsonResponse({ error: 'session-gone', message: 'That Terminal session has ended.' }, 404);
  const refusal = await shareSession(appId, sessionId);
  if (refusal) return jsonResponse({ error: refusal }, refusal === 'bad-session-id' ? 400 : refusal === 'unavailable' ? 503 : 403);
  return jsonResponse({ ok: true, appId, sessionId });
};
