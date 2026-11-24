import type { APIRoute } from 'astro';
import { getAppManager, removeInstalledApp } from '@aura/core';
import { defaultKv } from '@aura/kv-store';
import { jsonResponse, errorResponse } from '../../../../lib/appResponse.js';

/**
 * Delete an installed app through the core lifecycle (`removeInstalledApp`):
 * it stops every instance, deletes the app from its scope with path checks,
 * and retires its App Hosts. This route validates the id and tidies the
 * per-app enable-state entry in KV so it doesn't accumulate as apps churn.
 *
 * This is "Delete app data" (D20): the app's data, trash copies and kept
 * data go too, and its App Host labels are tombstoned. The CLI and the
 * Settings UI both confirm with that wording before calling here.
 */

const APP_ID_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;

export const POST: APIRoute = async ({ params }) => deleteApp(params['id']);
// DELETE method too — the CLI's `aura app remove` historically used it.
export const DELETE: APIRoute = async ({ params }) => deleteApp(params['id']);

async function deleteApp(appId: string | undefined): Promise<Response> {
  if (!appId) return errorResponse('Missing app id', 400);
  if (!APP_ID_RE.test(appId)) {
    return errorResponse(`Invalid app id: ${appId}. Expected reverse-domain notation.`, 400);
  }

  const mgr = getAppManager();
  if (!mgr.getManifest(appId)) {
    return errorResponse(`App not installed: ${appId}`, 404);
  }

  let result: { removed: boolean; dest: string };
  try {
    result = await removeInstalledApp(appId);
  } catch (err) {
    return errorResponse(`Could not delete ${appId}: ${(err as Error).message}`, 500);
  }
  if (!result.removed) {
    return jsonResponse({ ok: true, appId, removed: false, message: `${result.dest} did not exist on disk; registry will reconcile.` });
  }

  // KV cleanup — drop this app's entry from the enable map so the persisted
  // state matches what AppManager will see on next boot (registry no longer
  // has the app, so the map should drop it too).
  try {
    const kv = defaultKv();
    try {
      const map = (await kv.getValue<Record<string, boolean>>('os', 'app-enabled')) ?? {};
      if (appId in map) {
        delete map[appId];
        await kv.set('os', 'app-enabled', map);
      }
    } finally {
      await kv.close().catch(() => undefined);
    }
  } catch (err) {
    console.warn(`[apps/remove] KV cleanup failed: ${(err as Error).message}`);
  }

  return jsonResponse({ ok: true, appId, removed: true, dest: result.dest });
}
