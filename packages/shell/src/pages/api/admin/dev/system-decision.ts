import type { APIRoute } from 'astro';
// Namespace import: the running shell may cache a core build without newer exports.
import * as core from '@aura/core';
import { notificationErrorResponse, readJson } from '../../../../lib/notificationCaller.js';
import { auditOwner, ownerAction, type OwnerActor } from '../../../../lib/approvals/admin.ts';
import { handleSystemDecision } from '../../../../lib/notifications/systemDecision.js';

/**
 * DEV ONLY — trigger an AuraOS system decision (phase-4 test hook; phase 6:
 * any payload, used by `aura admin dev system-decision`).
 *
 *   POST /api/admin/dev/system-decision
 *        { payload?: <notification input> }  or legacy { title?, text?, components?, priority? }
 *     → 201 { ok, notification, warnings }
 *
 * Creates a `type:'dialogue', scope:'system'` notification as the in-process
 * SYSTEM_CALLER — the only way a desktop-wide modal can exist. `type` and
 * `scope` are forced; the payload is validated by the normal schema. The
 * route answers 404 unless the shell runs the dev server
 * (`import.meta.env.DEV`), is the owner's (D50: the operator directly, an app
 * with the owner's approval of this exact payload), and every call is audited
 * (`dev.systemDecision`). Nothing else in the HTTP API can obtain system
 * identity: the request body never chooses the caller. Logic and tests:
 * lib/notifications/systemDecision.ts.
 */
export const POST: APIRoute = async (ctx) => handleSystemDecision(ctx.request, {
  dev: !!import.meta.env.DEV,
  actor: (input) => ownerAction(ctx, {
    action: 'admin.change', level: 'session', payload: { op: 'dev.system-decision', input },
    title: 'Show a test system decision (dev)', details: ['It blocks the whole desktop until answered.'],
  }),
  audit: (actor, action, entry) => auditOwner(actor as OwnerActor, action, entry as Parameters<typeof auditOwner>[2]),
  create: (input) => core.getNotificationService().create(input, core.SYSTEM_CALLER),
  readJson: (r) => readJson(r),
  errorResponse: (err) => notificationErrorResponse(err),
});
