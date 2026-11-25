import type { APIRoute } from 'astro';
import { ContextStore } from '@aura/core';
import { jsonResponse, errorResponse } from '../../../../lib/appResponse.js';
import { contextGate } from '../../../../lib/approvals/context.ts';
import { liveContextReadDeps, readContext } from '../../../../lib/appContract.ts';
import { countContractSignal } from '../../../../lib/access/contractSignals.ts';

/**
 * GET /api/os/context/<KEY> — `osClient.context.get` (D48): the value of a key
 * the calling app declares in its manifest `context[]`, to its own server
 * (instance token) only. `{key, value}`, 404 `not-set`, 403
 * `context-undeclared` (counted in the access report). lib/appContract.ts.
 *
 * DELETE /api/os/context/<KEY> — remove a context value (Valkey + file).
 * Needs a fresh owner approval of `{op: 'delete', key}`, as ../context.ts.
 */
export const GET: APIRoute = ({ params, request }) =>
  readContext(request, params['key'], liveContextReadDeps(new ContextStore(), countContractSignal));

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
