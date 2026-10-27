import type { AppManager, NotificationCaller, CallerHints } from '@aura/core';
import { identifyInstance } from '../pages/api/interfaces/identify.js';
import { errorResponse, jsonResponse } from './appResponse.js';

/**
 * Server-established caller identity for the notification API — the
 * instance-token / hints part. Phase 2: routes call `authenticate()` in
 * `lib/auth.ts`, which handles API keys (`aura_k1_…`) and admin sessions
 * (`aura-admin1.…`) first and delegates everything else here.
 *
 *   valid   `Authorization: Bearer $AURA_INSTANCE_TOKEN`
 *             → { kind:'instance', appId, instanceId, sidecar?, verification:'verified' }
 *             (appId from the live instance record, never from the request)
 *   invalid / expired Bearer, or any other Authorization scheme
 *             → 401. Never downgraded to anonymous.
 *   Referer `/api/proxy/<id>/` or `X-Aura-Instance-Id`, no credentials
 *             → { kind:'anonymous', verification:'unverified', hints:{appId, instanceId} }
 *             Hints are attribution only; they NEVER authenticate.
 *   nothing → { kind:'anonymous', verification:'unverified' }
 *
 * `SYSTEM_CALLER` is unreachable from here by construction — it exists only
 * for in-process calls to `NotificationService`.
 */

/** The slice of AppManager this needs (structural, so it can be faked in tests). */
export type CallerAuthManager = Pick<AppManager, 'tokens' | 'getInstance' | 'getInstancesByApp'>;

const APP_ID_HINT = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)+$/;

export function authenticateCaller(request: Request, mgr: CallerAuthManager): NotificationCaller | Response {
  const header = request.headers.get('authorization');
  if (header !== null && header.trim() !== '') {
    const token = /^Bearer\s+(\S+)\s*$/i.exec(header)?.[1];
    if (!token) {
      return errorResponse('unsupported Authorization header — send Authorization: Bearer $AURA_INSTANCE_TOKEN (or an API key / admin session), or no Authorization at all', 401);
    }
    const claims = mgr.tokens.verify(token);
    if (!claims) return errorResponse('invalid or expired credential (instance token, API key or admin session)', 401);
    const inst = mgr.getInstance(claims.instanceId);
    if (!inst) return errorResponse(`token belongs to ${claims.instanceId}, which is not running`, 401);
    return {
      kind: 'instance',
      appId: inst.appId,
      instanceId: inst.instanceId,
      ...(claims.sidecar ? { sidecar: claims.sidecar } : {}),
      verification: 'verified',
    };
  }

  const inst = identifyInstance(request, mgr as AppManager);
  if (inst) {
    return { kind: 'anonymous', verification: 'unverified', hints: { appId: inst.appId, instanceId: inst.instanceId } };
  }
  return { kind: 'anonymous', verification: 'unverified' };
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
