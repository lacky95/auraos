import type { APIRoute } from 'astro';
import { ContextStore, normaliseInject } from '@aura/core';
import { jsonResponse, errorResponse } from '../../../lib/appResponse.js';

/**
 * Aura Context API — OS-wide env vars / secrets ("Context Manager").
 *
 *   GET  /api/os/context           → { entries: [{ key, updatedAt }] }  (NO values)
 *   POST /api/os/context           → body { key, value } upserts; returns { key, updatedAt }
 *
 * Values are sealed at rest in the KV and materialised to /data/context/system/<KEY>
 * (mounted into every app container at /run/context). Values are NEVER returned
 * over this API — the UI shows a "set" indicator, not the secret.
 *
 * Delete lives in ./context/[key].ts.
 */

const KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

export const GET: APIRoute = async () => {
  try {
    const entries = await new ContextStore().list();
    return jsonResponse({ entries });
  } catch (err) {
    return errorResponse((err as Error).message, 500);
  }
};

export const POST: APIRoute = async ({ request }) => {
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
  const inject = normaliseInject(body.inject);
  try {
    const entry = await new ContextStore().set(body.key, body.value, kind, inject);
    return jsonResponse(entry);
  } catch (err) {
    return errorResponse((err as Error).message, 500);
  }
};

export const PUT = POST;
