import type { APIRoute } from 'astro';
// Namespace import: the running shell may cache a core build without newer exports.
import * as core from '@aura/core';
import { errorResponse, jsonResponse } from '../../../../lib/appResponse.js';
import { notificationErrorResponse, readJson } from '../../../../lib/notificationCaller.js';
import { auditOwner, ownerAction } from '../../../../lib/approvals/admin.ts';

/**
 * The owner's escape hatch (phase 6): stop app system modals from blocking
 * the shell — `aura admin notif release <id>` / `--app <appId>`. From an app
 * it needs the owner's approval (D50, lib/approvals/admin.ts).
 *
 *   POST /api/admin/notifications/release
 *        { id } → { released: [id] }      one modal
 *        { appId } → { released: [ids] }  every active modal of that app
 *
 * The items stay active as normal dialogues (scope auto, blocking off); the
 * sender sees history `updated` with reason `admin-released`. AuraOS's own
 * decisions are never released (409). Audited as `notifications.release`.
 */
export const POST: APIRoute = async (ctx) => {
  const body = await readJson(ctx.request);
  if (body instanceof Response) return body;
  const target: { id: string } | { appId: string } | null = typeof body['id'] === 'string' && body['id'] ? { id: body['id'] }
    : typeof body['appId'] === 'string' && body['appId'] ? { appId: body['appId'] } : null;
  if (!target) return errorResponse('give { id } or { appId }', 400);
  const admin = await ownerAction(ctx, {
    action: 'admin.change', level: 'session', payload: { op: 'notifications.release', ...target },
    title: 'id' in target ? `Release the system modal ${target.id}` : `Release every system modal of ${target.appId}`,
    details: ['The dialogs stay as normal ones; they stop blocking the desktop.'],
  });
  if (admin instanceof Response) return admin;
  const svc = core.getNotificationService();
  if (typeof (svc as { releaseSystemModal?: unknown }).releaseSystemModal !== 'function') return errorResponse('release is not available in the running core yet (restart pending)', 501);
  const actor = { kind: 'system' as const, verification: 'internal' as const, reason: 'admin-released' };
  try {
    if ('id' in target) {
      const n = await svc.releaseSystemModal(target.id, 'admin-released', actor);
      await auditOwner(admin, 'notifications.release', { target: n.id, outcome: 'ok' });
      return jsonResponse({ released: [n.id] });
    }
    const ids = await svc.releaseSystemModalsOf(`app:${target.appId}`, 'admin-released', actor);
    await auditOwner(admin, 'notifications.release', { target: `app:${target.appId}`, outcome: 'ok', detail: { released: ids.length } });
    return jsonResponse({ released: ids });
  } catch (err) {
    await auditOwner(admin, 'notifications.release', { outcome: 'failed', detail: { error: (err as Error).message } });
    return notificationErrorResponse(err);
  }
};
