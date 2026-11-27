import type { APIRoute } from 'astro';
import { getAppManager, removeInstalledApp } from '@aura/core';
import { jsonResponse, errorResponse } from '../../../../lib/appResponse.js';
import { nexusFailure } from '../../../../lib/nexusErrors.ts';
import { deleteHomeRefusal, deleteHomesAfterRemove, installationBeforeRemove } from '../../../../lib/homesAdmin.ts';

/**
 * Delete an installed app through the core lifecycle (`removeInstalledApp`):
 * it stops every instance, deletes the app from its scope with path checks,
 * and retires its App Hosts. This route validates the id and tidies the
 * per-app enable-state entry in KV so it doesn't accumulate as apps churn.
 *
 * This is "Delete app data" (D20): the app's data, trash copies and kept
 * data go too, and its App Host labels are tombstoned. The CLI and the
 * Settings UI both confirm with that wording before calling here.
 *
 * A built-in system app is refused (409, D1): its code is the AuraOS repo's
 * and its data stays. Disabling it is the way to switch it off.
 */

const APP_ID_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;

export const POST: APIRoute = async ({ params, url, request, locals }) => deleteApp(params['id'], url.searchParams.get('deleteHome') === '1', { request, locals });
// DELETE method too — the CLI's `aura app remove` historically used it.
export const DELETE: APIRoute = async ({ params, url, request, locals }) => deleteApp(params['id'], url.searchParams.get('deleteHome') === '1', { request, locals });

/**
 * `?deleteHome=1` also deletes the installation's App Homes (D65 §13: an
 * explicit choice; by default they are kept). A Private Home is never touched.
 */
async function deleteApp(appId: string | undefined, deleteHome: boolean, reader: { request: Request; locals?: App.Locals }): Promise<Response> {
  if (!appId) return errorResponse('Missing app id', 400);
  if (!APP_ID_RE.test(appId)) {
    return errorResponse(`Invalid app id: ${appId}. Expected reverse-domain notation.`, 400);
  }

  const mgr = getAppManager();
  if (!mgr.getManifest(appId)) {
    return errorResponse(`App not installed: ${appId}`, 404);
  }

  const home = deleteHome ? await installationBeforeRemove(appId) : null;
  if (home && 'error' in home) return errorResponse(deleteHomeRefusal(appId, home.error), 409);
  let result: { removed: boolean; dest: string };
  let homeDeleted = false;
  try {
    result = await removeInstalledApp(appId);
    if (home) homeDeleted = await deleteHomesAfterRemove(appId, home.installationId);
  } catch (err) {
    // D105 Pass B (review row 29): 409 system-app with `aura disable app`; anything else for its reader.
    return nexusFailure(reader, err);
  }
  if (!result.removed) {
    return jsonResponse({ ok: true, appId, removed: false, homeDeleted, message: `${result.dest} did not exist on disk; registry will reconcile.` });
  }

  // The kernel drops the app from its persisted enable map (AppManager owns `os/app-enabled`).
  try { await mgr.forgetEnabledState(appId); }
  catch (err) { console.warn(`[apps/remove] enable map cleanup failed: ${(err as Error).message}`); }

  return jsonResponse({ ok: true, appId, removed: true, dest: result.dest, homeDeleted });
}
