import type { APIRoute } from 'astro';
// Namespace import: the running shell may cache a core build without the
// notification exports; a named import would 500 the route until restart.
import * as core from '@aura/core';
import { jsonResponse } from '../../../lib/appResponse.js';
import {
  notificationErrorResponse, readJson, withDeclaredAppHint,
} from '../../../lib/notificationCaller.js';
import { authenticate } from '../../../lib/auth.js';
import { viewerFor } from '../../../lib/clientSession.js';

/**
 * Notifications collection.
 *
 *   GET    ?state=active|resolved|removed|all &sender=<senderKey> &priority= &limit= &cursor=
 *            → { items: Notification[], nextCursor? }
 *            Read access (phase 5): a verified app / API key sees its own items
 *            plus what an admin granted (`notifications.read`, scoped); a shell
 *            screen (`X-Aura-Client-Session`) sees everything in the view of
 *            its lock state (locked/unknown: public without components,
 *            private redacted, secret left out); anonymous WITHOUT a client
 *            session sees nothing; admin sessions see all.
 *   POST   CreateInput → 201 { ok, notification, senderToken?, warnings[] }
 *            Caller identity is established server-side (lib/notificationCaller.ts):
 *            Bearer $AURA_INSTANCE_TOKEN / API key → verified; invalid → 401;
 *            sending needs `system.notifications` (403); locked / popup need an
 *            admin grant, else downgraded with warnings[]; 429 over the rate limit.
 *            Referer / X-Aura-Instance-Id → unverified hints only.
 *            Legacy `{appId, title, body}` → a Simple notification; `appId` is an
 *            unverified attribution hint, never an identity.
 *   DELETE ?sender= &priority= → { cleared, skippedLocked } (user op: clear; skips locked)
 *            Needs an UNLOCKED client session (403 when locked / missing);
 *            an app / key clears only its own.
 *
 * Phase 5: the legacy content-carrying `OsEventBus 'notification'` broadcast
 * is gone. Live delivery is `notification:*` (content-free) + the SSE stream.
 */
export const GET: APIRoute = async ({ url, request }) => {
  const viewer = await authenticate(request);
  if (viewer instanceof Response) return viewer;
  try {
    const { cs: _cs, ...q } = Object.fromEntries(url.searchParams.entries());
    return jsonResponse(await core.getNotificationService().list(q, await viewerFor(request, viewer, { url })));
  } catch (err) {
    return notificationErrorResponse(err);
  }
};

export const POST: APIRoute = async ({ request }) => {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const authed = await authenticate(request);
  if (authed instanceof Response) return authed;

  // Legacy shape {appId, title, body}: `body` → text; appId → hint only.
  const { appId: declaredAppId, body: legacyBody, ...rest } = body;
  const input: Record<string, unknown> = { ...rest };
  if (input['text'] === undefined && typeof legacyBody === 'string') input['text'] = legacyBody;
  const caller = authed.kind === 'anonymous' ? withDeclaredAppHint(authed, declaredAppId) : authed;

  try {
    const result = await core.getNotificationService().create(input, caller);
    const warnings = [...result.warnings];
    if (authed.kind === 'instance' && typeof declaredAppId === 'string' && declaredAppId !== authed.appId) {
      warnings.push({ code: 'ignored-field', field: 'appId', message: `appId is taken from the instance token (${authed.appId})` });
    }
    return jsonResponse({ ok: true, ...result, warnings }, 201);
  } catch (err) {
    return notificationErrorResponse(err);
  }
};

export const DELETE: APIRoute = async ({ url, request }) => {
  const principal = await authenticate(request);
  if (principal instanceof Response) return principal;
  try {
    const filter: Record<string, string> = {};
    for (const k of ['sender', 'priority']) {
      const v = url.searchParams.get(k);
      if (v) filter[k] = v;
    }
    return jsonResponse(await core.getNotificationService().clear(filter, undefined, await viewerFor(request, principal, { url })));
  } catch (err) {
    return notificationErrorResponse(err);
  }
};
