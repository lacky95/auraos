import type { APIRoute } from 'astro';
import * as core from '@aura/core';
import { errorResponse, jsonResponse } from '../../../../lib/appResponse.js';
import {
  notificationErrorResponse, readJson, senderTokenFrom,
} from '../../../../lib/notificationCaller.js';
import { authenticate } from '../../../../lib/auth.js';
import { viewerFor } from '../../../../lib/clientSession.js';

/**
 * Lifecycle actions on one notification — all `POST`, all return the
 * updated Notification.
 *
 *   displayed     user op   first display (idempotent)
 *   seen          user op   the user saw it (idempotent; implies displayed)
 *   resolve       user op   body `{answer?}` → state `resolved`
 *   interact      user op   body `{componentId, value?, values?}` — a button
 *                           without action, an input submit or an options
 *                           choice. Stays active; stored as `lastInteraction`,
 *                           published as event `interacted` (phase 3).
 *   force-remove  user op   removes even locked ones (reason `force-removed`)
 *   force-hide    user op   phase 6: an APP desktop modal stops blocking — it
 *                           stays an active, normal dialogue (scope auto,
 *                           blocking off); the sender sees history `updated`
 *                           with reason `force-hidden`. AuraOS decisions → 409.
 *   remove        sender op the sender is done (e.g. task complete; reason
 *                           `completed`). Same verified app, or senderToken
 *                           (`X-Aura-Sender-Token` / body `senderToken`).
 *
 * User ops are recorded as `actor {kind:'user', verification:'unverified'}`
 * (no user login yet). Phase 5: they need read access to the item (a shell
 * client session, or the owning app / key); anonymous without a session →
 * 404. A LOCKED screen may only mark displayed / seen — resolve, interact
 * and force-remove answer 403 "unlock first". The reply is the caller's
 * view of the item. `remove` needs `system.notifications` and ownership.
 */
export const POST: APIRoute = async ({ params, request, url }) => {
  const id = params['id'] ?? '';
  const action = params['action'] ?? '';
  const svc = core.getNotificationService();
  const principal = await authenticate(request);
  if (principal instanceof Response) return principal;
  const viewer = action === 'remove' ? undefined : await viewerFor(request, principal, { url });
  try {
    switch (action) {
      case 'displayed':
        return jsonResponse(await svc.markDisplayed(id, undefined, viewer));
      case 'seen':
        return jsonResponse(await svc.markSeen(id, undefined, viewer));
      case 'resolve': {
        const body = await readJson(request);
        if (body instanceof Response) return body;
        return jsonResponse(await svc.resolve(id, body['answer'], undefined, viewer));
      }
      case 'interact': {
        const body = await readJson(request);
        if (body instanceof Response) return body;
        // Older core copy (before a reload) has no interact(): say so instead of 500.
        if (typeof (svc as { interact?: unknown }).interact !== 'function') {
          return errorResponse('interact is not available in the running core yet', 501);
        }
        return jsonResponse(await svc.interact(id, body, undefined, viewer));
      }
      case 'force-remove':
        return jsonResponse(await svc.forceRemove(id, undefined, viewer));
      case 'force-hide':
        if (typeof (svc as { releaseDesktopModal?: unknown }).releaseDesktopModal !== 'function') {
          return errorResponse('force-hide is not available in the running core yet (restart pending)', 501);
        }
        return jsonResponse(await svc.releaseDesktopModal(id, 'force-hidden', undefined, viewer));
      case 'remove': {
        const body = await readJson(request);
        if (body instanceof Response) return body;
        return jsonResponse(await svc.removeBySender(id, principal, senderTokenFrom(request, body)));
      }
      default:
        return errorResponse(`unknown action '${action}' — use displayed | seen | resolve | interact | force-remove | force-hide | remove`, 404);
    }
  } catch (err) {
    return notificationErrorResponse(err);
  }
};
