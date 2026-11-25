import type { NotificationCaller, CallerHints } from '@aura/core';
import { errorResponse, jsonResponse } from './appResponse.js';
import { authenticate } from './auth.js';

/**
 * Caller helpers for the notification API. The caller is `authenticate()`'s
 * principal as it is (lib/auth.ts, the one principal resolver); who may call
 * each route is the route access manifest's (routeManifest.ts,
 * notifications). Core notifications know each kind:
 *
 *   the owner (`user`: the desktop's login, or through a trusted UI, D45)
 *       reads everything; a screen it sends along (its client session,
 *       clientSession.ts `viewerFor`) keeps its lock view. Not a sender.
 *   an instance or API key: its own items, plus a notifications.read grant
 *   an admin session: reads everything, sends nothing
 *   anonymous: basic sending; a shell screen by its client session; a
 *       declared app id in a legacy body is attribution only
 *
 * `SYSTEM_CALLER` is unreachable from here by construction — it exists only
 * for in-process calls to `NotificationService`.
 */

const APP_ID_HINT = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)+$/;

/** The caller a notification route acts for, or the 401 of a credential that did not verify. */
export async function notificationCaller(request: Request): Promise<NotificationCaller | Response> {
  // The owner (`user`) is core notifications' OwnerCaller.
  return await authenticate(request) as NotificationCaller | Response;
}

/**
 * Add a self-declared app id (legacy `POST {appId, …}` body) as an
 * attribution hint — only to an anonymous caller without header hints, and
 * only if it looks like an app id. Never changes a verified caller.
 */
export function withDeclaredAppHint(caller: NotificationCaller, appId: unknown): NotificationCaller {
  if (caller.kind !== 'anonymous' || caller.hints?.appId) return caller;
  if (typeof appId !== 'string' || !APP_ID_HINT.test(appId)) return caller;
  const hints: CallerHints = { ...(caller.hints ?? {}), appId };
  return { ...caller, hints };
}

/** `X-Aura-Sender-Token` header (preferred) or a `senderToken` body field. */
export function senderTokenFrom(request: Request, body?: unknown): string | undefined {
  const h = request.headers.get('x-aura-sender-token')?.trim();
  if (h) return h;
  if (body && typeof body === 'object') {
    const t = (body as Record<string, unknown>)['senderToken'];
    if (typeof t === 'string' && t) return t;
  }
  return undefined;
}

/** Map a NotificationService error (has a numeric `status`) to a Response. */
export function notificationErrorResponse(err: unknown): Response {
  const status = (err as { status?: unknown })?.status;
  const message = err instanceof Error ? err.message : String(err);
  if (typeof status === 'number') {
    const details = (err as { details?: unknown }).details;
    return jsonResponse({ error: message, ...(details !== undefined ? { details } : {}) }, status);
  }
  console.error('[notifications] route failed:', err);
  return errorResponse(message, 500);
}

/** Parse a JSON body; empty body → `{}`; bad JSON → 400 Response. */
export async function readJson(request: Request): Promise<Record<string, unknown> | Response> {
  const raw = await request.text();
  if (!raw.trim()) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return errorResponse('Body must be a JSON object', 400);
    return v as Record<string, unknown>;
  } catch {
    return errorResponse('Invalid JSON', 400);
  }
}
