import type { APIRoute } from 'astro';
// Namespace import: the running shell may cache a core build without newer exports.
import * as core from '@aura/core';
import { jsonResponse } from '../../../../lib/appResponse.js';
import { notificationErrorResponse, readJson } from '../../../../lib/notificationCaller.js';
import { auditAdmin, requireAdmin } from '../../../../lib/auth.js';

/**
 * DEV ONLY — trigger an AuraOS desktop decision (phase-4 test hook).
 *
 *   POST /api/admin/dev/system-decision
 *        Authorization: Bearer <admin session>   (aura admin login)
 *        { title?, text?, components?, priority? }
 *     → 201 { ok, notification, warnings }
 *
 * Creates a `type:'dialogue', scope:'desktop'` notification as the in-process
 * SYSTEM_CALLER — the only way a desktop-wide modal can exist. The route
 * answers 404 unless the shell runs the dev server (`import.meta.env.DEV`;
 * a production build compiles the handler body away), needs an admin
 * session, and every call is audited (`dev.systemDecision`). Nothing else
 * in the HTTP API can obtain system identity: the request body never
 * chooses the caller.
 */
const DEFAULT_COMPONENTS = [
  { kind: 'button', id: 'allow', label: 'Allow', variant: 'primary', action: 'resolve' },
  { kind: 'button', id: 'deny', label: 'Deny', variant: 'secondary', action: 'resolve' },
];

export const POST: APIRoute = async ({ request }) => {
  if (!import.meta.env.DEV) return jsonResponse({ error: 'not found' }, 404);
  const admin = await requireAdmin(request);
  if (admin instanceof Response) {
    await auditAdmin(null, 'dev.systemDecision', { outcome: 'denied' });
    return admin;
  }
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const input = {
    type: 'dialogue',
    scope: 'desktop',
    title: typeof body['title'] === 'string' ? body['title'] : 'AuraOS needs a decision (dev test)',
    text: typeof body['text'] === 'string' ? body['text'] : 'This is a development test of a desktop-wide system decision.',
    priority: typeof body['priority'] === 'string' ? body['priority'] : 'high',
    components: Array.isArray(body['components']) ? body['components'] : DEFAULT_COMPONENTS,
  };
  try {
    const result = await core.getNotificationService().create(input, core.SYSTEM_CALLER);
    await auditAdmin(admin, 'dev.systemDecision', { target: result.notification.id, outcome: 'ok', detail: { title: input.title } });
    return jsonResponse({ ok: true, ...result }, 201);
  } catch (err) {
    await auditAdmin(admin, 'dev.systemDecision', { outcome: 'failed', detail: { error: (err as Error).message } });
    return notificationErrorResponse(err);
  }
};
