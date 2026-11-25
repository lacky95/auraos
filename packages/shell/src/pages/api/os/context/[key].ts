import type { APIRoute } from 'astro';
import { ContextStore } from '@aura/core';
import { jsonResponse, errorResponse } from '../../../../lib/appResponse.js';
import { contextGate } from '../../../../lib/approvals/context.ts';

/**
 * DELETE /api/os/context/<KEY> — remove a context value (Valkey + file).
 * Needs a fresh owner approval of `{op: 'delete', key}`, as ../context.ts.
 */

const KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

export const DELETE: APIRoute = async ({ params, request }) => {
  const key = params['key'];
  if (!key || !KEY_PATTERN.test(key)) {
    return errorResponse(`invalid key '${key ?? ''}'`, 422);
  }
  const refused = await contextGate(request, { op: 'delete', key });
  if (refused) return refused;
  try {
    const removed = await new ContextStore().del(key);
    return jsonResponse({ removed });
  } catch (err) {
    return errorResponse((err as Error).message, 500);
  }
};
