import type { APIRoute } from 'astro';
import { ContextStore } from '@aura/core';
import { jsonResponse, errorResponse, failureResponse } from '../../../lib/appResponse.js';
import { contextGate } from '../../../lib/approvals/context.ts';
import { contextWrite } from '../../../lib/approvals/display.ts';

/**
 * Aura Context API — OS-wide env vars / secrets ("Context Manager").
 *
 *   GET  /api/os/context           → { entries: [{ key, updatedAt }] }  (NO values)
 *   POST /api/os/context           → body { key, value } upserts; returns { key, updatedAt }
 *
 * Values are sealed at rest in the KV; `file` entries are materialised to
 * /data/context/system/<KEY> for the AuraOS shells only (/run/context in the
 * master). An app gets a key only when it declares it and holds the owner's
 * grant (Phase 5 stream C). Values are NEVER returned over this API — the UI
 * shows a "set" indicator, not the secret.
 *
 * Delete lives in ./context/[key].ts.
 *
 * Every write needs a fresh owner approval of exactly that key, kind and
 * injection (lib/approvals/context.ts): ask with POST /api/approvals
 * `{action: 'os.context.write', payload: {op: 'set', key, kind, inject}}`, then
 * send the write with `X-Aura-Approval: <id>`. Without one: 202 needs-approval.
 */

const KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

export const GET: APIRoute = async ({ request, locals }) => {
  try {
    const entries = await new ContextStore().list();
    return jsonResponse({ entries });
  } catch (err) {
    return failureResponse({ request, locals }, err);
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  const body = await request.json().catch(() => null) as
    { key?: unknown; value?: unknown; kind?: unknown; inject?: unknown } | null;
  if (!body || typeof body.key !== 'string' || typeof body.value !== 'string') {
    return errorResponse('body must be { key: string, value: string, kind?: "secret" | "variable", inject?: ("env"|"file")[] }', 400);
  }
  if (!KEY_PATTERN.test(body.key)) {
    return errorResponse(`invalid key '${body.key}' — must be an env-var name (${KEY_PATTERN.source})`, 422);
  }
  const kind = body.kind === 'variable' ? 'variable' : body.kind === undefined || body.kind === 'secret' ? 'secret' : null;
  if (kind === null) {
    return errorResponse(`invalid kind '${String(body.kind)}' — must be "secret" or "variable"`, 422);
  }
  // An explicit but empty inject array means "inject nowhere": sealed in the
  // KV, handed to no app. This used to be rejected as a likely mistake, but it
  // is the only safe shape for an OS-level credential — both targets are
  // broadcast (`env` at every app spawn, `file` via /run/context in every app
  // container), so without it a token the OS needs would also reach every
  // installed app. `normaliseInject` preserves an empty array; a non-array
  // still defaults to both, so existing entries are unaffected.
  const write = contextWrite({ op: 'set', key: body.key, kind, inject: body.inject });
  if (write?.op !== 'set') return errorResponse('invalid request', 400);
  const refused = await contextGate(request, write);
  if (refused) return refused;
  try {
    const entry = await new ContextStore().set(write.key, body.value, write.kind, write.inject);
    return jsonResponse(entry);
  } catch (err) {
    return failureResponse({ request, locals }, err);
  }
};

export const PUT = POST;
