import type { APIRoute } from 'astro';
import { getNexusManager } from '@aura/core';
import { jsonResponse, errorResponse } from '../../../lib/appResponse.js';

/**
 * Install an app from a Nexus ref (git URL, OCI ref, index slug, or local path).
 *
 * POST body:
 *   { ref: string, autoApprove?: boolean }
 *
 * Returns one of:
 *   { ok: true, record: InstallRecord }
 *   { ok: false, needsApproval: true, diff: PermissionDiff }
 *   { ok: false, error: string }
 *
 * When `needsApproval: true` is returned, the client (CLI or Nexus GUI app)
 * shows the diff and re-POSTs with `autoApprove: true`.
 */
export const POST: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => ({})) as {
    ref?:         string;
    autoApprove?: boolean;
  };
  if (!body.ref || typeof body.ref !== 'string') {
    return errorResponse('missing or invalid `ref`', 400);
  }

  const nexus = getNexusManager();
  const it = nexus.install({ ref: body.ref, autoApprove: body.autoApprove });

  try {
    let cursor = await it.next();
    while (!cursor.done) {
      const ev = cursor.value;
      if (ev.type === 'permission.needed') {
        // Caller didn't pass autoApprove; surface the diff so they can
        // re-POST with autoApprove: true. Abort the in-flight install
        // (returning from the API closes the iterator before it touches
        // disk; the staging dir is cleaned up by the finally block in
        // NexusManager.install).
        await it.return(undefined as never).catch(() => undefined);
        return jsonResponse({ ok: false, needsApproval: true, diff: ev.diff });
      }
      if (ev.type === 'error') {
        return errorResponse(ev.message, 500);
      }
      // For v1 we just drain progress events without streaming them; the
      // CLI/GUI can poll or add SSE later. The terminal step (`install.done`)
      // carries the InstallRecord we want to return.
      if (ev.type === 'install.done') {
        return jsonResponse({ ok: true, record: ev.record });
      }
      cursor = await it.next();
    }
    // Iterator finished without an install.done — shouldn't happen but
    // surface the return value defensively.
    return jsonResponse({ ok: true, record: cursor.value });
  } catch (err) {
    return errorResponse((err as Error).message, 500);
  }
};
