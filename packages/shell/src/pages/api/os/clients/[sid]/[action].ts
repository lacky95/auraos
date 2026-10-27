import type { APIRoute } from 'astro';
import * as core from '@aura/core';
import { errorResponse, jsonResponse } from '../../../../../lib/appResponse.js';
import { readJson } from '../../../../../lib/notificationCaller.js';

/**
 * One shell client session (phase 5) — see ../index.ts.
 *
 *   POST …/<sid>/lock                       → {sid, lock:'locked', ttlMs}
 *   POST …/<sid>/unlock      {proof?}       → {sid, lock, ttlMs, unlockRefused?}
 *   POST …/<sid>/heartbeat   {lock?, proof?} → keeps it alive; with `lock`, re-syncs the state
 *   POST …/<sid>/end                        → {ended}
 *
 * 404 `{error:'unknown-client-session'}` when the sid is unknown, invalid
 * or expired: the client registers a new one (and is treated as locked
 * until then).
 */
export const POST: APIRoute = async ({ params, request }) => {
  const sid = params['sid'] ?? '';
  const action = params['action'] ?? '';
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const store = (core.getAuthServices() as { clientSessions?: core.ClientSessionStore }).clientSessions;
  if (!store) return errorResponse('client sessions are not available in the running core yet', 503);
  const proof = body['proof'];
  let s: Awaited<ReturnType<core.ClientSessionStore['heartbeat']>>;
  switch (action) {
    case 'lock':
      s = await store.lock(sid);
      break;
    case 'unlock':
      s = await store.unlock(sid, proof);
      break;
    case 'heartbeat': {
      const lock = body['lock'];
      if (lock !== undefined && lock !== 'locked' && lock !== 'unlocked') return errorResponse("lock must be 'locked' or 'unlocked'", 400);
      s = await store.heartbeat(sid, { ...(lock ? { lock: lock as 'locked' | 'unlocked' } : {}), ...(proof !== undefined ? { proof } : {}) });
      break;
    }
    case 'end':
      return jsonResponse({ ended: await store.end(sid) });
    default:
      return errorResponse(`unknown action '${action}' — use lock | unlock | heartbeat | end`, 404);
  }
  if (!s) return jsonResponse({ error: 'unknown-client-session', message: 'unknown or expired client session — register a new one (POST /api/os/clients)' }, 404);
  return jsonResponse(s);
};
