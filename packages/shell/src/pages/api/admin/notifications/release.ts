import type { APIRoute } from 'astro';
// Namespace import: the running shell may cache a core build without newer exports.
import * as core from '@aura/core';
import { errorResponse, jsonResponse } from '../../../../lib/appResponse.js';
import { notificationErrorResponse, readJson } from '../../../../lib/notificationCaller.js';
import { auditAdmin, requireAdmin } from '../../../../lib/auth.js';

/**
 * Admin escape hatch (phase 6): stop app desktop modals from blocking the
 * shell — `aura admin notif release <id>` / `--app <appId>`.
 *
 *   POST /api/admin/notifications/release   Authorization: Bearer <admin session>
 *        { id } → { released: [id] }      one modal
 *        { appId } → { released: [ids] }  every active modal of that app
 *
 * The items stay active as normal dialogues (scope auto, blocking off); the
 * sender sees history `updated` with reason `admin-released`. AuraOS's own
 * decisions are never released (409). Audited as `notifications.release`.
 */
export const POST: APIRoute = async ({ request }) => {
  const admin = await requireAdmin(request);
  if (admin instanceof Response) {
    await auditAdmin(null, 'notifications.release', { outcome: 'denied' });
    return admin;
  }
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const svc = core.getNotificationService();
  if (typeof (svc as { releaseDesktopModal?: unknown }).releaseDesktopModal !== 'function') return errorResponse('release is not available in the running core yet (restart pending)', 501);
  const actor = { kind: 'system' as const, verification: 'internal' as const, reason: 'admin-released' };
  try {
    if (typeof body['id'] === 'string' && body['id']) {
      const n = await svc.releaseDesktopModal(body['id'], 'admin-released', actor);
      await auditAdmin(admin, 'notifications.release', { target: n.id, outcome: 'ok' });
      return jsonResponse({ released: [n.id] });
    }
    if (typeof body['appId'] === 'string' && body['appId']) {
      const ids = await svc.releaseDesktopModalsOf(`app:${body['appId']}`, 'admin-released', actor);
      await auditAdmin(admin, 'notifications.release', { target: `app:${body['appId']}`, outcome: 'ok', detail: { released: ids.length } });
      return jsonResponse({ released: ids });
    }
    return errorResponse('give { id } or { appId }', 400);
  } catch (err) {
    await auditAdmin(admin, 'notifications.release', { outcome: 'failed', detail: { error: (err as Error).message } });
    return notificationErrorResponse(err);
  }
};
