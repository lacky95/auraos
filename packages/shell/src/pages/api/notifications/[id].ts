import type { APIRoute } from 'astro';
import * as core from '@aura/core';
import { errorResponse, jsonResponse } from '../../../lib/appResponse.js';
import {
  notificationErrorResponse, readJson, senderTokenFrom,
} from '../../../lib/notificationCaller.js';
import { authenticate } from '../../../lib/auth.js';
import { viewerFor } from '../../../lib/clientSession.js';

/**
 * One notification.
 *
 *   GET    → Notification | 404
 *            Phase 5 read access (see index.ts): own items, granted readers,
 *            shell screens in their lock-screen view (secret → 404 while
 *            locked); anonymous without a client session → 404. A matching
 *            `X-Aura-Sender-Token` reads the sender's own item in full.
 *   GET    ?waitFor=resolved&timeout=<s ≤ 25, default 20>
 *            Long-poll: answers as soon as the notification leaves `active`
 *            (resolved / removed), or after `timeout` with the still-active
 *            item. Header `X-Aura-Wait: done | timeout`. Same scoping.
 *   GET    ?waitFor=interaction[&after=<ms>]&timeout=<s>
 *            Phase 6: also answers on the next user interaction
 *            (`lastInteraction.at > after`; `after` defaults to the current
 *            `lastInteraction.at`). Pass the `at` you saw last to never miss one.
 *            Header `X-Aura-Wait-Reason: interaction | resolved | removed | timeout`.
 *   PATCH  UpdatePatch → { notification, warnings[] }        (sender op)
 *            Allowed for the same verified app (Bearer $AURA_INSTANCE_TOKEN), or
 *            with the senderToken from create: header `X-Aura-Sender-Token`
 *            (or a `senderToken` body field). Otherwise 403.
 *   DELETE → Notification (removed, reason `dismissed`)      (user op)
 *            Locked notifications → 409 (use POST …/force-remove).
 *            Needs read access; a locked screen → 403 (unlock first).
 */
const MAX_WAIT_S = 25;
const DEFAULT_WAIT_S = 20;

export const GET: APIRoute = async ({ params, request, url }) => {
  const principal = await authenticate(request);
  if (principal instanceof Response) return principal;
  const viewer = await viewerFor(request, principal, { url, senderToken: senderTokenFrom(request) });
  const id = params['id'] ?? '';
  const waitFor = url.searchParams.get('waitFor');
  try {
    if (waitFor !== null) {
      if (waitFor !== 'resolved' && waitFor !== 'interaction') {
        return errorResponse("waitFor must be 'resolved' (until resolved or removed) or 'interaction' (also on the next button click / input submit)", 400);
      }
      const raw = url.searchParams.get('timeout');
      const t = raw === null || raw === '' ? DEFAULT_WAIT_S : Number(raw);
      if (!Number.isFinite(t) || t < 0) return errorResponse('timeout must be a number of seconds (0–25)', 400);
      const rawAfter = url.searchParams.get('after');
      const after = rawAfter === null || rawAfter === '' ? undefined : Number(rawAfter);
      if (after !== undefined && (!Number.isFinite(after) || after < 0)) return errorResponse('after must be a timestamp in ms (lastInteraction.at)', 400);
      if (after !== undefined && waitFor !== 'interaction') return errorResponse("after only applies to waitFor=interaction", 400);
      const svc = core.getNotificationService();
      if (waitFor === 'interaction' && ((svc as { version?: number }).version ?? 0) < 8) {
        return errorResponse('waitFor=interaction needs notification service v8 (an aura-shell restart is pending)', 501);
      }
      const r = await svc.waitFor(id, viewer, {
        timeoutMs: Math.min(t, MAX_WAIT_S) * 1000,
        until: waitFor,
        ...(after !== undefined ? { after } : {}),
      });
      if (!r) return errorResponse(`notification not found: ${id}`, 404);
      const res = jsonResponse(r.notification);
      res.headers.set('X-Aura-Wait', r.timedOut ? 'timeout' : 'done');
      res.headers.set('X-Aura-Wait-Reason', r.reason ?? (r.timedOut ? 'timeout' : r.notification.state === 'resolved' ? 'resolved' : 'removed'));
      return res;
    }
    const n = await core.getNotificationService().get(id, viewer);
    return n ? jsonResponse(n) : errorResponse(`notification not found: ${params['id']}`, 404);
  } catch (err) {
    return notificationErrorResponse(err);
  }
};

export const PATCH: APIRoute = async ({ params, request }) => {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const caller = await authenticate(request);
  if (caller instanceof Response) return caller;
  const token = senderTokenFrom(request, body);
  const { senderToken: _t, ...patch } = body;
  try {
    return jsonResponse(await core.getNotificationService().update(params['id'] ?? '', patch, caller, token));
  } catch (err) {
    return notificationErrorResponse(err);
  }
};

export const DELETE: APIRoute = async ({ params, request, url }) => {
  const principal = await authenticate(request);
  if (principal instanceof Response) return principal;
  try {
    return jsonResponse(await core.getNotificationService().dismiss(params['id'] ?? '', undefined, await viewerFor(request, principal, { url })));
  } catch (err) {
    return notificationErrorResponse(err);
  }
};
