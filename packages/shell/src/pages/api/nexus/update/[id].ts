import type { APIRoute } from 'astro';
import { getNexusManager } from '@aura/core';
import { jsonResponse, errorResponse } from '../../../../lib/appResponse.js';

/**
 * Update an installed app to the latest version on its stored ref + channel.
 * Same protocol as /install: returns `{ ok, record }` on success or
 * `{ ok: false, needsApproval: true, diff }` when new permissions appear.
 */
export const POST: APIRoute = async ({ params, request }) => {
  const id = params['id'];
  if (!id) return errorResponse('missing app id', 400);
  const body = await request.json().catch(() => ({})) as { autoApprove?: boolean };

  const nexus = getNexusManager();
  if (!nexus.records.get(id)) {
    return errorResponse(`app '${id}' has no Nexus install record — cannot auto-update`, 404);
  }

  const it = nexus.update(id, { autoApprove: body.autoApprove });
  try {
    let cursor = await it.next();
    while (!cursor.done) {
      const ev = cursor.value;
      if (ev.type === 'permission.needed') {
        await it.return(undefined as never).catch(() => undefined);
        return jsonResponse({ ok: false, needsApproval: true, diff: ev.diff });
      }
      if (ev.type === 'error') {
        return errorResponse(ev.message, 500);
      }
      if (ev.type === 'install.done') {
        return jsonResponse({ ok: true, record: ev.record });
      }
      cursor = await it.next();
    }
    return jsonResponse({ ok: true, record: cursor.value });
  } catch (err) {
    return errorResponse((err as Error).message, 500);
  }
};
