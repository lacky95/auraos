import type { APIRoute } from 'astro';
import { VolumeStore } from '@aura/core';
import { jsonResponse, errorResponse } from '../../../lib/appResponse.js';

/**
 * Aura Context Volumes API — OS-managed shared volumes ("Volumes" tab).
 *
 *   GET  /api/os/volumes   → { volumes: [{ name, mountPath, mode, createdAt }] }
 *   POST /api/os/volumes   → body { name, mountPath, mode? } creates; returns the entry
 *
 * Phase 1: every volume is mounted into every app container at `mountPath`.
 * Delete lives in ./volumes/[name].ts.
 */

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export const GET: APIRoute = async () => {
  try {
    const volumes = await new VolumeStore().list();
    return jsonResponse({ volumes });
  } catch (err) {
    return errorResponse((err as Error).message, 500);
  }
};

export const POST: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => null) as
    { name?: unknown; mountPath?: unknown; mode?: unknown } | null;
  if (!body || typeof body.name !== 'string' || typeof body.mountPath !== 'string') {
    return errorResponse('body must be { name: string, mountPath: string, mode?: "rw" | "ro" }', 400);
  }
  if (!NAME_PATTERN.test(body.name)) {
    return errorResponse(`invalid volume name '${body.name}' — lowercase letters/digits/-/_ (max 63)`, 422);
  }
  const mode = body.mode === 'ro' ? 'ro' : body.mode === undefined || body.mode === 'rw' ? 'rw' : null;
  if (mode === null) {
    return errorResponse(`invalid mode '${String(body.mode)}' — must be "rw" or "ro"`, 422);
  }
  try {
    const entry = await new VolumeStore().create(body.name, body.mountPath, mode);
    return jsonResponse(entry);
  } catch (err) {
    // Validation errors (bad/reserved/duplicate mountPath) → 422; others → 500.
    const msg = (err as Error).message;
    const status = /mountPath|reserved|already used|absolute|trailing|segments/i.test(msg) ? 422 : 500;
    return errorResponse(msg, status);
  }
};
