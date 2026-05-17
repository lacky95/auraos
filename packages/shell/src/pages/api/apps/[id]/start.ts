import type { APIRoute } from 'astro';
import { getAppManager, OsEventBus } from '@aura/core';
import { defaultKv } from '@aura/kv-store';
import { buildInstanceDTO, jsonResponse, errorResponse } from '../../../../lib/appResponse.js';

/**
 * Update the MRU stamp for `appId` after a successful start. Best-effort:
 * a KV write failure here is logged and swallowed because it would be
 * absurd to fail the launch over a dock-ordering nicety. Emits a
 * `app:mruChanged` event so the dock can re-sort its tiles live without
 * a refetch round-trip.
 */
async function bumpMru(appId: string): Promise<void> {
  try {
    const kv = defaultKv();
    try {
      const map = (await kv.getValue<Record<string, number>>('os', 'app-mru')) ?? {};
      map[appId] = Date.now();
      await kv.set('os', 'app-mru', map);
      // Topic the sioPlugin already relays — see astro.config.mjs EVENT_TYPES.
      OsEventBus.emit('app:mruChanged', { appId, at: map[appId] });
    } finally {
      await kv.close().catch(() => undefined);
    }
  } catch (err) {
    console.warn(`[apps/start] mru bump failed for ${appId}: ${(err as Error).message}`);
  }
}

export const POST: APIRoute = async ({ params }) => {
  const appId = params['id'];
  if (!appId) return errorResponse('Missing app id', 400);

  const mgr = getAppManager();
  if (!mgr.getManifest(appId)) return errorResponse(`App not found: ${appId}`, 404);

  try {
    const instanceId = await mgr.start(appId);
    const dto = await buildInstanceDTO(instanceId);
    // Record AFTER start succeeds so a failed launch doesn't pollute the
    // dock with a missed app. Fire-and-forget — don't block the response
    // on the KV round-trip.
    void bumpMru(appId);
    return jsonResponse({ instanceId, appId, ...dto });
  } catch (err) {
    return errorResponse(String(err), 500);
  }
};
