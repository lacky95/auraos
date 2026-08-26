import type { APIRoute } from 'astro';
import { ContextStore } from '@aura/core';
import { jsonResponse, errorResponse } from '../../../../lib/appResponse.js';

/** DELETE /api/os/context/<KEY> — remove a context value (Valkey + file). */

const KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

export const DELETE: APIRoute = async ({ params }) => {
  const key = params['key'];
  if (!key || !KEY_PATTERN.test(key)) {
    return errorResponse(`invalid key '${key ?? ''}'`, 422);
  }
  try {
    const removed = await new ContextStore().del(key);
    return jsonResponse({ removed });
  } catch (err) {
    return errorResponse((err as Error).message, 500);
  }
};
