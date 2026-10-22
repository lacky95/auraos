import type { APIRoute } from 'astro';
// Namespace import: the running shell may cache a core build without newer exports.
import * as core from '@aura/core';
import { notificationErrorResponse, readJson } from '../../../../lib/notificationCaller.js';
import { auditAdmin, requireAdmin } from '../../../../lib/auth.js';
import { handleSystemDecision } from '../../../../lib/notifications/systemDecision.js';

/**
 * DEV ONLY — trigger an AuraOS desktop decision (phase-4 test hook; phase 6:
 * any payload, used by `aura admin dev system-decision`).
 *
 *   POST /api/admin/dev/system-decision
 *        Authorization: Bearer <admin session>   (aura admin login)
 *        { payload?: <notification input> }  or legacy { title?, text?, components?, priority? }
 *     → 201 { ok, notification, warnings }
 *
 * Creates a `type:'dialogue', scope:'desktop'` notification as the in-process
 * SYSTEM_CALLER — the only way a desktop-wide modal can exist. `type` and
 * `scope` are forced; the payload is validated by the normal schema. The
 * route answers 404 unless the shell runs the dev server
 * (`import.meta.env.DEV`), needs an admin session, and every call is audited
 * (`dev.systemDecision`). Nothing else in the HTTP API can obtain system
 * identity: the request body never chooses the caller. Logic and tests:
 * lib/notifications/systemDecision.ts.
 */
export const POST: APIRoute = async ({ request }) => handleSystemDecision(request, {
  dev: !!import.meta.env.DEV,
  requireAdmin: (r) => requireAdmin(r),
  audit: (admin, action, entry) => auditAdmin(admin as Parameters<typeof auditAdmin>[0], action, entry as Parameters<typeof auditAdmin>[2]),
  create: (input) => core.getNotificationService().create(input, core.SYSTEM_CALLER),
  readJson: (r) => readJson(r),
  errorResponse: (err) => notificationErrorResponse(err),
});
