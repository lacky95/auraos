import type { APIRoute } from 'astro';
// Namespace import: the running shell may cache an older core build.
import * as core from '@aura/core';
import { errorResponse, jsonResponse } from '../../../../lib/appResponse.js';
import { readJson } from '../../../../lib/notificationCaller.js';

/**
 * Shell client sessions (phase 5) — the lock state of one shell screen
 * (today: one browser tab), so the notification API can redact for a
 * locked screen on the SERVER.
 *
 *   POST /api/os/clients   {lock?: 'locked'|'unlocked'}  → 201 {sid, lock, ttlMs, unlockRefused?}
 *   POST /api/os/clients/<sid>/lock | unlock | heartbeat {lock?} | end   (see [sid]/[action].ts)
 *
 * The sid is NOT a credential and grants nothing: it only selects the
 * redaction view of an otherwise anonymous caller. Unknown or expired
 * sessions read as LOCKED. Heartbeat at least every `ttlMs / 3`.
 *
 * Unlocking goes through core's `UnlockVerifier` hook; today it allows any
 * client-reported unlock — the lock screen has no PIN, so this is NOT an
 * authentication boundary (privacy against glances only).
 */
export const POST: APIRoute = async ({ request }) => {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const lock = body['lock'];
  if (lock !== undefined && lock !== 'locked' && lock !== 'unlocked') return errorResponse("lock must be 'locked' or 'unlocked'", 400);
  const store = (core.getAuthServices() as { clientSessions?: core.ClientSessionStore }).clientSessions;
  if (!store) return errorResponse('client sessions are not available in the running core yet', 503);
  try {
    const s = await store.register({ lock: (lock as 'locked' | 'unlocked' | undefined) ?? 'locked', ...(body['proof'] !== undefined ? { proof: body['proof'] } : {}) });
    return jsonResponse(s, 201);
  } catch (err) {
    return errorResponse(`client session: ${(err as Error).message}`, 500);
  }
};
