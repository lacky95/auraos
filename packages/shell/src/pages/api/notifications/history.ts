import type { APIRoute } from 'astro';
// Namespace import, as in the other notification routes.
import * as core from '@aura/core';
import { errorResponse, jsonResponse } from '../../../lib/appResponse.js';
import { notificationErrorResponse } from '../../../lib/notificationCaller.js';
import { authenticate } from '../../../lib/auth.js';
import { viewerFor } from '../../../lib/clientSession.js';

/**
 * Notification HISTORY (phase 5) — ended (resolved / removed) items.
 *
 *   DELETE /api/notifications/history[?sender=<senderKey>]  → { deleted }
 *            "Clear history now": deletes ended items and their history at
 *            once (otherwise the retention period does it, default 7 days).
 *            Active notifications are never touched. A user op: needs an
 *            UNLOCKED shell client session (403 when locked / missing); an
 *            app / API key only deletes its own history.
 */
export const DELETE: APIRoute = async ({ request, url }) => {
  const principal = await authenticate(request);
  if (principal instanceof Response) return principal;
  const svc = core.getNotificationService() as unknown as { clearHistory?: (f: { sender?: string }, v: unknown) => Promise<{ deleted: number }> };
  if (typeof svc.clearHistory !== 'function') return errorResponse('clear history is not available in the running core yet', 501);
  try {
    const sender = url.searchParams.get('sender') ?? undefined;
    return jsonResponse(await svc.clearHistory(sender ? { sender } : {}, await viewerFor(request, principal, { url })));
  } catch (err) {
    return notificationErrorResponse(err);
  }
};
