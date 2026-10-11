import type { APIRoute } from 'astro';
import { getAppManager, IntentError } from '@aura/core';
import { jsonResponse, errorResponse } from '../../../lib/appResponse.js';

interface IntentBody {
  action?:   unknown;
  appId?:    unknown;
  category?: unknown;
  type?:     unknown;
  uri?:      unknown;
  extras?:   unknown;
  instanceId?: unknown;
  flags?:    unknown;
}

/**
 * Resolve + start an intent. Body shape mirrors `Intent` from @aura/core
 * (action required; appId/category/type/uri/extras/instanceId/flags optional —
 * `appId` makes it an explicit intent that skips resolution, `instanceId`
 * targets one running instance, `flags: ['NEW_INSTANCE']` asks for a fresh
 * one). Returns either:
 *   { kind: 'started', appId, instanceId, activityId?, intentDelivered, result? }
 *                                                         — single handler picked; the intent
 *                                                           went to onActivityCreate (multi) or
 *                                                           onIntent (everything else). No
 *                                                           activityId = handled window-less;
 *                                                           `result` = what the handler returned
 *   { kind: 'rejected', appId, instanceId, code, message, hint? }
 *                                                         — the handler declined it (4xx, its status)
 *   { kind: 'disambiguation', candidates: [...] }         — shell should pick one
 *   { kind: 'noHandler' }                                 — 404 (or explicit appId not installed)
 * A malformed intent (unknown flag, bad instanceId, …) answers 4xx
 * `{ kind: 'error', code, error, hint? }`.
 */
export const POST: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => null) as IntentBody | null;
  if (!body || typeof body.action !== 'string' || body.action.length === 0) {
    return errorResponse('Intent body must include a string `action`', 400);
  }
  const intent = {
    action: body.action,
    ...(typeof body.appId === 'string' && body.appId.length > 0 ? { appId: body.appId } : {}),
    ...(Array.isArray(body.category) ? { category: body.category.filter((c): c is string => typeof c === 'string') } : {}),
    ...(typeof body.type === 'string' ? { type: body.type } : {}),
    ...(typeof body.uri  === 'string' ? { uri:  body.uri  } : {}),
    ...(body.extras && typeof body.extras === 'object' && !Array.isArray(body.extras) ? { extras: body.extras as Record<string, unknown> } : {}),
    ...(typeof body.instanceId === 'string' && body.instanceId.length > 0 ? { instanceId: body.instanceId } : {}),
    ...(Array.isArray(body.flags) ? { flags: body.flags.filter((f): f is string => typeof f === 'string') } : {}),
  };
  if (body.instanceId !== undefined && typeof body.instanceId !== 'string') {
    return errorResponse('`instanceId` must be a string', 400);
  }
  if (body.flags !== undefined && !Array.isArray(body.flags)) {
    return errorResponse('`flags` must be an array of strings', 400);
  }
  try {
    const result = await getAppManager().startIntent(intent);
    if (result.kind === 'noHandler') return errorResponse('No app handles this intent', 404);
    if (result.kind === 'rejected') return jsonResponse({ ...result, error: result.message }, result.status);
    return jsonResponse(result);
  } catch (err) {
    if (err instanceof IntentError) {
      return jsonResponse({ kind: 'error', code: err.code, error: err.message, ...(err.hint ? { hint: err.hint } : {}) }, err.status);
    }
    return errorResponse(String(err), 500);
  }
};
