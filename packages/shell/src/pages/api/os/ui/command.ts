import type { APIRoute } from 'astro';
import { uiCommandBroker } from '../../../../lib/uiCommandBroker';
import { jsonResponse, errorResponse } from '../../../../lib/appResponse.js';

/**
 * Run a command in the shell's browser UI and return its answer.
 *
 * Body `{ action, params?, timeoutMs? }`. 200 `{ ok, result }` when a tab
 * ran it; 504 `{ error: 'no-ui' | 'timeout' }` when no tab claimed it or
 * the claimant never answered; 500 `{ error: 'ui-error', message }` when
 * the handler threw — the message is the browser's own, relayed verbatim so
 * an agent reads "the browser refused fullscreen…" rather than a status.
 * Callers are trusted like the KV route's header-less 'system' callers.
 */
export const POST: APIRoute = async ({ request }) => {
  let body: { action?: unknown; params?: unknown; timeoutMs?: unknown };
  try { body = await request.json() as typeof body; }
  catch { return errorResponse('Invalid JSON', 400); }

  const { action, params, timeoutMs } = body;
  if (typeof action !== 'string' || !action) return errorResponse('action required', 400);
  if (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params))) {
    return errorResponse('params must be an object', 400);
  }
  const out = await uiCommandBroker.dispatch(
    action, params as Record<string, unknown> | undefined,
    { timeoutMs: typeof timeoutMs === 'number' ? timeoutMs : undefined },
  );
  if (out.ok) return jsonResponse({ ok: true, result: out.result });
  return jsonResponse({ error: out.error, message: out.message }, out.error === 'ui-error' ? 500 : 504);
};
