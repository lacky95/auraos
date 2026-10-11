import type { APIRoute } from 'astro';
import { getAppManager } from '@aura/core';
import { jsonResponse, errorResponse } from '../../../lib/appResponse.js';

interface IntentBody {
  action?:   unknown;
  appId?:    unknown;
  category?: unknown;
  type?:     unknown;
  uri?:      unknown;
  extras?:   unknown;
}

/**
 * Resolve + start an intent. Body shape mirrors `Intent` from @aura/core
 * (action required; appId/category/type/uri/extras optional — `appId` makes
 * it an explicit intent that skips resolution). Returns either:
 *   { kind: 'started', appId, instanceId, activityId?, intentDelivered }
 *                                                         — single handler picked; the intent
 *                                                           went to onActivityCreate (multi) or
 *                                                           onIntent (everything else)
 *   { kind: 'disambiguation', candidates: [...] }         — shell should pick one
 *   { kind: 'noHandler' }                                 — 404 (or explicit appId not installed)
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
  };
  try {
    const result = await getAppManager().startIntent(intent);
    if (result.kind === 'noHandler') return errorResponse('No app handles this intent', 404);
    return jsonResponse(result);
  } catch (err) {
    return errorResponse(String(err), 500);
  }
};
