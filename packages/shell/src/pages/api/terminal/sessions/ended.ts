import type { APIRoute } from 'astro';
import * as core from '@aura/core';
import { jsonResponse } from '../../../../lib/appResponse.js';
import { verifiedAppCaller } from '../../../../lib/terminalCaller.ts';
import { forgetSessionGrants, isSystemTerminal, terminalSessionInstance } from '../../../../../server/terminal-embed.mjs';

/**
 * POST ?id=<session id>: the System Terminal reports that a session ended
 * (root `exit`) or was killed, so every app's grant of it goes and a new
 * session under the same name starts with none. Only the instance that holds
 * the session may say so, with its instance token.
 */
export const POST: APIRoute = async ({ request, url }) => {
  const id = url.searchParams.get('id');
  const instanceId = terminalSessionInstance(id);
  if (!id || !instanceId) return jsonResponse({ error: 'bad-session-id' }, 400);
  const caller = await verifiedAppCaller(request);
  if (!caller || caller === 'invalid' || caller.instanceId !== instanceId || !(await isSystemTerminal(caller.appId))) {
    return jsonResponse({ error: 'terminal-only' }, 403);
  }
  try {
    return jsonResponse({ id, dropped: await forgetSessionGrants(id) });
  } catch (err) {
    return jsonResponse({ error: 'unavailable', message: (err as Error).message }, 503);
  }
};
